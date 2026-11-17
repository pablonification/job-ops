import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The scheduler with the real `startPipelineRun` and the real pipeline
 * single-flight guard: a run is genuinely active (its discovery step is
 * held open) when the schedule comes due. Only the pipeline's steps, the
 * extractor registry and analytics are replaced; no job site is called.
 */
const discoverJobsStep = vi.fn();

vi.mock("@server/pipeline/steps", () => ({
  loadProfileStep: vi.fn(async () => ({})),
  discoverJobsStep,
  importJobsStep: vi.fn(async () => ({
    created: 0,
    skipped: 0,
    fuzzyMerged: 0,
    createdJobIds: [],
  })),
  scoreJobsStep: vi.fn(async () => ({ unprocessedJobs: [], scoredJobs: [] })),
  selectJobsStep: vi.fn(() => []),
  processJobsStep: vi.fn(async () => ({ processedCount: 0 })),
  notifyPipelineWebhookStep: vi.fn(async () => undefined),
}));

vi.mock("@server/extractors/registry", async () => {
  const { normalizeLocationSourceCapabilities } = await import(
    "@shared/location-domain.js"
  );
  const manifest = {
    id: "test-linkedin",
    displayName: "Test LinkedIn",
    providesSources: ["linkedin"],
    run: vi.fn(),
  };
  const registry = {
    manifests: new Map([[manifest.id, manifest]]),
    manifestBySource: new Map([["linkedin", manifest]]),
    availableSources: ["linkedin"],
    locationCapabilitiesBySource: {
      linkedin: normalizeLocationSourceCapabilities({ source: "linkedin" }),
    },
  };
  return {
    getExtractorRegistry: vi.fn(async () => registry),
    initializeExtractorRegistry: vi.fn(async () => registry),
  };
});

vi.mock("@server/services/activation-funnel", () => ({
  trackCanonicalActivationEvent: vi.fn(async () => true),
}));

const EMPTY_DISCOVERY = {
  discoveredJobs: [],
  sourceErrors: [],
  pendingChallenges: [],
};

const PRESET_CONFIG = {
  searchTerms: ["backend engineer"],
  sources: ["linkedin"],
  country: "united kingdom",
  cityLocations: ["London"],
  workplaceTypes: ["remote", "hybrid"],
  searchScope: "selected_only",
  matchStrictness: "exact_only",
  topN: 5,
  minSuitabilityScore: 60,
  runBudget: 500,
  scoringInstructions: "",
};

describe.sequential("scheduler and the real single-flight guard", () => {
  const originalEnv = { ...process.env };
  let tempDir: string;
  let closeDb: (() => void) | null = null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-schedule-flight-"));
    vi.resetModules();
    discoverJobsStep.mockReset();
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

    const { db, schema } = await import("@server/db");
    await db
      .insert(schema.users)
      .values({ id: "owner", username: "owner", isSystemAdmin: true });
    await db.insert(schema.tenantMemberships).values({
      id: "membership-owner",
      userId: "owner",
      tenantId: "tenant_default",
      role: "owner",
    });
  });

  afterEach(async () => {
    closeDb?.();
    closeDb = null;
    process.env = { ...originalEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  async function asOwner<T>(fn: () => Promise<T>): Promise<T> {
    const { runWithRequestContext } = await import("@infra/request-context");
    return runWithRequestContext(
      {
        requestId: "test",
        tenantId: "tenant_default",
        userId: "owner",
        username: "owner",
        isSystemAdmin: true,
      },
      fn,
    );
  }

  async function savePreset(
    name: string,
    config: Record<string, unknown>,
  ): Promise<string> {
    const presets = await import(
      "@server/repositories/pipeline-search-presets"
    );
    return asOwner(
      async () =>
        (
          await presets.createPipelineSearchPreset({
            name,
            config: config as never,
          })
        ).id,
    );
  }

  async function enableSchedule(values: Record<string, string> = {}) {
    const settingsRepo = await import("@server/repositories/settings");
    await asOwner(async () => {
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

  async function waitUntilIdle() {
    const pipeline = await import("@server/pipeline/index");
    await vi.waitFor(async () => {
      expect(await asOwner(async () => pipeline.getPipelineStatus())).toEqual(
        expect.objectContaining({ isRunning: false }),
      );
    });
  }

  it("records a skip when a real run is already active", async () => {
    await savePreset("UK backend", PRESET_CONFIG);
    await enableSchedule();
    const { startPipelineRun } = await import("../pipeline-run");
    const { runScheduleTick } = await import("./index");
    const pipeline = await import("@server/pipeline/index");

    let release: (value: typeof EMPTY_DISCOVERY) => void = () => {};
    discoverJobsStep.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    // A run the owner started by hand, held in discovery.
    await asOwner(() => startPipelineRun({ config: {}, trigger: "user" }));
    await vi.waitFor(() => expect(discoverJobsStep).toHaveBeenCalledTimes(1));
    expect(
      await asOwner(async () => pipeline.getPipelineStatus().isRunning),
    ).toBe(true);

    const results = await runScheduleTick({
      now: () => new Date("2026-11-17T01:00:05.000Z"),
      startRun: startPipelineRun,
    });
    expect(results.tenant_default).toEqual({
      status: "skipped_active",
      occurrence: "2026-11-17T01:00:00.000Z",
      detail: "A run was already active.",
    });
    // The scheduled run did not start a second discovery.
    expect(discoverJobsStep).toHaveBeenCalledTimes(1);

    release(EMPTY_DISCOVERY);
    await waitUntilIdle();
  });

  it("runs the chosen saved search as is, with nothing from another one", async () => {
    const chosen = await savePreset("Chosen", PRESET_CONFIG);
    // More recently saved, with a Watchlist filter the chosen one leaves out.
    await savePreset("Recent", {
      ...PRESET_CONFIG,
      watchlistSelectedSourceIds: ["watch-1"],
    });
    await enableSchedule({ scheduleSearchPresetId: chosen });
    discoverJobsStep.mockResolvedValue(EMPTY_DISCOVERY);
    const { startPipelineRun } = await import("../pipeline-run");
    const { runScheduleTick } = await import("./index");

    const results = await runScheduleTick({
      now: () => new Date("2026-11-17T01:00:05.000Z"),
      startRun: startPipelineRun,
    });
    expect(results.tenant_default).toMatchObject({ status: "started" });
    await vi.waitFor(() => expect(discoverJobsStep).toHaveBeenCalledTimes(1));
    const [{ mergedConfig }] = discoverJobsStep.mock.calls[0] as [
      { mergedConfig: Record<string, unknown> },
    ];
    expect(mergedConfig.sources).toEqual(["linkedin"]);
    expect(mergedConfig.topN).toBe(5);
    expect(mergedConfig.watchlistSelectedSourceIds).toBeUndefined();
    await waitUntilIdle();

    const pipelineRepo = await import("@server/repositories/pipeline");
    const run = await asOwner(() =>
      pipelineRepo.getLatestPipelineRunByTrigger("schedule"),
    );
    expect(run).toMatchObject({ trigger: "schedule", status: "completed" });
  });
});
