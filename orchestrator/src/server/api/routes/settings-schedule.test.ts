import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer, stopServer } from "./test-utils";

const TOKEN = "123456789:AAH-route_test_token_123456789";

const AUTH_ENV = {
  BASIC_AUTH_USER: "admin",
  BASIC_AUTH_PASSWORD: "secret",
  JWT_SECRET: "an-explicit-jwt-secret-with-at-least-32-chars",
  JOBOPS_TEST_AUTH_BYPASS: "0",
};

async function login(baseUrl: string, username: string, password: string) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  expect(res.status).toBe(200);
  return (await res.json()).data.token as string;
}

/** Routes calls to api.telegram.org to `telegram`, everything else to the network stack. */
function stubTelegram(
  telegram: (url: string, init: RequestInit) => Promise<Response>,
) {
  const nativeFetch = globalThis.fetch;
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.telegram.org/")) {
      return telegram(url, init ?? {});
    }
    return nativeFetch(input, init);
  });
  vi.stubGlobal("fetch", spy);
  return {
    telegramCalls: () =>
      spy.mock.calls.filter(([input]) =>
        String(input).startsWith("https://api.telegram.org/"),
      ),
  };
}

describe.sequential("Schedule and digest settings routes", () => {
  let server: Server;
  let baseUrl: string;
  let closeDb: () => void;
  let tempDir: string;

  beforeEach(async () => {
    ({ server, baseUrl, closeDb, tempDir } = await startServer());
  });

  afterEach(async () => {
    await stopServer({ server, closeDb, tempDir });
  });

  const patch = (body: Record<string, unknown>, token?: string) =>
    fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  it("saves the schedule and never returns the bot token", async () => {
    // The auth bypass signs requests in as "test-user"; make it a real
    // member so saving the schedule can record it as the run-as user.
    const { db, schema } = await import("@server/db");
    await db.insert(schema.users).values({ id: "test-user", username: "test" });
    await db.insert(schema.tenantMemberships).values({
      id: "membership-test-user",
      tenantId: "tenant_default",
      userId: "test-user",
      role: "owner",
    });
    const saved = await patch({
      scheduleEnabled: true,
      scheduleTime: "07:30",
      scheduleTimeZone: "Asia/Jakarta",
      scheduleWeekdays: ["fri", "mon"],
      digestMode: "all",
      digestMaxJobs: 8,
      telegramChatId: "-100123456",
      telegramBotToken: TOKEN,
    });
    const savedText = await saved.text();
    expect(saved.status).toBe(200);
    expect(savedText).not.toContain(TOKEN);
    expect(savedText).not.toContain(TOKEN.split(":")[1]);

    const body = JSON.parse(savedText);
    expect(body.data.scheduleEnabled.value).toBe(true);
    expect(body.data.scheduleTime.value).toBe("07:30");
    expect(body.data.scheduleWeekdays.value).toEqual(["mon", "fri"]);
    expect(body.data.digestMode.value).toBe("all");
    expect(body.data.telegramChatId.value).toBe("-100123456");
    expect(body.data.telegramBotTokenHint).toBe("1234");
    expect(body.data).not.toHaveProperty("telegramBotToken");

    const listed = await fetch(`${baseUrl}/api/settings`);
    expect(await listed.text()).not.toContain(TOKEN);

    // Saving the schedule records who scheduled runs run as.
    const { getPipelineScheduleState } = await import(
      "@server/repositories/pipeline-schedule"
    );
    expect(await getPipelineScheduleState("tenant_default")).toMatchObject({
      ownerUserId: "test-user",
    });
  });

  it("rejects invalid schedule and Telegram values without echoing them", async () => {
    for (const invalid of [
      { scheduleTime: "25:00" },
      { scheduleTime: "8am" },
      { scheduleTimeZone: "Mars/Olympus" },
      { scheduleTimeZone: "+07:00" },
      { scheduleWeekdays: [] },
      { scheduleWeekdays: ["someday"] },
      { scheduleCatchUpMinutes: 0 },
      { digestMode: "sometimes" },
      { digestMaxJobs: 21 },
      { telegramChatId: "my chat" },
      { telegramBotToken: "not-a-real-token-value" },
    ]) {
      const res = await patch(invalid);
      const text = await res.text();
      expect(res.status, JSON.stringify(invalid)).toBe(400);
      expect(JSON.parse(text).error.code).toBe("INVALID_REQUEST");
      expect(text).not.toContain("not-a-real-token-value");
    }
  });

  it("shows agents the schedule but only whether Telegram is set", async () => {
    await patch({
      scheduleEnabled: true,
      telegramChatId: "42",
      telegramBotToken: TOKEN,
    });
    const { runWithRequestContext } = await import("@infra/request-context");
    const { getAgentSettingsView } = await import(
      "@server/services/settings-agent-access"
    );
    const view = await runWithRequestContext(
      { requestId: "agent", tenantId: "tenant_default" },
      () => getAgentSettingsView(),
    );

    expect(view.settings.scheduleEnabled).toMatchObject({ value: true });
    expect(view.settings).not.toHaveProperty("telegramChatId");
    expect(view.settings).not.toHaveProperty("telegramBotTokenHint");
    expect(view.hidden.telegramBotToken).toEqual({ set: true });
    expect(view.hidden.telegramChatId).toEqual({ set: true });
    expect(view.webOnly).toEqual(
      expect.arrayContaining(["telegramBotToken", "telegramChatId"]),
    );
    expect(view.webOnly).not.toContain("scheduleTime");
    expect(JSON.stringify(view)).not.toContain(TOKEN);
  });

  it("reports schedule status with the next run and digest readiness", async () => {
    await patch({
      scheduleEnabled: true,
      scheduleTime: "08:00",
      scheduleTimeZone: "Asia/Jakarta",
      telegramChatId: "42",
      telegramBotToken: TOKEN,
    });
    const res = await fetch(`${baseUrl}/api/settings/schedule-status`);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(TOKEN);
    const { data } = JSON.parse(text);
    expect(data).toMatchObject({
      available: true,
      enabled: true,
      timeZone: "Asia/Jakarta",
      timeZoneValid: true,
      lastAttempt: null,
      lastScheduledRun: null,
      digest: {
        mode: "scheduled",
        telegramConfigured: true,
        linksAvailable: false,
        lastStatus: null,
      },
    });
    // 08:00 in Jakarta is 01:00 UTC, on one of the next two days.
    expect(data.nextRunAt).toMatch(/T01:00:00\.000Z$/);
    expect(Date.parse(data.nextRunAt) - Date.now()).toBeLessThanOrEqual(
      24 * 60 * 60 * 1000,
    );
  });

  it("sends a test message with the saved token and reports Telegram's answer", async () => {
    const send = () =>
      fetch(`${baseUrl}/api/settings/telegram/test`, { method: "POST" });

    const missing = await send();
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.message).toBe(
      "Save a bot token and a chat id first.",
    );

    await patch({ telegramChatId: "42", telegramBotToken: TOKEN });
    const telegram = stubTelegram(async () =>
      Response.json({ ok: true, result: { message_id: 7 } }),
    );
    const sent = await send();
    expect(sent.status).toBe(200);
    expect((await sent.json()).data).toEqual({ sent: true });
    const [[url, init]] = telegram.telegramCalls();
    expect(String(url)).toBe(
      `https://api.telegram.org/bot${TOKEN}/sendMessage`,
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({ chat_id: "42" });

    stubTelegram(async () =>
      Response.json(
        {
          ok: false,
          error_code: 401,
          description: `Unauthorized: bot${TOKEN} is gone`,
        },
        { status: 401 },
      ),
    );
    const rejected = await send();
    const rejectedText = await rejected.text();
    expect(rejected.status).toBe(502);
    expect(JSON.parse(rejectedText).error).toMatchObject({
      code: "UPSTREAM_ERROR",
      message: "Telegram said: Unauthorized: bot[redacted] is gone",
    });
    expect(rejectedText).not.toContain(TOKEN);
  });

  it("keeps scheduling and the digest admin-only", async () => {
    await stopServer({ server, closeDb, tempDir });
    ({ server, baseUrl, closeDb, tempDir } = await startServer({
      env: AUTH_ENV,
    }));
    const adminToken = await login(baseUrl, "admin", "secret");
    const created = await fetch(`${baseUrl}/api/workspaces/users`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username: "regular", password: "regular-secret" }),
    });
    expect(created.status).toBe(201);
    const regularToken = await login(baseUrl, "regular", "regular-secret");

    for (const body of [
      { scheduleEnabled: true },
      { digestMode: "all" },
      { telegramChatId: "42" },
    ]) {
      const res = await patch(body, regularToken);
      expect(res.status).toBe(403);
    }
    const test = await fetch(`${baseUrl}/api/settings/telegram/test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${regularToken}` },
    });
    expect(test.status).toBe(403);

    expect((await patch({ scheduleEnabled: true }, adminToken)).status).toBe(
      200,
    );
  });

  it("is unavailable in hosted mode", async () => {
    await stopServer({ server, closeDb, tempDir });
    ({ server, baseUrl, closeDb, tempDir } = await startServer({
      env: {
        JOBOPS_APP_MODE: "hosted",
        JOBOPS_HOSTED_TENANT_ID: "tenant_default",
      },
    }));

    const enable = await patch({ scheduleEnabled: true });
    expect(enable.status).toBe(403);
    expect((await enable.json()).error.message).toMatch(/hosted mode/);
    expect((await patch({ telegramBotToken: TOKEN })).status).toBe(403);
    // Clearing stays possible, so "reset to defaults" works.
    expect((await patch({ scheduleEnabled: null })).status).toBe(200);

    const status = await fetch(`${baseUrl}/api/settings/schedule-status`);
    expect((await status.json()).data).toMatchObject({
      available: false,
      nextRunAt: null,
    });
    const test = await fetch(`${baseUrl}/api/settings/telegram/test`, {
      method: "POST",
    });
    expect(test.status).toBe(403);
  });
});
