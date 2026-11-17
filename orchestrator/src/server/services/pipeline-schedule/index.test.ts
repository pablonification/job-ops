import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The scheduler against a real migrated database: due times, the persisted
 * single-fire claim, skips and per-tenant isolation. Runs are never started;
 * `startRun` is a spy and the clock is injected.
 */
describe.sequential("pipeline scheduler", () => {
  const originalEnv = { ...process.env };
  let tempDir: string;
  let closeDb: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-schedule-"));
    vi.resetModules();
    process.env = {
      ...originalEnv,
      DATA_DIR: tempDir,
      NODE_ENV: "test",
      JOBOPS_TEST_AUTH_BYPASS: "0",
    };
    for (const key of [
      "JOBOPS_APP_MODE",
      "JOBOPS_HOSTED_TENANT_ID",
      "DEMO_MODE",
      "TELEGRAM_BOT_TOKEN",
      "JOBOPS_PUBLIC_BASE_URL",
    ]) {
      delete process.env[key];
    }
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
    closeDb?.();
    closeDb = null;
    process.env = { ...originalEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  const PRESET_CONFIG = {
    searchTerms: ["software engineer intern"],
    sources: ["linkedin"],
    country: "indonesia",
    cityLocations: ["Jakarta"],
    locationMode: "cities",
    proximity: { latitude: -6.2, longitude: 106.8, radiusMiles: 20 },
    workplaceTypes: ["hybrid", "onsite"],
    searchScope: "selected_only",
    matchStrictness: "exact_only",
    topN: 5,
    minSuitabilityScore: 60,
    runBudget: 500,
    scoringInstructions: "Prefer big tech.",
  };

  async function createTenant(id: string): Promise<void> {
    const { db, schema } = await import("@server/db");
    await db
      .insert(schema.tenants)
      .values({ id, name: id, slug: id })
      .onConflictDoNothing();
  }

  async function createUser(
    id: string,
    tenantId: string,
    options: { admin?: boolean; disabled?: boolean; createdAt?: string } = {},
  ): Promise<void> {
    const { db, schema } = await import("@server/db");
    await createTenant(tenantId);
    await db.insert(schema.users).values({
      id,
      username: id,
      isSystemAdmin: options.admin ?? false,
      isDisabled: options.disabled ?? false,
      createdAt: options.createdAt ?? "2026-01-01 00:00:00",
    });
    await db.insert(schema.tenantMemberships).values({
      id: `membership-${id}`,
      userId: id,
      tenantId,
      role: "owner",
    });
  }

  async function inTenant<T>(
    tenantId: string,
    userId: string | null,
    fn: () => Promise<T>,
  ): Promise<T> {
    const { runWithRequestContext } = await import("@infra/request-context");
    return runWithRequestContext(
      {
        requestId: `test-${tenantId}`,
        tenantId,
        ...(userId ? { userId, username: userId } : {}),
      },
      fn,
    );
  }

  async function configureSchedule(
    tenantId: string,
    values: Record<string, string>,
  ): Promise<void> {
    const settingsRepo = await import("@server/repositories/settings");
    await inTenant(tenantId, null, async () => {
      for (const [key, value] of Object.entries({
        scheduleEnabled: "1",
        scheduleTime: "08:00",
        scheduleTimeZone: "Asia/Jakarta",
        ...values,
      })) {
        await settingsRepo.setSetting(
          key as Parameters<typeof settingsRepo.setSetting>[0],
          value,
        );
      }
    });
  }

  async function savePreset(
    tenantId: string,
    userId: string,
    name = "Big tech internships",
    config: Record<string, unknown> = PRESET_CONFIG,
  ): Promise<string> {
    const presets = await import(
      "@server/repositories/pipeline-search-presets"
    );
    return inTenant(tenantId, userId, async () => {
      const preset = await presets.createPipelineSearchPreset({
        name,
        config: config as never,
      });
      return preset.id;
    });
  }

  async function scheduler() {
    return import("./index");
  }

  function clock(iso: string) {
    let now = new Date(iso);
    return {
      now: () => now,
      set: (next: string) => {
        now = new Date(next);
      },
    };
  }

  async function stateOf(tenantId: string) {
    const repo = await import("@server/repositories/pipeline-schedule");
    return repo.getPipelineScheduleState(tenantId);
  }

  it("starts one run with the saved search at the scheduled minute", async () => {
    await createUser("owner", "tenant_default", { admin: true });
    await savePreset("tenant_default", "owner");
    await configureSchedule("tenant_default", {});
    const { runScheduleTick } = await scheduler();
    const { getRequestContext } = await import("@infra/request-context");

    const contexts: unknown[] = [];
    const startRun = vi.fn(async () => {
      contexts.push({ ...getRequestContext() });
    });
    const time = clock("2026-11-17T00:59:30.000Z");

    // Not yet due.
    expect(await runScheduleTick({ now: time.now, startRun })).toEqual({
      tenant_default: { status: "not_due" },
    });

    // 08:00:02 and 08:00:40 in Jakarta: two ticks in the scheduled minute.
    time.set("2026-11-17T01:00:02.000Z");
    const first = await runScheduleTick({ now: time.now, startRun });
    time.set("2026-11-17T01:00:40.000Z");
    const second = await runScheduleTick({ now: time.now, startRun });

    expect(first.tenant_default).toEqual({
      status: "started",
      occurrence: "2026-11-17T01:00:00.000Z",
      detail: null,
    });
    expect(second.tenant_default).toEqual({ status: "not_due" });
    expect(startRun).toHaveBeenCalledTimes(1);
    expect(startRun).toHaveBeenCalledWith({
      config: {
        topN: 5,
        minSuitabilityScore: 60,
        sources: ["linkedin"],
        runBudget: 500,
        searchTerms: ["software engineer intern"],
        scoringInstructions: "Prefer big tech.",
        country: "indonesia",
        cityLocations: ["Jakarta"],
        // The preset searches by city, so its saved map point is not used.
        proximity: null,
        workplaceTypes: ["hybrid", "onsite"],
        searchScope: "selected_only",
        matchStrictness: "exact_only",
      },
      configResolved: true,
      trigger: "schedule",
      requestOrigin: null,
    });
    expect(contexts[0]).toMatchObject({
      tenantId: "tenant_default",
      userId: "owner",
      username: "owner",
      isSystemAdmin: true,
    });
    expect(await stateOf("tenant_default")).toMatchObject({
      lastFiredOccurrence: "2026-11-17T01:00:00.000Z",
      lastOutcome: "started",
      lastAttemptAt: "2026-11-17T01:00:02.000Z",
    });
  });

  it("does not fire again after a restart inside the same minute", async () => {
    await createUser("owner", "tenant_default", { admin: true });
    await savePreset("tenant_default", "owner");
    await configureSchedule("tenant_default", {});
    const startRun = vi.fn(async () => undefined);
    const time = clock("2026-11-17T01:00:05.000Z");

    const before = await scheduler();
    await before.runScheduleTick({ now: time.now, startRun });

    // A fresh module graph, as after a process restart; the claim is in
    // the database.
    vi.resetModules();
    const after = await scheduler();
    time.set("2026-11-17T01:00:50.000Z");
    expect(
      (await after.runScheduleTick({ now: time.now, startRun })).tenant_default,
    ).toEqual({ status: "not_due" });
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  it("lets only one of two concurrent claims win", async () => {
    await createTenant("tenant_default");
    const repo = await import("@server/repositories/pipeline-schedule");
    const claim = () =>
      repo.claimScheduledOccurrence({
        tenantId: "tenant_default",
        occurrence: "2026-11-17T01:00:00.000Z",
        localDate: "2026-11-17",
        now: "2026-11-17T01:00:01.000Z",
      });
    const results = await Promise.all([claim(), claim(), claim()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    // An older occurrence can never be claimed after a newer one.
    expect(
      await repo.claimScheduledOccurrence({
        tenantId: "tenant_default",
        occurrence: "2026-11-16T01:00:00.000Z",
        localDate: "2026-11-16",
        now: "2026-11-17T01:00:02.000Z",
      }),
    ).toBe(false);
    // Nor a later time on the same local day.
    expect(
      await repo.claimScheduledOccurrence({
        tenantId: "tenant_default",
        occurrence: "2026-11-17T02:00:00.000Z",
        localDate: "2026-11-17",
        now: "2026-11-17T02:00:02.000Z",
      }),
    ).toBe(false);
  });

  it("catches up a missed run inside the window and skips older ones", async () => {
    await createUser("owner", "tenant_default", { admin: true });
    await savePreset("tenant_default", "owner");
    await configureSchedule("tenant_default", { scheduleCatchUpMinutes: "15" });
    const { runScheduleTick } = await scheduler();
    const startRun = vi.fn(async () => undefined);

    // Server was down at 08:00 and came back at 08:16: too late.
    const late = clock("2026-11-17T01:16:00.000Z");
    expect(
      (await runScheduleTick({ now: late.now, startRun })).tenant_default,
    ).toEqual({ status: "not_due" });
    expect(startRun).not.toHaveBeenCalled();

    // Next day it came back at 08:14: still inside the window.
    late.set("2026-11-18T01:14:00.000Z");
    expect(
      (await runScheduleTick({ now: late.now, startRun })).tenant_default,
    ).toMatchObject({
      status: "started",
      occurrence: "2026-11-18T01:00:00.000Z",
    });
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  it("skips, without queueing, when a run is already active", async () => {
    await createUser("owner", "tenant_default", { admin: true });
    await savePreset("tenant_default", "owner");
    await configureSchedule("tenant_default", {});
    const { conflict } = await import("@infra/errors");
    const { runScheduleTick, getPipelineScheduleStatus } = await scheduler();
    const startRun = vi.fn(async () => {
      throw conflict("Pipeline is already running");
    });
    const time = clock("2026-11-17T01:00:03.000Z");

    expect(
      (await runScheduleTick({ now: time.now, startRun })).tenant_default,
    ).toEqual({
      status: "skipped_active",
      occurrence: "2026-11-17T01:00:00.000Z",
      detail: "A run was already active.",
    });
    // The active run finishes a minute later: the occurrence is used up.
    time.set("2026-11-17T01:01:03.000Z");
    expect(
      (await runScheduleTick({ now: time.now, startRun })).tenant_default,
    ).toEqual({ status: "not_due" });
    expect(startRun).toHaveBeenCalledTimes(1);

    const status = await inTenant("tenant_default", "owner", () =>
      getPipelineScheduleStatus(time.now()),
    );
    expect(status).toMatchObject({
      available: true,
      enabled: true,
      timeZone: "Asia/Jakarta",
      timeZoneValid: true,
      nextRunAt: "2026-11-18T01:00:00.000Z",
      runAsUsername: "owner",
      lastAttempt: {
        occurrence: "2026-11-17T01:00:00.000Z",
        outcome: "skipped_active",
        detail: "A run was already active.",
      },
      digest: {
        mode: "scheduled",
        telegramConfigured: false,
        linksAvailable: false,
      },
    });
  });

  it("keeps other workspaces going when one fails", async () => {
    await createUser("alice", "tenant_a", { admin: true });
    await createUser("bob", "tenant_b", { admin: true });
    await createUser("carol", "tenant_c", { admin: true });
    await savePreset("tenant_a", "alice");
    await savePreset("tenant_b", "bob");
    // tenant_c has no saved search; tenant_a's zone is not valid any more.
    await configureSchedule("tenant_a", { scheduleTimeZone: "Mars/Base" });
    await configureSchedule("tenant_b", {});
    await configureSchedule("tenant_c", {});
    const { runScheduleTick } = await scheduler();
    const { getRequestContext } = await import("@infra/request-context");
    const startRun = vi.fn(async () => {
      if (getRequestContext()?.tenantId === "tenant_b") return;
      throw new Error("unexpected");
    });

    const results = await runScheduleTick({
      now: () => new Date("2026-11-17T01:00:10.000Z"),
      startRun,
    });

    expect(results.tenant_a).toEqual({ status: "invalid_time_zone" });
    expect(results.tenant_b).toMatchObject({ status: "started" });
    expect(results.tenant_c).toEqual({
      status: "failed_to_start",
      occurrence: "2026-11-17T01:00:00.000Z",
      detail:
        "No job sources to search. Choose sources for this run, or save a search in the run dialog first.",
    });
    expect(startRun).toHaveBeenCalledTimes(1);
    // Nothing is claimed for the invalid zone; it is logged once, and its
    // status says why.
    expect(await stateOf("tenant_a")).toMatchObject({
      lastFiredOccurrence: null,
      reportedInvalidTimeZone: "Mars/Base",
    });
    const repo = await import("@server/repositories/pipeline-schedule");
    expect(
      await repo.markInvalidTimeZoneReported({
        tenantId: "tenant_a",
        timeZone: "Mars/Base",
        now: "2026-11-17T01:01:10.000Z",
      }),
    ).toBe(false);
    const { getPipelineScheduleStatus } = await scheduler();
    const status = await inTenant("tenant_a", "alice", () =>
      getPipelineScheduleStatus(new Date("2026-11-17T01:00:10.000Z")),
    );
    expect(status).toMatchObject({ timeZoneValid: false, nextRunAt: null });
  });

  it("records a start failure and moves on to the next workspace", async () => {
    await createUser("alice", "tenant_a", { admin: true });
    await createUser("bob", "tenant_b", { admin: true });
    await savePreset("tenant_a", "alice");
    await savePreset("tenant_b", "bob");
    await configureSchedule("tenant_a", {});
    await configureSchedule("tenant_b", {});
    const { runScheduleTick } = await scheduler();
    const { badRequest } = await import("@infra/errors");
    const { getRequestContext } = await import("@infra/request-context");
    const startRun = vi.fn(async () => {
      if (getRequestContext()?.tenantId === "tenant_a") {
        throw badRequest(
          "Requested sources are not available at runtime: linkedin",
        );
      }
    });

    const results = await runScheduleTick({
      now: () => new Date("2026-11-17T01:00:10.000Z"),
      startRun,
    });
    expect(results.tenant_a).toMatchObject({
      status: "failed_to_start",
      detail: "Requested sources are not available at runtime: linkedin",
    });
    expect(results.tenant_b).toMatchObject({ status: "started" });
  });

  it("runs as the user who saved the schedule, else the earliest active admin", async () => {
    await createUser("first-admin", "tenant_default", {
      admin: true,
      createdAt: "2026-01-01 00:00:00",
    });
    await createUser("second-admin", "tenant_default", {
      admin: true,
      createdAt: "2026-02-01 00:00:00",
    });
    const repo = await import("@server/repositories/pipeline-schedule");

    expect((await repo.findScheduleRunAsUser("tenant_default", null))?.id).toBe(
      "first-admin",
    );

    await repo.recordScheduleSaved({
      tenantId: "tenant_default",
      userId: "second-admin",
      now: "2026-11-17T00:00:00.000Z",
    });
    expect(
      (await repo.findScheduleRunAsUser("tenant_default", "second-admin"))?.id,
    ).toBe("second-admin");

    const { db, schema } = await import("@server/db");
    const { eq } = await import("drizzle-orm");
    await db
      .update(schema.users)
      .set({ isDisabled: true })
      .where(eq(schema.users.id, "second-admin"));
    expect(
      (await repo.findScheduleRunAsUser("tenant_default", "second-admin"))?.id,
    ).toBe("first-admin");

    // A user from another workspace is never picked.
    await createUser("outsider", "tenant_other", { admin: true });
    expect(
      (await repo.findScheduleRunAsUser("tenant_default", "outsider"))?.id,
    ).toBe("first-admin");
  });

  it("records a skip when the workspace has no active user", async () => {
    await createUser("gone", "tenant_default", { disabled: true });
    await configureSchedule("tenant_default", {});
    const { runScheduleTick } = await scheduler();
    const startRun = vi.fn(async () => undefined);
    const results = await runScheduleTick({
      now: () => new Date("2026-11-17T01:00:10.000Z"),
      startRun,
    });
    expect(results.tenant_default).toMatchObject({
      status: "skipped_no_user",
    });
    expect(startRun).not.toHaveBeenCalled();
  });

  it("uses the chosen saved search and ignores disabled schedules", async () => {
    await createUser("owner", "tenant_default", { admin: true });
    const chosen = await savePreset("tenant_default", "owner", "Chosen", {
      ...PRESET_CONFIG,
      searchTerms: ["backend engineer"],
      locationMode: "radius",
    });
    // A more recently saved search with a field the chosen one leaves out.
    await savePreset("tenant_default", "owner", "Recent", {
      ...PRESET_CONFIG,
      watchlistSelectedSourceIds: ["watch-1"],
    });
    await configureSchedule("tenant_default", {
      scheduleSearchPresetId: chosen,
    });
    const { runScheduleTick } = await scheduler();
    const startRun = vi.fn(async () => undefined);
    await runScheduleTick({
      now: () => new Date("2026-11-17T01:00:10.000Z"),
      startRun,
    });
    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        configResolved: true,
        config: expect.objectContaining({
          searchTerms: ["backend engineer"],
          proximity: { latitude: -6.2, longitude: 106.8, radiusMiles: 20 },
        }),
      }),
    );
    // Nothing comes from the other saved search.
    const [{ config }] = startRun.mock.calls[0] as unknown as [
      { config: Record<string, unknown> },
    ];
    expect(config.watchlistSelectedSourceIds).toBeUndefined();

    await configureSchedule("tenant_default", { scheduleEnabled: "0" });
    expect(
      await runScheduleTick({
        now: () => new Date("2026-11-18T01:00:10.000Z"),
        startRun,
      }),
    ).toEqual({});
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  it("does not run twice on one local day when the time is moved later", async () => {
    await createUser("owner", "tenant_default", { admin: true });
    await savePreset("tenant_default", "owner");
    await configureSchedule("tenant_default", { scheduleTime: "06:30" });
    const { runScheduleTick, getPipelineScheduleStatus } = await scheduler();
    const repo = await import("@server/repositories/pipeline-schedule");
    const startRun = vi.fn(async () => undefined);
    const time = clock("2026-11-16T23:30:05.000Z"); // 06:30 in Jakarta

    await runScheduleTick({ now: time.now, startRun });
    expect(startRun).toHaveBeenCalledTimes(1);

    // At 06:45 the owner moves the schedule to 07:00.
    await configureSchedule("tenant_default", { scheduleTime: "07:00" });
    await repo.recordScheduleSaved({
      tenantId: "tenant_default",
      userId: "owner",
      now: "2026-11-16T23:45:00.000Z",
    });
    time.set("2026-11-17T00:00:05.000Z"); // 07:00
    expect(
      (await runScheduleTick({ now: time.now, startRun })).tenant_default,
    ).toEqual({ status: "not_due" });
    expect(startRun).toHaveBeenCalledTimes(1);
    const status = await inTenant("tenant_default", "owner", () =>
      getPipelineScheduleStatus(time.now()),
    );
    expect(status.nextRunAt).toBe("2026-11-18T00:00:00.000Z");

    time.set("2026-11-18T00:00:05.000Z");
    expect(
      (await runScheduleTick({ now: time.now, startRun })).tenant_default,
    ).toMatchObject({ status: "started" });
    expect(startRun).toHaveBeenCalledTimes(2);
  });

  it("does not start a run right away when the schedule is turned on late", async () => {
    await createUser("owner", "tenant_default", { admin: true });
    await savePreset("tenant_default", "owner");
    await configureSchedule("tenant_default", {});
    const repo = await import("@server/repositories/pipeline-schedule");
    // Turned on at 08:05, inside the catch-up window after 08:00.
    await repo.recordScheduleSaved({
      tenantId: "tenant_default",
      userId: "owner",
      now: "2026-11-17T01:05:00.000Z",
    });
    const { runScheduleTick } = await scheduler();
    const startRun = vi.fn(async () => undefined);
    expect(
      (
        await runScheduleTick({
          now: () => new Date("2026-11-17T01:05:30.000Z"),
          startRun,
        })
      ).tenant_default,
    ).toEqual({ status: "not_due" });
    expect(startRun).not.toHaveBeenCalled();
    expect(await stateOf("tenant_default")).toMatchObject({
      ownerUserId: "owner",
      settingsSavedAt: "2026-11-17T01:05:00.000Z",
    });
  });

  it("does not start in hosted or demo mode", async () => {
    process.env.JOBOPS_APP_MODE = "hosted";
    process.env.JOBOPS_HOSTED_TENANT_ID = "tenant_default";
    const { startPipelineScheduler, getScheduleUnavailableReason } =
      await scheduler();
    expect(getScheduleUnavailableReason()).toMatch(/hosted/);
    const now = vi.fn(() => new Date("2026-11-17T01:00:10.000Z"));
    const handle = startPipelineScheduler({ now, startRun: vi.fn() });
    handle.stop();
    expect(now).not.toHaveBeenCalled();

    delete process.env.JOBOPS_APP_MODE;
    process.env.DEMO_MODE = "true";
    expect(getScheduleUnavailableReason()).toMatch(/demo/);
  });
});
