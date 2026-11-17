export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export const DEFAULT_POLITE_DELAY_MS = 1_500;
const DEFAULT_TIMEOUT_MS = 20_000;

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
}

export interface PoliteJsonClient {
  getJson(url: URL | string): Promise<unknown>;
  /** Number of requests sent so far. */
  readonly requestCount: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sequential JSON GET client with a browser-like user agent and a fixed pause
 * between requests. Errors never include upstream response bodies.
 */
export function createPoliteJsonClient(
  options: PoliteJsonClientOptions,
): PoliteJsonClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const delayMs = Math.max(0, options.delayMs ?? DEFAULT_POLITE_DELAY_MS);
  let requestCount = 0;

  return {
    get requestCount() {
      return requestCount;
    },
    async getJson(url) {
      const pause = requestCount > 0 ? delayMs : 0;
      if (options.deadline !== undefined && now() + pause >= options.deadline) {
        throw new TimeBudgetExceededError(options.label);
      }
      if (pause > 0) await sleep(pause);
      requestCount += 1;

      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers: {
            Accept: "application/json",
            "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
            "User-Agent": BROWSER_USER_AGENT,
            ...options.headers,
          },
          signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch (error) {
        const timedOut =
          error instanceof Error &&
          (error.name === "TimeoutError" || error.name === "AbortError");
        throw new Error(
          `${options.label} request ${timedOut ? "timed out" : "failed (network error)"}`,
        );
      }

      if (!response.ok) {
        throw new Error(
          `${options.label} request failed with status ${response.status}`,
        );
      }

      try {
        return (await response.json()) as unknown;
      } catch {
        throw new Error(`${options.label} returned an invalid JSON response`);
      }
    },
  };
}
