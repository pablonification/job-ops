/**
 * Fetching a user- or agent-supplied URL without reaching the server's own
 * network (SSRF protection).
 *
 * - Only http and https, without credentials in the URL.
 * - The host is resolved first and every address must be public: loopback,
 *   private, carrier-grade NAT, link-local (including cloud metadata),
 *   unique-local, multicast, reserved and unspecified addresses are refused,
 *   for IPv4 and IPv6, including IPv4 embedded in IPv6 (mapped, NAT64, 6to4).
 * - The connection goes to the checked address (not a second DNS lookup), so
 *   DNS rebinding cannot swap in a private address.
 * - Redirects are followed manually, re-checking every hop, up to a limit.
 * - The body is read up to a byte cap (after decompression) and cut there.
 *
 * Tests inject `resolve` and `transport`; production always uses the
 * defaults, there is no switch that turns the checks off.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { AppError, requestTimeout } from "./errors";

export type ResolvedAddress = { address: string; family: 4 | 6 };

export type PublicHttpResolver = (
  hostname: string,
) => Promise<ResolvedAddress[]>;

/** Sends one GET to `address` for `url` (Host header and TLS name from the URL). */
export type PublicHttpTransport = (request: {
  url: URL;
  address: ResolvedAddress;
  headers: Record<string, string>;
  signal: AbortSignal;
}) => Promise<IncomingMessage>;

export type PublicHttpDeps = {
  resolve?: PublicHttpResolver;
  transport?: PublicHttpTransport;
};

export type PublicHttpOptions = {
  headers?: Record<string, string>;
  /** Maximum decoded body bytes kept; the rest is not read. */
  maxBytes: number;
  maxRedirects?: number;
  timeoutMs: number;
};

export type PublicHttpResponse = {
  status: number;
  headers: IncomingMessage["headers"];
  body: Buffer;
  /** The body was longer than `maxBytes` and was cut. */
  truncated: boolean;
  /** URL of the final response after redirects. */
  url: string;
};

const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export const NON_PUBLIC_ADDRESS_MESSAGE =
  "This URL points to a private, local or reserved network address. Only public web pages can be fetched.";

function refuse(message: string): AppError {
  return new AppError({
    status: 422,
    code: "UNPROCESSABLE_ENTITY",
    message,
  });
}

function upstream(message: string): AppError {
  return new AppError({ status: 502, code: "UPSTREAM_ERROR", message });
}

// --- Address classification -------------------------------------------------

/** [network, prefix length] pairs of non-public IPv4 ranges. */
const BLOCKED_IPV4_RANGES: ReadonlyArray<[string, number]> = [
  ["0.0.0.0", 8], // "this network", includes 0.0.0.0 (unspecified)
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata (169.254.169.254)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, includes 255.255.255.255 (broadcast)
];

function ipv4ToNumber(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

const BLOCKED_IPV4_NUMERIC = BLOCKED_IPV4_RANGES.map(([network, prefix]) => {
  const size = 2 ** (32 - prefix);
  const start = ipv4ToNumber(network) ?? 0;
  return { start, end: start + size - 1 };
});

function isPublicIpv4Number(value: number): boolean {
  return !BLOCKED_IPV4_NUMERIC.some(
    (range) => value >= range.start && value <= range.end,
  );
}

/** Eight 16-bit groups, or null when the text is not an IPv6 address. */
function parseIpv6(raw: string): number[] | null {
  let address = raw.toLowerCase().replace(/^\[|\]$/g, "");
  const zoneIndex = address.indexOf("%");
  if (zoneIndex >= 0) address = address.slice(0, zoneIndex);

  const lastColon = address.lastIndexOf(":");
  const tail = address.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = ipv4ToNumber(tail);
    if (v4 === null) return null;
    address = `${address.slice(0, lastColon + 1)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }

  const halves = address.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string) =>
    part === "" ? [] : part.split(":").map((group) => group);
  const head = toGroups(halves[0] ?? "");
  const rest = halves.length === 2 ? toGroups(halves[1] ?? "") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(Math.max(missing, 0)).fill("0"), ...rest];
  const values = groups.map((group) =>
    /^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN,
  );
  return values.some(Number.isNaN) ? null : values;
}

function isPublicIpv6(groups: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] =
    groups;
  const embeddedV4 = g6 * 65536 + g7;
  const firstFiveZero =
    g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;

  // ::/96 covers :: (unspecified), ::1 (loopback) and the deprecated
  // IPv4-compatible form; ::ffff:0:0/96 is IPv4-mapped.
  if (firstFiveZero && g5 === 0) {
    if (g6 === 0) return false;
    return isPublicIpv4Number(embeddedV4);
  }
  if (firstFiveZero && g5 === 0xffff) return isPublicIpv4Number(embeddedV4);
  // 64:ff9b::/96 NAT64 carries an IPv4 address; 64:ff9b:1::/48 is local-use.
  if (g0 === 0x64 && g1 === 0xff9b) {
    if (g2 !== 0) return false;
    if (g3 === 0 && g4 === 0 && g5 === 0) {
      return isPublicIpv4Number(embeddedV4);
    }
    return false;
  }
  // 2002::/16 (6to4) carries an IPv4 address in groups 1-2.
  if (g0 === 0x2002) return isPublicIpv4Number(g1 * 65536 + g2);
  if ((g0 & 0xfe00) === 0xfc00) return false; // unique-local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return false; // site-local fec0::/10
  if ((g0 & 0xff00) === 0xff00) return false; // multicast ff00::/8
  if (g0 === 0x2001 && g1 === 0) return false; // Teredo 2001::/32
  if (g0 === 0x2001 && g1 === 0xdb8) return false; // documentation
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return false; // discard
  return true;
}

/** True only for a syntactically valid, publicly routable IP address. */
export function isPublicIpAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "");
  const family = isIP(bare.split("%")[0] ?? "");
  if (family === 4) {
    const value = ipv4ToNumber(bare);
    return value !== null && isPublicIpv4Number(value);
  }
  if (family === 6) {
    const groups = parseIpv6(bare);
    return groups !== null && isPublicIpv6(groups);
  }
  return false;
}

// --- Defaults -----------------------------------------------------------------

const defaultResolve: PublicHttpResolver = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({
    address: record.address,
    family: record.family === 6 ? 6 : 4,
  }));
};

const defaultTransport: PublicHttpTransport = ({
  url,
  address,
  headers,
  signal,
}) =>
  new Promise((resolve, reject) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const options: https.RequestOptions = {
      protocol: url.protocol,
      // Connect to the checked address; Host and TLS name stay the URL's.
      host: address.address,
      family: address.family,
      port: url.port ? Number(url.port) : undefined,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { ...headers, Host: url.host },
      agent: false,
      signal,
      ...(url.protocol === "https:" && isIP(hostname) === 0
        ? { servername: hostname }
        : {}),
    };
    const request =
      url.protocol === "https:"
        ? https.request(options, resolve)
        : http.request(options, resolve);
    request.on("error", reject);
    request.end();
  });

// --- Fetch --------------------------------------------------------------------

async function resolvePublicAddress(
  url: URL,
  resolve: PublicHttpResolver,
): Promise<ResolvedAddress> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw refuse("Only http and https URLs can be fetched.");
  }
  if (url.username || url.password) {
    throw refuse("URLs with a user name or password cannot be fetched.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    if (!isPublicIpAddress(hostname)) throw refuse(NON_PUBLIC_ADDRESS_MESSAGE);
    return { address: hostname, family: literalFamily === 6 ? 6 : 4 };
  }

  let addresses: ResolvedAddress[];
  try {
    addresses = await resolve(hostname);
  } catch {
    throw upstream("Couldn't find this website. Check the URL.");
  }
  if (addresses.length === 0) {
    throw upstream("Couldn't find this website. Check the URL.");
  }
  // Every record must be public: a host with any private record is refused.
  if (addresses.some((entry) => !isPublicIpAddress(entry.address))) {
    throw refuse(NON_PUBLIC_ADDRESS_MESSAGE);
  }
  return addresses[0] as ResolvedAddress;
}

function decodeBody(response: IncomingMessage): Readable {
  const encoding = String(response.headers["content-encoding"] ?? "")
    .trim()
    .toLowerCase();
  const decoder =
    encoding === "gzip" || encoding === "x-gzip"
      ? createGunzip()
      : encoding === "deflate"
        ? createInflate()
        : encoding === "br"
          ? createBrotliDecompress()
          : null;
  if (!decoder) return response;
  response.on("error", (error) => decoder.destroy(error));
  return response.pipe(decoder);
}

async function readCapped(
  response: IncomingMessage,
  maxBytes: number,
): Promise<{ body: Buffer; truncated: boolean }> {
  const stream = decodeBody(response);
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (total + buffer.length > maxBytes) {
        chunks.push(buffer.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(buffer);
      total += buffer.length;
    }
  } finally {
    stream.destroy();
    response.destroy();
  }
  return { body: Buffer.concat(chunks, total), truncated };
}

/**
 * GETs a public URL with the protections described at the top of this file.
 * Non-2xx responses are returned (not thrown) so callers can word their own
 * message. Throws 422 for a refused URL or address, 408 on timeout and 502
 * when the site cannot be reached or redirects too often.
 */
export async function fetchPublicUrl(
  rawUrl: string,
  options: PublicHttpOptions,
  deps: PublicHttpDeps = {},
): Promise<PublicHttpResponse> {
  const resolve = deps.resolve ?? defaultResolve;
  const transport = deps.transport ?? defaultTransport;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw refuse("This is not a valid URL.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    for (let hop = 0; ; hop += 1) {
      const address = await resolvePublicAddress(url, resolve);
      if (controller.signal.aborted) throw requestTimeout();

      let response: IncomingMessage;
      try {
        response = await transport({
          url,
          address,
          headers: options.headers ?? {},
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) throw requestTimeout();
        if (error instanceof AppError) throw error;
        throw upstream("Couldn't reach this website.");
      }

      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (REDIRECT_STATUSES.has(status) && location) {
        response.destroy();
        if (hop >= maxRedirects) {
          throw upstream("This page redirects too many times.");
        }
        try {
          url = new URL(location, url);
        } catch {
          throw upstream("This page redirects to an invalid URL.");
        }
        continue;
      }

      try {
        const { body, truncated } = await readCapped(
          response,
          options.maxBytes,
        );
        return {
          status,
          headers: response.headers,
          body,
          truncated,
          url: url.toString(),
        };
      } catch {
        if (controller.signal.aborted) throw requestTimeout();
        throw upstream("Couldn't read the response from this website.");
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}
