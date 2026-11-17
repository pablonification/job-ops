export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export const DEFAULT_POLITE_DELAY_MS = 1_500;
const DEFAULT_TIMEOUT_MS = 20_000;
/** Largest response body read; Blibli's 200-job page is about 1.3 MB. */
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Thrown instead of sending a request once the run's time budget is spent. */
export class TimeBudgetExceededError extends Error {
  constructor(label: string) {
    super(`${label} time budget exceeded`);
    this.name = "TimeBudgetExceededError";
  }
}

export interface PoliteJsonClientOptions {
  /** Human-readable source name used in sanitised error messages. */
  label: string;
  fetchImpl?: typeof fetch;
  /** Pause before every request except the first one. */
  delayMs?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  sleep?: (ms: number) => Promise<void>;
  /** Epoch ms after which no request is started. */
  deadline?: number;
  now?: () => number;
  /** Responses larger than this fail instead of being read whole. */
  maxResponseBytes?: number;
}

/** Per-request options; both are optional. */
export interface PoliteRequestOptions {
  /** Extra headers for this request only (e.g. a site-specific header). */
  headers?: Record<string, string>;
  /** Name used in this request's error messages instead of the client label. */
  label?: string;
}

export interface PoliteJsonClient {
  getJson(url: URL | string, options?: PoliteRequestOptions): Promise<unknown>;
  /** POSTs `body` as JSON and parses a JSON response. */
  postJson(
    url: URL | string,
    body: unknown,
    options?: PoliteRequestOptions,
  ): Promise<unknown>;
  /** GETs a page (e.g. an HTML job detail page) as text. */
  getText(url: URL | string, options?: PoliteRequestOptions): Promise<string>;
  /** Number of requests sent so far. */
  readonly requestCount: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sequential HTTP client with a browser-like user agent and a fixed pause
 * between requests (whatever their method or host). Errors never include
 * upstream response bodies.
 */
export function createPoliteJsonClient(
  options: PoliteJsonClientOptions,
): PoliteJsonClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const delayMs = Math.max(0, options.delayMs ?? DEFAULT_POLITE_DELAY_MS);
  let requestCount = 0;

  async function send(
    url: URL | string,
    init: { method: "GET" | "POST"; accept: string; body?: string },
    requestOptions: PoliteRequestOptions = {},
  ): Promise<Response> {
    const label = requestOptions.label ?? options.label;
    const pause = requestCount > 0 ? delayMs : 0;
    if (options.deadline !== undefined && now() + pause >= options.deadline) {
      throw new TimeBudgetExceededError(options.label);
    }
    if (pause > 0) await sleep(pause);
    requestCount += 1;

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: init.method,
        headers: {
          Accept: init.accept,
          "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
          "User-Agent": BROWSER_USER_AGENT,
          ...(init.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
          ...options.headers,
          ...requestOptions.headers,
        },
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      throw new Error(
        `${label} request ${timedOut ? "timed out" : "failed (network error)"}`,
      );
    }

    if (!response.ok) {
      throw new Error(`${label} request failed with status ${response.status}`);
    }
    return response;
  }

  const maxBytes = Math.max(
    1,
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
  );

  class ResponseTooLargeError extends Error {}

  /**
   * Reads at most `maxBytes` of the body, or `undefined` when the response
   * has neither a stream nor `text()` (minimal test doubles).
   */
  async function readBodyText(response: Response): Promise<string | undefined> {
    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new ResponseTooLargeError();
    }
    const reader = response.body?.getReader?.();
    if (reader) {
      const decoder = new TextDecoder();
      let size = 0;
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new ResponseTooLargeError();
        }
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    }
    if (typeof response.text !== "function") return undefined;
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new ResponseTooLargeError();
    }
    return text;
  }

  async function readBody<T>(
    response: Response,
    label: string,
    parse: (text: string | undefined) => Promise<T> | T,
    failure: string,
  ): Promise<T> {
    try {
      return await parse(await readBodyText(response));
    } catch (error) {
      throw new Error(
        `${label} ${error instanceof ResponseTooLargeError ? "response was too large" : failure}`,
      );
    }
  }

  function readJson(
    response: Response,
    requestOptions: PoliteRequestOptions = {},
  ): Promise<unknown> {
    return readBody(
      response,
      requestOptions.label ?? options.label,
      async (text) =>
        text === undefined
          ? ((await response.json()) as unknown)
          : (JSON.parse(text) as unknown),
      "returned an invalid JSON response",
    );
  }

  return {
    get requestCount() {
      return requestCount;
    },
    async getJson(url, requestOptions) {
      const response = await send(
        url,
        { method: "GET", accept: "application/json" },
        requestOptions,
      );
      return readJson(response, requestOptions);
    },
    async postJson(url, body, requestOptions) {
      const response = await send(
        url,
        {
          method: "POST",
          accept: "application/json",
          body: JSON.stringify(body),
        },
        requestOptions,
      );
      return readJson(response, requestOptions);
    },
    async getText(url, requestOptions) {
      const response = await send(
        url,
        { method: "GET", accept: "text/html,application/xhtml+xml" },
        requestOptions,
      );
      return readBody(
        response,
        requestOptions?.label ?? options.label,
        (text) => {
          if (text === undefined) throw new Error("no body");
          return text;
        },
        "returned an unreadable page",
      );
    },
  };
}
