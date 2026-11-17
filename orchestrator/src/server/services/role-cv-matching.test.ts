import { beforeEach, describe, expect, it, vi } from "vitest";

const callJsonMock = vi.fn();
const settingsMocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  getEffectiveSettings: vi.fn(),
}));
const demoState = vi.hoisted(() => ({ demo: false }));

vi.mock("@server/repositories/settings", () => settingsMocks);
vi.mock("@server/services/settings", () => ({
  getEffectiveSettings: settingsMocks.getEffectiveSettings,
}));
vi.mock("@server/services/llm/service", () => ({
  LlmService: class {
    callJson = callJsonMock;
    getProvider = () => "openrouter";
    getBaseUrl = () => "https://openrouter.ai";
  },
}));
vi.mock("@server/config/demo", () => ({
  isDemoMode: () => demoState.demo,
}));

import {
  fallbackPickRoleCvId,
  pickRoleCvForJob,
  type RoleCvMatchCandidate,
} from "./role-cv-matching";

const backend: RoleCvMatchCandidate = {
  id: "cv-backend",
  name: "Backend Engineer",
  roleDescription: "Go services, PostgreSQL, Kubernetes and payment APIs.",
  tailoredHeadline: "Backend Engineer",
  tailoredSkills: JSON.stringify([
    { name: "Backend", keywords: ["Go", "PostgreSQL", "Kafka"] },
  ]),
};

const data: RoleCvMatchCandidate = {
  id: "cv-data",
  name: "Data Analyst",
  roleDescription: "SQL, dashboards, Looker and product analytics.",
  tailoredHeadline: "Data Analyst",
  tailoredSkills: JSON.stringify([
    { name: "Analytics", keywords: ["SQL", "Looker", "Python"] },
  ]),
};

const backendJob = {
  title: "Senior Backend Engineer",
  jobDescription:
    "<p>Build payment APIs in <strong>Go</strong> on Kubernetes with PostgreSQL and Kafka.</p>",
};

describe("pickRoleCvForJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    demoState.demo = false;
    settingsMocks.getSetting.mockResolvedValue(null);
    settingsMocks.getEffectiveSettings.mockResolvedValue({
      model: { value: "gpt-4o-mini" },
      llmProvider: { value: "openrouter" },
      llmBaseUrl: { value: null },
      llmPurposeOverrides: { value: {} },
      modelProjectSelection: { value: null },
    });
  });

  it("returns the Role CV the model picks and sends only matching context", async () => {
    callJsonMock.mockResolvedValue({
      success: true,
      data: { roleCvId: "cv-data" },
    });

    const result = await pickRoleCvForJob({
      job: backendJob,
      roleCvs: [backend, data],
    });

    expect(result).toEqual({ roleCvId: "cv-data", method: "model" });
    expect(callJsonMock).toHaveBeenCalledTimes(1);
    const request = callJsonMock.mock.calls[0]?.[0];
    expect(request.jsonSchema.name).toBe("role_cv_match");
    const prompt = request.messages[0].content as string;
    expect(prompt).toContain("Senior Backend Engineer");
    expect(prompt).toContain("Build payment APIs in Go");
    expect(prompt).not.toContain("<strong>");
    expect(prompt).toContain('"id":"cv-backend"');
    expect(prompt).toContain('"id":"cv-data"');
  });

  it('returns none when the model answers "none"', async () => {
    callJsonMock.mockResolvedValue({
      success: true,
      data: { roleCvId: "none" },
    });

    await expect(
      pickRoleCvForJob({ job: backendJob, roleCvs: [backend, data] }),
    ).resolves.toEqual({ roleCvId: null, method: "model" });
  });

  it("falls back to keyword scoring when the model call fails", async () => {
    callJsonMock.mockResolvedValue({ success: false, error: "rate limited" });

    await expect(
      pickRoleCvForJob({ job: backendJob, roleCvs: [data, backend] }),
    ).resolves.toEqual({ roleCvId: "cv-backend", method: "fallback" });
  });

  it("falls back to keyword scoring when the model throws", async () => {
    callJsonMock.mockRejectedValue(new Error("network down"));

    await expect(
      pickRoleCvForJob({ job: backendJob, roleCvs: [data, backend] }),
    ).resolves.toEqual({ roleCvId: "cv-backend", method: "fallback" });
  });

  it("falls back when the model returns an id that is not a candidate", async () => {
    callJsonMock.mockResolvedValue({
      success: true,
      data: { roleCvId: "someone-elses-cv" },
    });

    await expect(
      pickRoleCvForJob({ job: backendJob, roleCvs: [data, backend] }),
    ).resolves.toEqual({ roleCvId: "cv-backend", method: "fallback" });
  });

  it("never calls the model in demo mode or without Role CVs", async () => {
    demoState.demo = true;
    await expect(
      pickRoleCvForJob({ job: backendJob, roleCvs: [data, backend] }),
    ).resolves.toEqual({ roleCvId: "cv-backend", method: "fallback" });

    demoState.demo = false;
    await expect(
      pickRoleCvForJob({ job: backendJob, roleCvs: [] }),
    ).resolves.toEqual({ roleCvId: null, method: "fallback" });
    expect(callJsonMock).not.toHaveBeenCalled();
  });
});

describe("fallbackPickRoleCvId", () => {
  it("returns none when no Role CV shares enough keywords with the job", () => {
    expect(
      fallbackPickRoleCvId(
        {
          title: "Pastry Chef",
          jobDescription: "Bake croissants and manage the morning bakery.",
        },
        [backend, data],
      ),
    ).toBeNull();
  });

  it("is deterministic and weighs title words", () => {
    const job = {
      title: "Data Analyst",
      jobDescription: "Use SQL and Python to build dashboards.",
    };
    expect(fallbackPickRoleCvId(job, [backend, data])).toBe("cv-data");
    expect(fallbackPickRoleCvId(job, [data, backend])).toBe("cv-data");
  });
});
