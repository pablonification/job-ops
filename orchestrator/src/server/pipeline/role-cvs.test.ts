import { createJob } from "@shared/testing/factories.js";
import type { Job } from "@shared/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as jobsRepo from "../repositories/jobs";
import * as roleCvsRepo from "../repositories/role-cvs";
import * as settingsRepo from "../repositories/settings";
import { generatePdf } from "../services/pdf";
import { pickRoleCvForJob } from "../services/role-cv-matching";
import { generateTailoring } from "../services/summary";
import { processJob } from "./orchestrator";

vi.mock("@infra/logger", () => {
  const logger = {
    child: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return { logger };
});

vi.mock("@infra/product-analytics", () => ({
  trackServerProductEvent: vi.fn(),
}));

vi.mock("../repositories/jobs", () => ({
  getJobById: vi.fn(),
  updateJob: vi.fn(),
  finalizeGeneratedPdfIfCurrent: vi.fn(),
}));

vi.mock("../repositories/role-cvs", () => ({
  listRoleCvRows: vi.fn(),
  getRoleCvRowById: vi.fn(),
}));

vi.mock("../repositories/pipeline", () => ({
  createPipelineRun: vi.fn(),
  updatePipelineRun: vi.fn(),
}));

vi.mock("../repositories/settings", () => ({
  getSetting: vi.fn(),
  getAllSettings: vi.fn(),
}));

vi.mock("../services/pdf", () => ({
  generatePdf: vi.fn(),
}));

vi.mock("../services/pdf-fingerprint", () => ({
  createJobPdfFingerprint: vi.fn(() => "fingerprint"),
  resolvePdfFingerprintContext: vi.fn(async () => ({ pdfRenderer: "typst" })),
}));

vi.mock("../services/profile", () => ({
  getProfile: vi.fn(async () => ({})),
}));

vi.mock("../services/projectSelection", () => ({
  pickProjectIdsForJob: vi.fn(async () => []),
}));

vi.mock("../services/role-cv-matching", () => ({
  pickRoleCvForJob: vi.fn(),
}));

vi.mock("../services/summary", () => ({
  generateTailoring: vi.fn(),
}));

vi.mock("./steps", () => ({
  discoverJobsStep: vi.fn(),
  importJobsStep: vi.fn(),
  loadProfileStep: vi.fn(),
  notifyPipelineWebhookStep: vi.fn(),
  processJobsStep: vi.fn(),
  scoreJobsStep: vi.fn(),
  selectJobsStep: vi.fn(),
}));

const roleCvRow = {
  id: "cv-1",
  name: "Backend Engineer",
  roleDescription: "Go and payments",
  tailoredHeadline: "Backend Engineer",
  tailoredSummary: "Role CV summary.",
  tailoredSkills: JSON.stringify([{ name: "Backend", keywords: ["Go"] }]),
  selectedProjectIds: "payments",
};

let job: Job;
let roleCvSetting: string | null;

function updateCalls(): Array<Record<string, unknown>> {
  return vi
    .mocked(jobsRepo.updateJob)
    .mock.calls.map(([, input]) => input as Record<string, unknown>);
}

describe("processJob with Role CVs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    job = createJob({
      id: "job-1",
      title: "Backend Engineer",
      jobDescription: "Build payment APIs in Go.",
      status: "discovered",
      tailoredSummary: null,
      tailoredHeadline: null,
      tailoredSkills: null,
    });
    roleCvSetting = null;

    vi.mocked(jobsRepo.getJobById).mockImplementation(async () => ({
      ...job,
    }));
    vi.mocked(jobsRepo.updateJob).mockImplementation(async (_id, input) => {
      job = { ...job, ...(input as Partial<Job>) };
      return { ...job };
    });
    vi.mocked(jobsRepo.finalizeGeneratedPdfIfCurrent).mockImplementation(
      async () => ({ ...job, status: "ready" }),
    );
    vi.mocked(settingsRepo.getSetting).mockImplementation(async (key) =>
      key === "roleCvPipelineMode" ? roleCvSetting : null,
    );
    vi.mocked(roleCvsRepo.listRoleCvRows).mockResolvedValue([
      roleCvRow,
    ] as never);
    vi.mocked(roleCvsRepo.getRoleCvRowById).mockImplementation(async (id) =>
      id === roleCvRow.id ? (roleCvRow as never) : null,
    );
    vi.mocked(pickRoleCvForJob).mockResolvedValue({
      roleCvId: "cv-1",
      method: "model",
    });
    vi.mocked(generateTailoring).mockResolvedValue({
      success: true,
      data: {
        headline: "Senior Backend Engineer",
        summary: "Job summary.",
        skills: [{ name: "Backend", keywords: ["Go", "Kafka"] }],
      },
    });
    vi.mocked(generatePdf).mockResolvedValue({
      success: true,
      pdfPath: "/tmp/resume_job-1.pdf",
    });
  });

  it("tailors exactly as before when the user has no Role CVs", async () => {
    vi.mocked(roleCvsRepo.listRoleCvRows).mockResolvedValue([]);

    await expect(processJob("job-1")).resolves.toEqual({ success: true });

    expect(pickRoleCvForJob).not.toHaveBeenCalled();
    expect(vi.mocked(generateTailoring).mock.calls[0]).toEqual([
      "Build payment APIs in Go.",
      {},
    ]);
    expect(updateCalls().some((input) => "roleCvId" in input)).toBe(false);
    expect(job.tailoredSummary).toBe("Job summary.");
  });

  it("refines from the auto-matched Role CV by default", async () => {
    await expect(processJob("job-1")).resolves.toEqual({ success: true });

    expect(pickRoleCvForJob).toHaveBeenCalledTimes(1);
    expect(updateCalls()).toContainEqual({
      roleCvId: "cv-1",
      roleCvMatchSource: "auto",
    });
    expect(generateTailoring).toHaveBeenCalledWith(
      "Build payment APIs in Go.",
      {},
      {
        baseline: {
          headline: "Backend Engineer",
          summary: "Role CV summary.",
          skills: [{ name: "Backend", keywords: ["Go"] }],
        },
      },
    );
    expect(job.tailoredSummary).toBe("Job summary.");
  });

  it("copies the Role CV without a model call in as-is mode", async () => {
    roleCvSetting = "as_is";

    await expect(processJob("job-1")).resolves.toEqual({ success: true });

    expect(generateTailoring).not.toHaveBeenCalled();
    expect(job).toMatchObject({
      roleCvId: "cv-1",
      roleCvMatchSource: "auto",
      tailoredHeadline: "Backend Engineer",
      tailoredSummary: "Role CV summary.",
      tailoredSkills: JSON.stringify([{ name: "Backend", keywords: ["Go"] }]),
      selectedProjectIds: "payments",
    });
    expect(vi.mocked(generatePdf).mock.calls[0]?.[1]).toEqual({
      headline: "Backend Engineer",
      summary: "Role CV summary.",
      skills: [{ name: "Backend", keywords: ["Go"] }],
    });
  });

  it("ignores Role CVs when the setting is off", async () => {
    roleCvSetting = "off";

    await expect(processJob("job-1")).resolves.toEqual({ success: true });

    expect(roleCvsRepo.listRoleCvRows).not.toHaveBeenCalled();
    expect(pickRoleCvForJob).not.toHaveBeenCalled();
    expect(vi.mocked(generateTailoring).mock.calls[0]).toHaveLength(2);
  });

  it("uses a manually chosen Role CV without matching", async () => {
    job = { ...job, roleCvId: "cv-1", roleCvMatchSource: "manual" };

    await expect(processJob("job-1")).resolves.toEqual({ success: true });

    expect(pickRoleCvForJob).not.toHaveBeenCalled();
    expect(vi.mocked(generateTailoring).mock.calls[0]?.[2]).toMatchObject({
      baseline: { summary: "Role CV summary." },
    });
    expect(job.roleCvMatchSource).toBe("manual");
  });

  it("records an auto 'none' and tailors as before when nothing fits", async () => {
    vi.mocked(pickRoleCvForJob).mockResolvedValue({
      roleCvId: null,
      method: "model",
    });

    await expect(processJob("job-1")).resolves.toEqual({ success: true });

    expect(job).toMatchObject({ roleCvId: null, roleCvMatchSource: "auto" });
    expect(vi.mocked(generateTailoring).mock.calls[0]).toHaveLength(2);
  });

  it("keeps existing tailoring untouched unless forced", async () => {
    job = {
      ...job,
      tailoredSummary: "Hand-written summary.",
      tailoredHeadline: "Hand-written headline",
    };

    await expect(processJob("job-1")).resolves.toEqual({ success: true });

    expect(roleCvsRepo.listRoleCvRows).not.toHaveBeenCalled();
    expect(generateTailoring).not.toHaveBeenCalled();
    expect(job.tailoredSummary).toBe("Hand-written summary.");
  });

  it("tailors as before when the Role CV step fails", async () => {
    vi.mocked(roleCvsRepo.listRoleCvRows).mockRejectedValue(
      new Error("database is locked"),
    );

    await expect(processJob("job-1")).resolves.toEqual({ success: true });

    expect(vi.mocked(generateTailoring).mock.calls[0]).toHaveLength(2);
  });
});
