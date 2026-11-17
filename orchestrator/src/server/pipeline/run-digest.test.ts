import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../repositories/pipeline", () => ({
  createPipelineRun: vi.fn(async () => ({
    id: "run-digest-1",
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: "running",
    jobsDiscovered: 0,
    jobsProcessed: 0,
    errorMessage: null,
  })),
  updatePipelineRun: vi.fn(async () => undefined),
}));

const scoreJobsStep = vi.fn();
const importJobsStep = vi.fn();

vi.mock("./steps", () => ({
  loadProfileStep: vi.fn(async () => ({})),
  discoverJobsStep: vi.fn(async () => ({
    discoveredJobs: [
      { source: "linkedin", title: "A", employer: "Grab", jobUrl: "u1" },
      { source: "linkedin", title: "B", employer: "GoTo", jobUrl: "u2" },
      { source: "linkedin", title: "C", employer: "Acme", jobUrl: "u3" },
    ],
    sourceErrors: [],
    pendingChallenges: [],
  })),
  importJobsStep,
  scoreJobsStep,
  selectJobsStep: vi.fn(() => []),
  processJobsStep: vi.fn(async () => ({ processedCount: 1 })),
  notifyPipelineWebhookStep: vi.fn(async () => undefined),
}));

const queueRunDigest = vi.fn();
vi.mock("../services/run-digest", () => ({ queueRunDigest }));

describe.sequential("pipeline run digest hooks", () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), "job-ops-pipeline-digest-"));
    process.env.DATA_DIR = tempDir;
    process.env.NODE_ENV = "test";
    importJobsStep.mockResolvedValue({
      created: 2,
      skipped: 1,
      fuzzyMerged: 0,
      createdJobIds: ["job-new-1", "job-new-2"],
    });

    await import("../db/migrate");
  });

  afterEach(async () => {
    const { closeDb } = await import("../db/index");
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("stores the trigger and sends the run's new jobs when it finishes", async () => {
    scoreJobsStep.mockResolvedValueOnce({
      unprocessedJobs: [],
      scoredJobs: [{ id: "job-new-1" }, { id: "job-new-2" }],
    });
    const pipeline = await import("./orchestrator");
    const pipelineRepo = await import("../repositories/pipeline");

    const result = await pipeline.runPipeline({}, { trigger: "schedule" });

    expect(result.success).toBe(true);
    expect(vi.mocked(pipelineRepo.createPipelineRun)).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "schedule" }),
    );
    expect(queueRunDigest).toHaveBeenCalledTimes(1);
    expect(queueRunDigest).toHaveBeenCalledWith({
      kind: "completed",
      pipelineRunId: "run-digest-1",
      trigger: "schedule",
      jobsFound: 3,
      newJobIds: ["job-new-1", "job-new-2"],
      jobsScored: 2,
      jobsTailored: 1,
    });
  });

  it("keeps defaults for fields passed as undefined", async () => {
    scoreJobsStep.mockResolvedValueOnce({
      unprocessedJobs: [],
      scoredJobs: [],
    });
    const pipeline = await import("./orchestrator");
    const steps = await import("./steps");

    await pipeline.runPipeline({
      topN: undefined,
      sources: undefined,
      minSuitabilityScore: undefined,
    });

    const [args] = vi.mocked(steps.discoverJobsStep).mock.calls[0];
    expect(args.mergedConfig.topN).toBe(10);
    expect(args.mergedConfig.minSuitabilityScore).toBe(50);
    expect(Array.isArray(args.mergedConfig.sources)).toBe(true);
    expect(args.mergedConfig.sources.length).toBeGreaterThan(0);
  });

  it("sends a failure notice when the run fails", async () => {
    scoreJobsStep.mockRejectedValueOnce(new Error("Scoring service exploded"));
    const pipeline = await import("./orchestrator");

    const result = await pipeline.runPipeline({}, { trigger: "schedule" });

    expect(result.success).toBe(false);
    expect(queueRunDigest).toHaveBeenCalledWith({
      kind: "failed",
      pipelineRunId: "run-digest-1",
      trigger: "schedule",
      error: "Scoring service exploded",
    });
  });

  it("tells the owner once when the run pauses for a missing model", async () => {
    const { LlmNotConfiguredError } = await import("../services/scorer");
    scoreJobsStep
      .mockRejectedValueOnce(new LlmNotConfiguredError("No API key"))
      .mockRejectedValueOnce(new LlmNotConfiguredError("No API key"))
      .mockResolvedValueOnce({ unprocessedJobs: [], scoredJobs: [] });
    const pipeline = await import("./orchestrator");
    const { getProgress } = await import("./progress");

    const runPromise = pipeline.runPipeline({}, { trigger: "schedule" });
    await vi.waitFor(() => {
      expect(getProgress().step).toBe("configuration_required");
    });
    expect(queueRunDigest).toHaveBeenCalledWith({
      kind: "paused",
      pipelineRunId: "run-digest-1",
      trigger: "schedule",
      reason: "configuration",
      sources: undefined,
    });
    pipeline.resumePipelineScoring();
    await vi.waitFor(() => {
      expect(scoreJobsStep).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => {
      expect(getProgress().step).toBe("configuration_required");
    });
    pipeline.resumePipelineScoring();
    await runPromise;

    const pauses = queueRunDigest.mock.calls.filter(
      ([event]) => event.kind === "paused",
    );
    expect(pauses).toHaveLength(1);
  });
});
