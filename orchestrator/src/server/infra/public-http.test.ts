import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchPublicUrl,
  isPublicIpAddress,
  type PublicHttpDeps,
  type PublicHttpResolver,
  type PublicHttpTransport,
} from "./public-http";

const PUBLIC_IP = "93.184.215.14";

describe("isPublicIpAddress", () => {
  it.each([
    "127.0.0.1",
    "127.10.20.30",
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.10",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "[::1]",
    "fe80::1",
    "fe80::1%eth0",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::ffff:a9fe:a9fe",
    "::127.0.0.1",
    "64:ff9b::a00:1",
    "64:ff9b:1::1",
    "2002:a00:1::1",
    "2001::1",
    "not-an-ip",
    "999.1.1.1",
  ])("refuses %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each([
    PUBLIC_IP,
    "8.8.8.8",
    "172.32.0.1",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "2002:808:808::1",
  ])("allows %s", (address) => {
    expect(isPublicIpAddress(address)).toBe(true);
  });
});

describe("fetchPublicUrl", () => {
  let server: Server;
  let port: number;
  let handler: (req: IncomingMessage, res: ServerResponse) => void;
  let transportCalls: string[];

  const resolve: PublicHttpResolver = async (hostname) => {
    if (hostname === "jobs.example.test") {
      return [{ address: PUBLIC_IP, family: 4 }];
    }
    if (hostname === "intranet.example.test") {
      return [{ address: "10.0.0.5", family: 4 }];
    }
    if (hostname === "mixed.example.test") {
      return [
        { address: PUBLIC_IP, family: 4 },
        { address: "::1", family: 6 },
      ];
    }
    if (hostname === "mapped.example.test") {
      return [{ address: "::ffff:192.168.0.1", family: 6 }];
    }
    throw new Error(`ENOTFOUND ${hostname}`);
  };

  // Sends the request to the local test server whatever address was checked,
  // so redirects and body handling run without leaving the machine.
  const transport: PublicHttpTransport = ({ url, address, headers, signal }) =>
    new Promise((resolveResponse, reject) => {
      transportCalls.push(`${address.address} ${url.pathname}`);
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: `${url.pathname}${url.search}`,
          headers: { ...headers, Host: url.host },
          signal,
        },
        resolveResponse,
      );
      req.on("error", reject);
      req.end();
    });

  const deps: PublicHttpDeps = { resolve, transport };
  const options = { timeoutMs: 2000, maxBytes: 64 * 1024 };

  beforeEach(async () => {
    transportCalls = [];
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<p>ok</p>");
    };
    server = createServer((req, res) => handler(req, res));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    port = typeof address === "object" && address ? address.port : 0;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });

  async function expectRefused(url: string, code = "UNPROCESSABLE_ENTITY") {
    await expect(fetchPublicUrl(url, options, deps)).rejects.toMatchObject({
      code,
    });
  }

  it("fetches a public page", async () => {
    const response = await fetchPublicUrl(
      "http://jobs.example.test/careers/1?ref=a",
      options,
      deps,
    );
    expect(response).toMatchObject({
      status: 200,
      truncated: false,
      url: "http://jobs.example.test/careers/1?ref=a",
    });
    expect(response.body.toString()).toBe("<p>ok</p>");
    expect(transportCalls).toEqual([`${PUBLIC_IP} /careers/1`]);
  });

  it("refuses loopback, private, IPv6 loopback and mapped addresses", async () => {
    await expectRefused(`http://127.0.0.1:${port}/`);
    await expectRefused(
      "http://localhost.example.test.invalid/",
      "UPSTREAM_ERROR",
    );
    await expectRefused("http://10.0.0.8/");
    await expectRefused("http://192.168.1.1/admin");
    await expectRefused("http://169.254.169.254/latest/meta-data/");
    await expectRefused("http://[::1]/");
    await expectRefused("http://[::ffff:127.0.0.1]/");
    await expectRefused("http://0x7f.1/");
    await expectRefused("http://intranet.example.test/");
    await expectRefused("http://mixed.example.test/");
    await expectRefused("http://mapped.example.test/");
    expect(transportCalls).toEqual([]);
  });

  it("refuses non-http schemes and credentials", async () => {
    await expectRefused("file:///etc/passwd");
    await expectRefused("ftp://jobs.example.test/file");
    await expectRefused("gopher://jobs.example.test/");
    await expectRefused("http://user:pass@jobs.example.test/");
    await expectRefused("not a url");
    expect(transportCalls).toEqual([]);
  });

  it("follows redirects and re-checks every hop", async () => {
    handler = (req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { Location: "/final" });
        res.end();
        return;
      }
      if (req.url === "/to-private") {
        res.writeHead(301, { Location: "http://intranet.example.test/x" });
        res.end();
        return;
      }
      if (req.url === "/to-loopback") {
        res.writeHead(307, { Location: "http://127.0.0.1/" });
        res.end();
        return;
      }
      if (req.url === "/to-file") {
        res.writeHead(302, { Location: "file:///etc/passwd" });
        res.end();
        return;
      }
      if (req.url === "/loop") {
        res.writeHead(302, { Location: "/loop" });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end("final page");
    };

    const followed = await fetchPublicUrl(
      "http://jobs.example.test/start",
      options,
      deps,
    );
    expect(followed.body.toString()).toBe("final page");
    expect(followed.url).toBe("http://jobs.example.test/final");

    transportCalls = [];
    await expectRefused("http://jobs.example.test/to-private");
    expect(transportCalls).toEqual([`${PUBLIC_IP} /to-private`]);
    await expectRefused("http://jobs.example.test/to-loopback");
    await expectRefused("http://jobs.example.test/to-file");

    transportCalls = [];
    await expect(
      fetchPublicUrl(
        "http://jobs.example.test/loop",
        { ...options, maxRedirects: 3 },
        deps,
      ),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(transportCalls).toHaveLength(4);
  });

  it("stops reading an oversized body at the byte cap", async () => {
    const chunk = Buffer.alloc(64 * 1024, "a");
    let written = 0;
    handler = (_req, res) => {
      res.writeHead(200);
      // Up to 8 MB, written as the client reads.
      const writeMore = () => {
        while (written < 8 * 1024 * 1024) {
          written += chunk.length;
          if (!res.write(chunk)) {
            res.once("drain", writeMore);
            return;
          }
        }
        res.end();
      };
      res.on("close", () => {
        written = Number.POSITIVE_INFINITY;
      });
      writeMore();
    };

    const response = await fetchPublicUrl(
      "http://jobs.example.test/huge",
      { ...options, maxBytes: 100_000 },
      deps,
    );
    expect(response.truncated).toBe(true);
    expect(response.body.length).toBe(100_000);
  });

  it("caps the decompressed size of a compressed body", async () => {
    const page = Buffer.alloc(2 * 1024 * 1024, "b");
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Encoding": "gzip" });
      res.end(gzipSync(page));
    };
    const response = await fetchPublicUrl(
      "http://jobs.example.test/zipped",
      { ...options, maxBytes: 50_000 },
      deps,
    );
    expect(response.truncated).toBe(true);
    expect(response.body.length).toBe(50_000);
    expect(response.body.toString()).toBe("b".repeat(50_000));

    handler = (_req, res) => {
      res.writeHead(200, { "Content-Encoding": "gzip" });
      res.end(gzipSync(Buffer.from("small page")));
    };
    const small = await fetchPublicUrl(
      "http://jobs.example.test/small",
      options,
      deps,
    );
    expect(small).toMatchObject({ truncated: false });
    expect(small.body.toString()).toBe("small page");
  });

  it("returns non-2xx responses and times out slow sites", async () => {
    handler = (_req, res) => {
      res.writeHead(404);
      res.end("missing");
    };
    const missing = await fetchPublicUrl(
      "http://jobs.example.test/gone",
      options,
      deps,
    );
    expect(missing.status).toBe(404);

    handler = () => {
      // Never answers.
    };
    await expect(
      fetchPublicUrl(
        "http://jobs.example.test/slow",
        { ...options, timeoutMs: 100 },
        deps,
      ),
    ).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
  });

  it("passes the bare hostname to the resolver", async () => {
    const injected = vi.fn(resolve);
    await fetchPublicUrl("http://jobs.example.test/", options, {
      resolve: injected,
      transport,
    });
    expect(injected).toHaveBeenCalledWith("jobs.example.test");
  });
});
