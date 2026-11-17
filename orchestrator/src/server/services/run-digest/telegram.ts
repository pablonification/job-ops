/**
 * Minimal Telegram Bot API client: send one plain-text message.
 *
 * Telegram puts the bot token in the request URL, so nothing from the
 * request (URL, raw fetch error) ever leaves this module: every failure is
 * mapped to a fixed message or to Telegram's own error description with the
 * token removed. Callers may log the returned `error` as is.
 */
import { TELEGRAM_BOT_TOKEN_PATTERN } from "@shared/pipeline-schedule";

/** The only host this client talks to. */
const TELEGRAM_API_ORIGIN = "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ERROR_LENGTH = 200;

/** Telegram's limit for one message, in characters. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

export type TelegramFetch = (
  input: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export type TelegramSendResult =
  | { ok: true }
  | {
      ok: false;
      /** Safe to show and log: never contains the token or the URL. */
      error: string;
      /** HTTP status from Telegram, or null when it was not reached. */
      status: number | null;
    };

function scrubSecret(text: string, botToken: string): string {
  let out = text;
  if (botToken) out = out.split(botToken).join("[redacted]");
  // Any other token-looking or URL-looking text is dropped too.
  out = out
    .replace(/\d{3,20}:[A-Za-z0-9_-]{20,}/g, "[redacted]")
    .replace(/https?:\/\/\S+/g, "[url]")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters from upstream text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
  return out.length > MAX_ERROR_LENGTH
    ? `${out.slice(0, MAX_ERROR_LENGTH - 1)}…`
    : out;
}

function readDescription(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const description = (body as { description?: unknown }).description;
  return typeof description === "string" && description.trim()
    ? description
    : null;
}

/** Longest wait Telegram may ask for before the one retry, in seconds. */
export const MAX_RETRY_AFTER_SECONDS = 30;

function readRetryAfter(body: unknown): number | null {
  if (!body || typeof body !== "object") return null;
  const parameters = (body as { parameters?: unknown }).parameters;
  if (!parameters || typeof parameters !== "object") return null;
  const value = (parameters as { retry_after?: unknown }).retry_after;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

type AttemptResult = TelegramSendResult & { retryAfterSeconds?: number };

async function attemptSend(args: {
  url: string;
  body: string;
  botToken: string;
  fetchImpl: TelegramFetch;
  timeoutMs: number;
}): Promise<AttemptResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    let response: Awaited<ReturnType<TelegramFetch>>;
    try {
      response = await args.fetchImpl(args.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: args.body,
        signal: controller.signal,
      });
    } catch {
      // Raw fetch errors can quote the request URL, and with it the token.
      return {
        ok: false,
        status: null,
        error: controller.signal.aborted
          ? "Telegram did not answer in time."
          : "Could not reach Telegram.",
      };
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    const telegramOk =
      body && typeof body === "object" && "ok" in body
        ? (body as { ok: unknown }).ok === true
        : response.ok;
    if (response.ok && telegramOk) return { ok: true };

    const description = readDescription(body);
    const retryAfter = response.status === 429 ? readRetryAfter(body) : null;
    return {
      ok: false,
      status: response.status,
      error: description
        ? `Telegram said: ${scrubSecret(description, args.botToken)}`
        : `Telegram answered with HTTP ${response.status}.`,
      ...(response.status === 429
        ? { retryAfterSeconds: retryAfter ?? 1 }
        : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Sends `text` as a plain-text message (no parse mode, link previews off).
 * When Telegram answers 429 (too many requests) it waits the `retry_after`
 * Telegram gives and tries once more, unless that wait is longer than
 * `MAX_RETRY_AFTER_SECONDS` or `retryOnRateLimit` is false. Never throws.
 */
export async function sendTelegramMessage(args: {
  botToken: string;
  chatId: string;
  text: string;
  fetchImpl?: TelegramFetch;
  timeoutMs?: number;
  retryOnRateLimit?: boolean;
  sleep?: (ms: number) => Promise<void>;
}): Promise<TelegramSendResult> {
  const botToken = args.botToken.trim();
  const chatId = args.chatId.trim();
  if (!TELEGRAM_BOT_TOKEN_PATTERN.test(botToken)) {
    return {
      ok: false,
      status: null,
      error: "The bot token does not look like a Telegram bot token.",
    };
  }
  if (!chatId) {
    return { ok: false, status: null, error: "No chat id is set." };
  }

  const attempt = () =>
    attemptSend({
      url: `${TELEGRAM_API_ORIGIN}/bot${botToken}/sendMessage`,
      body: JSON.stringify({
        chat_id: chatId,
        text: args.text,
        link_preview_options: { is_disabled: true },
      }),
      botToken,
      fetchImpl: args.fetchImpl ?? (fetch as unknown as TelegramFetch),
      timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

  let result = await attempt();
  if (
    !result.ok &&
    result.retryAfterSeconds !== undefined &&
    (args.retryOnRateLimit ?? true) &&
    result.retryAfterSeconds <= MAX_RETRY_AFTER_SECONDS
  ) {
    await (args.sleep ?? defaultSleep)(
      Math.max(1, result.retryAfterSeconds) * 1000,
    );
    result = await attempt();
  }
  if (result.ok) return { ok: true };
  return { ok: false, status: result.status, error: result.error };
}
