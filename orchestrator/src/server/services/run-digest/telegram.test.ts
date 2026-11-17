import { describe, expect, it, vi } from "vitest";
import { sendTelegramMessage, type TelegramFetch } from "./telegram";

const TOKEN = "123456789:AAH-test_token_value_1234567890abc";

function respond(status: number, body: unknown): TelegramFetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

describe("Telegram client", () => {
  it("posts plain text to sendMessage on api.telegram.org", async () => {
    const fetchImpl = respond(200, { ok: true, result: { message_id: 1 } });
    const result = await sendTelegramMessage({
      botToken: TOKEN,
      chatId: "-1001234",
      text: "Hello *world* <b>",
      fetchImpl,
    });

    expect(result).toEqual({ ok: true });
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      chat_id: "-1001234",
      text: "Hello *world* <b>",
      link_preview_options: { is_disabled: true },
    });
  });

  it("returns Telegram's error description without the token", async () => {
    const result = await sendTelegramMessage({
      botToken: TOKEN,
      chatId: "42",
      text: "hi",
      fetchImpl: respond(400, {
        ok: false,
        error_code: 400,
        description: `Bad Request: chat not found for bot${TOKEN} at https://api.telegram.org/bot${TOKEN}/sendMessage`,
      }),
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      error:
        "Telegram said: Bad Request: chat not found for bot[redacted] at [url]",
    });
  });

  it("never surfaces fetch errors, which can quote the URL", async () => {
    const fetchImpl: TelegramFetch = vi.fn(async () => {
      throw new TypeError(
        `Failed to parse URL from https://api.telegram.org/bot${TOKEN}/sendMessage`,
      );
    });
    const result = await sendTelegramMessage({
      botToken: TOKEN,
      chatId: "42",
      text: "hi",
      fetchImpl,
    });
    expect(result).toEqual({
      ok: false,
      status: null,
      error: "Could not reach Telegram.",
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("gives up after the timeout", async () => {
    const fetchImpl: TelegramFetch = vi.fn(
      (_url, init) =>
        new Promise<never>((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    const result = await sendTelegramMessage({
      botToken: TOKEN,
      chatId: "42",
      text: "hi",
      fetchImpl,
      timeoutMs: 5,
    });
    expect(result).toEqual({
      ok: false,
      status: null,
      error: "Telegram did not answer in time.",
    });
  });

  it("reports an HTTP error without a JSON body", async () => {
    const fetchImpl: TelegramFetch = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    }));
    const result = await sendTelegramMessage({
      botToken: TOKEN,
      chatId: "42",
      text: "hi",
      fetchImpl,
    });
    expect(result).toEqual({
      ok: false,
      status: 502,
      error: "Telegram answered with HTTP 502.",
    });
  });

  it("retries once after a 429, waiting the time Telegram asks for", async () => {
    const limited = {
      ok: false,
      status: 429,
      json: async () => ({
        ok: false,
        error_code: 429,
        description: "Too Many Requests: retry after 3",
        parameters: { retry_after: 3 },
      }),
    };
    const fetchImpl: TelegramFetch = vi
      .fn()
      .mockResolvedValueOnce(limited)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      });
    const sleep = vi.fn(async () => undefined);

    expect(
      await sendTelegramMessage({
        botToken: TOKEN,
        chatId: "42",
        text: "hi",
        fetchImpl,
        sleep,
      }),
    ).toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // Still limited on the retry: give up and report it.
    const stillLimited: TelegramFetch = vi.fn().mockResolvedValue(limited);
    expect(
      await sendTelegramMessage({
        botToken: TOKEN,
        chatId: "42",
        text: "hi",
        fetchImpl: stillLimited,
        sleep,
      }),
    ).toEqual({
      ok: false,
      status: 429,
      error: "Telegram said: Too Many Requests: retry after 3",
    });
    expect(stillLimited).toHaveBeenCalledTimes(2);
  });

  it("does not wait longer than 30 seconds, nor when retries are off", async () => {
    const limited = (retryAfter: number) => ({
      ok: false,
      status: 429,
      json: async () => ({
        ok: false,
        description: `Too Many Requests: retry after ${retryAfter}`,
        parameters: { retry_after: retryAfter },
      }),
    });
    const sleep = vi.fn(async () => undefined);
    const longWait: TelegramFetch = vi.fn().mockResolvedValue(limited(31));
    expect(
      await sendTelegramMessage({
        botToken: TOKEN,
        chatId: "42",
        text: "hi",
        fetchImpl: longWait,
        sleep,
      }),
    ).toMatchObject({ ok: false, status: 429 });
    expect(longWait).toHaveBeenCalledTimes(1);

    const noRetry: TelegramFetch = vi.fn().mockResolvedValue(limited(2));
    await sendTelegramMessage({
      botToken: TOKEN,
      chatId: "42",
      text: "hi",
      fetchImpl: noRetry,
      sleep,
      retryOnRateLimit: false,
    });
    expect(noRetry).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not call Telegram with a malformed token or no chat id", async () => {
    const fetchImpl = respond(200, { ok: true });
    expect(
      await sendTelegramMessage({
        botToken: "not-a-token",
        chatId: "42",
        text: "hi",
        fetchImpl,
      }),
    ).toMatchObject({ ok: false, status: null });
    expect(
      await sendTelegramMessage({
        botToken: TOKEN,
        chatId: " ",
        text: "hi",
        fetchImpl,
      }),
    ).toMatchObject({ ok: false, error: "No chat id is set." });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
