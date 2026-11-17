import { isIP } from "node:net";

export const HTTP_URL_MESSAGE = "Must be an http or https URL";

/**
 * For a zod `.url().refine(...)` chain: fails only for a parseable URL that
 * is not http or https, so an unparseable value yields the single `.url()`
 * issue rather than two.
 */
export function isHttpUrlWhenParseable(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return true;
  }
}

const PRIVATE_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home.arpa",
];

/**
 * A cheap, synchronous screen for URLs that are stored now and fetched later
 * by code without the `public-http` guard (for example custom watchlist
 * career pages): http or https, no credentials, and a dotted public-looking
 * host name, never an IP literal or a local name. It does not resolve DNS, so
 * it is not a substitute for `fetchPublicUrl` where the response is read back.
 */
export function isPublicLookingHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (!host || isIP(host) !== 0) return false;
  if (host === "localhost" || !host.includes(".")) return false;
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return false;
  }
  // Purely numeric labels ("127.1", "2130706433") are IP shorthands.
  return !/^[0-9.]+$/.test(host) && !/^0x[0-9a-f]+$/.test(host);
}
