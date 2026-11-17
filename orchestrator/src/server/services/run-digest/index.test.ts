import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunDigestEvent } from "./index";
import type { TelegramFetch } from "./telegram";

const TOKEN = "123456789:AAH-digest_token_value_1234567890";

/**
 * The digest against a real migrated database: which runs send a message,
 * what it contains, and that delivery problems are recorded and logged
 * without the bot token. Telegram is an injected fetch.
 */
describe.sequential("run digest delivery", () => {
  const originalEnv = { ...process.env };
  let tempDir: string;
  let closeDb: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-digest-"));
    vi.resetModules();
    process.env = {
      ...originalEnv,
      DATA_DIR: tempDir,
      NODE_ENV: "test",
      JOBOPS_PUBLIC_BASE_URL: "https://jobs.example.com/",
    };
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.JOBOPS_APP_MODE;
    const log = console.log;
    console.log = () => {};
    try {
      await import("@server/db/migrate");
    } finally {
      console.log = log;
    }
    ({ closeDb } = await import("@server/db"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    closeDb?.();
    closeDb = null;
    process.env = { ...originalEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  async function inTenant<T>(tenantId: string, fn: () => Promise<T>) {
    const { runWithRequestContext } = await import("@infra/request-context");
    return runWithRequestContext({ requestId: "test", tenantId }, fn);
  }

  async function setSettings(
    tenantId: string,
    values: Record<string, string>,
  ): Promise<void> {
    const settingsRepo = await import("@server/repositories/settings");
    await inTenant(tenantId, async () => {
      for (const [key, value] of Object.entries(values)) {
        await settingsRepo.setSetting(
          key as Parameters<typeof settingsRepo.setSetting>[0],
          value,
        );
      }
    });
  }

  async function addJobs(
    tenantId: string,
    jobs: Array<{ title: string; employer: string; score: number | null }>,
  ): Promise<string[]> {
    const jobsRepo = await import("@server/repositories/jobs");
    const { db, schema } = await import("@server/db");
    const { eq } = await import("drizzle-orm");
    return inTenant(tenantId, async () => {
      const ids: string[] = [];
      for (const [index, job] of jobs.entries()) {
        const created = await jobsRepo.createJob({
          source: "linkedin",
          title: job.title,
          employer: job.employer,
          jobUrl: `https://example.com/${tenantId}/${index}`,
        });
        await db
          .update(schema.jobs)
          .set({ suitabilityScore: job.score })
          .where(eq(schema.jobs.id, created.id));
        ids.push(created.id);
      }
      return ids;
    });
  }

  function telegram(
    status = 200,
    body: unknown = { ok: true },
  ): TelegramFetch & { texts: () => string[] } {
    const fn = vi.fn(async () => ({
      ok: status < 300,
      status,
      json: async () => body,
    })) as unknown as TelegramFetch & { texts: () => string[] };
    fn.texts = () =>
      vi
        .mocked(fn)
        .mock.calls.map(([, init]) => JSON.parse(init.body).text as string);
    return fn;
  }

  async function digest() {
    return import("./index");
  }

  async function digestState(tenantId: string) {
    const repo = await import("@server/repositories/pipeline-schedule");
    return repo.getPipelineScheduleState(tenantId);
  }

  it("sends the top new jobs after a scheduled run, marking target companies", async () => {
    await setSettings("tenant_default", {
      telegramBotToken: TOKEN,
      telegramChatId: "42",
      digestMaxJobs: "2",
      targetCompanies: JSON.stringify(["Grab", "GoTo | Gojek | Tokopedia"]),
    });
    const ids = await addJobs("tenant_default", [
      { title: "QA Intern", employer: "Smallco", score: 55 },
      { title: "Software Engineer Intern", employer: "Grab", score: 91 },
      { title: "Backend Intern", employer: "Tokopedia", score: 80 },
    ]);
    const fetchImpl = telegram();
    const { sendRunDigest } = await digest();

    const outcome = await inTenant("tenant_default", () =>
      sendRunDigest(
        {
          kind: "completed",
          pipelineRunId: "run-1",
          trigger: "schedule",
          jobsFound: 30,
          newJobIds: ids,
          jobsScored: 3,
          jobsTailored: 1,
        },
        { fetchImpl, now: () => new Date("2026-11-17T01:20:00.000Z") },
      ),
    );

    expect(outcome).toBe("sent");
    expect(fetchImpl.texts()).toEqual([
      [
        "JobOps: scheduled run finished",
        "Found 30, 3 new. Scored 3, tailored 1.",
        "",
        "Top new jobs:",
        "",
        "1. Software Engineer Intern",
        "Grab · score 91 · 🎯 target company",
        `https://jobs.example.com/job/${ids[1]}`,
        "",
        "2. Backend Intern",
        "Tokopedia · score 80 · 🎯 target company",
        `https://jobs.example.com/job/${ids[2]}`,
        "",
        "+1 more new job in JobOps.",
        "https://jobs.example.com/jobs/all",
      ].join("\n"),
    ]);
    expect(await digestState("tenant_default")).toMatchObject({
      lastDigestStatus: "sent",
      lastDigestAt: "2026-11-17T01:20:00.000Z",
      lastDigestDetail: null,
    });
  });

  it("only lists jobs of the run's own workspace", async () => {
    await setSettings("tenant_default", {
      telegramBotToken: TOKEN,
      telegramChatId: "42",
    });
    const { db, schema } = await import("@server/db");
    await db
      .insert(schema.tenants)
      .values({ id: "tenant_other", name: "Other", slug: "other" });
    const otherIds = await addJobs("tenant_other", [
      { title: "Secret Job", employer: "Elsewhere", score: 99 },
    ]);
    const ownIds = await addJobs("tenant_default", [
      { title: "Own Job", employer: "Acme", score: 60 },
    ]);
    const fetchImpl = telegram();
    const { sendRunDigest } = await digest();
    await inTenant("tenant_default", () =>
      sendRunDigest(
        {
          kind: "completed",
          pipelineRunId: "run-1",
          trigger: "schedule",
          jobsFound: 2,
          newJobIds: [...otherIds, ...ownIds],
          jobsScored: 2,
          jobsTailored: 0,
        },
        { fetchImpl },
      ),
    );
    const [text] = fetchImpl.texts();
    expect(text).toContain("Own Job");
    expect(text).not.toContain("Secret Job");
  });

  it("follows the digest mode and needs both token and chat id", async () => {
    const fetchImpl = telegram();
    const { sendRunDigest } = await digest();
    const failed: RunDigestEvent = {
      kind: "failed",
      pipelineRunId: "run-1",
      trigger: "user",
      error: "boom",
    };
    const send = (event: RunDigestEvent = failed) =>
      inTenant("tenant_default", () => sendRunDigest(event, { fetchImpl }));

    await setSettings("tenant_default", { telegramChatId: "42" });
    expect(await send({ ...failed, trigger: "schedule" })).toBe(
      "skipped_not_configured",
    );

    await setSettings("tenant_default", { telegramBotToken: TOKEN });
    // Default mode: scheduled runs only.
    expect(await send()).toBe("skipped_off");
    expect(await send({ ...failed, trigger: "schedule" })).toBe("sent");

    await setSettings("tenant_default", { digestMode: "all" });
    expect(await send()).toBe("sent");

    await setSettings("tenant_default", { digestMode: "off" });
    expect(await send({ ...failed, trigger: "schedule" })).toBe("skipped_off");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("sends nothing when a run found no new jobs, but reports failures", async () => {
    await setSettings("tenant_default", {
      telegramBotToken: TOKEN,
      telegramChatId: "42",
    });
    const fetchImpl = telegram();
    const { sendRunDigest } = await digest();
    expect(
      await inTenant("tenant_default", () =>
        sendRunDigest(
          {
            kind: "completed",
            pipelineRunId: "run-1",
            trigger: "schedule",
            jobsFound: 12,
            newJobIds: [],
            jobsScored: 0,
            jobsTailored: 0,
          },
          { fetchImpl },
        ),
      ),
    ).toBe("skipped_nothing_new");
    expect(fetchImpl).not.toHaveBeenCalled();

    await inTenant("tenant_default", () =>
      sendRunDigest(
        {
          kind: "failed",
          pipelineRunId: "run-2",
          trigger: "schedule",
          error: "LLM call failed: 429 usage limit reached",
        },
        { fetchImpl },
      ),
    );
    expect(fetchImpl.texts()).toEqual([
      [
        "JobOps: scheduled run failed",
        "Reason: LLM call failed: 429 usage limit reached",
        "https://jobs.example.com/overview",
      ].join("\n"),
    ]);
  });

  it("records and logs a failed delivery without the token", async () => {
    await setSettings("tenant_default", {
      telegramBotToken: TOKEN,
      telegramChatId: "42",
    });
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const fetchImpl = telegram(403, {
      ok: false,
      error_code: 403,
      description: `Forbidden: bot was blocked by the user (bot${TOKEN})`,
    });
    const { sendRunDigest } = await digest();

    expect(
      await inTenant("tenant_default", () =>
        sendRunDigest(
          { kind: "start_failed", error: "No saved search" },
          { fetchImpl },
        ),
      ),
    ).toBe("failed");
    expect(await digestState("tenant_default")).toMatchObject({
      lastDigestStatus: "failed",
      lastDigestDetail:
        "Telegram said: Forbidden: bot was blocked by the user (bot[redacted])",
    });
    expect(
      lines.some((line) => line.includes("Run digest delivery failed")),
    ).toBe(true);
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(lines.join("\n")).not.toContain("api.telegram.org");
  });

  it("queues delivery without throwing, even when it fails", async () => {
    const { queueRunDigest } = await digest();
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    // No tenant context and no database row: still returns immediately.
    expect(() =>
      queueRunDigest({ kind: "start_failed", error: "x" }),
    ).not.toThrow();
  });
});
