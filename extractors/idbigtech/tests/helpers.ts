import { vi } from "vitest";

export function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as Response;
}

export function htmlResponse(html: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError("not JSON");
    },
    text: async () => html,
  } as Response;
}

export interface RecordedRequest {
  url: URL;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

type Route = (request: RecordedRequest) => Response | Promise<Response>;

/**
 * Fake fetch routed by `host + pathname` prefix (longest match wins). Records
 * every request; an unrouted request fails the test.
 */
export function routedFetch(routes: Record<string, Route>) {
  const requests: RecordedRequest[] = [];
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const request: RecordedRequest = {
        url,
        method: init?.method ?? "GET",
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        headers: (init?.headers ?? {}) as Record<string, string>,
      };
      requests.push(request);
      const key = keys.find((prefix) =>
        `${url.host}${url.pathname}`.startsWith(prefix),
      );
      if (!key) throw new Error(`unexpected request ${url.toString()}`);
      return routes[key](request);
    },
  );
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests };
}

export const noSleep = vi.fn().mockResolvedValue(undefined);

/** Run options shared by tests: no pauses, recorded fetch. */
export function testOptions(fetchImpl: typeof fetch) {
  return { fetchImpl, sleep: noSleep, delayMs: 0 };
}
