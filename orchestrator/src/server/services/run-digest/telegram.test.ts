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
