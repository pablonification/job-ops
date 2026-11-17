import type { ResumeProfile } from "@shared/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const callJsonMock = vi.fn();
const settingsMocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  getEffectiveSettings: vi.fn(),
}));
const demoState = vi.hoisted(() => ({ demo: false }));
const repoMocks = vi.hoisted(() => ({
  getRoleCvRowById: vi.fn(),
  updateRoleCvRow: vi.fn(),
}));

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
vi.mock("@server/repositories/role-cvs", () => repoMocks);
vi.mock("./design-resume", () => ({
  getCurrentDesignResumeOrNullOnLegacy: vi.fn().mockResolvedValue({
    id: "design-1",
    revision: 4,
    updatedAt: "2026-11-01T00:00:00.000Z",
  }),
}));
vi.mock("./rxresume/baseResumeId", () => ({
  getConfiguredRxResumeBaseResumeId: vi
    .fn()
    .mockResolvedValue({ resumeId: null }),
}));
vi.mock("./pdf", () => ({ generatePdf: vi.fn() }));
vi.mock("./pdf-fingerprint", () => ({
  createJobPdfFingerprint: vi.fn(() => "fingerprint"),
  resolvePdfFingerprintContext: vi.fn().mockResolvedValue({}),
}));
vi.mock("./hosted-usage", () => ({
  withHostedUsageReservation: vi.fn(
    async (_args: unknown, work: () => Promise<{ result: unknown }>) =>
      (await work()).result,
  ),
}));
vi.mock("./profile", () => ({ getProfile: vi.fn() }));
vi.mock("./writing-style", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./writing-style")>();
  return {
    ...actual,
    getWritingStyle: vi.fn().mockResolvedValue({
      tone: "professional",
      formality: "medium",
      constraints: "",
      doNotUse: "",
      languageMode: "manual",
      manualLanguage: "english",
      summaryMaxWords: null,
      maxKeywordsPerSkill: null,
    }),
  };
});

import { generateRoleCv, generateRoleCvTailoring } from "./role-cvs";

const profile: ResumeProfile = {
  basics: { name: "Test User", label: "Engineer", summary: "Builds things" },
  sections: {
    skills: {
      items: [
        {
          id: "skill-1",
          name: "Backend",
          description: "",
          level: 3,
          keywords: ["Go", "Postgres"],
          visible: true,
        },
      ],
    },
    projects: {
      items: ["payments", "search", "game"].map((id) => ({
        id,
        name: `${id} project`,
        description: `${id} description`,
        summary: `${id} summary`,
        date: "2026",
        visible: true,
      })),
    },
  },
};

function mockModelResponses() {
  callJsonMock.mockImplementation(
    async (request: { jsonSchema: { name: string } }) => {
      if (request.jsonSchema.name === "project_selection") {
        return { success: true, data: { selectedProjectIds: ["payments"] } };
      }
      return {
        success: true,
        data: {
          headline: "Backend Engineer",
          summary: "Backend engineer focused on payments.",
          skills: [{ name: "Backend", keywords: ["Go", "PostgreSQL"] }],
        },
      };
    },
  );
}

describe("Role CV generation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    demoState.demo = false;
    settingsMocks.getEffectiveSettings.mockResolvedValue({
      model: { value: "default-model" },
      llmProvider: { value: "openrouter" },
      llmBaseUrl: { value: null },
      llmPurposeOverrides: { value: {} },
      modelTailoring: { value: "tailoring-model" },
      modelProjectSelection: { value: "projects-model" },
    });
    settingsMocks.getSetting.mockImplementation(async (key: string) =>
      key === "resumeProjects"
        ? JSON.stringify({
            maxProjects: 2,
            lockedProjectIds: ["game"],
            aiSelectableProjectIds: ["payments", "search"],
          })
        : null,
    );
    mockModelResponses();
  });

  it("generates tailoring from a role description with the Role CV prompt and the tailoring model", async () => {
    const content = await generateRoleCvTailoring({
      roleName: "Backend Engineer",
      roleDescription: "Build <b>payment</b> APIs in Go.",
      profile,
    });

    expect(content).toEqual({
      headline: "Backend Engineer",
      summary: "Backend engineer focused on payments.",
      skills: [{ name: "Backend", keywords: ["Go", "PostgreSQL"] }],
      selectedProjectIds: ["payments"],
    });

    const tailoringCall = callJsonMock.mock.calls.find(
      ([request]) => request.jsonSchema.name === "resume_tailoring",
    )?.[0];
    expect(tailoringCall.model).toBe("tailoring-model");
    const prompt = tailoringCall.messages[0].content as string;
    expect(prompt).toContain("reusable CV variant for a target role");
    expect(prompt).toContain("TARGET ROLE:\nBackend Engineer");
    expect(prompt).toContain("Build payment APIs in Go.");
    expect(prompt).not.toContain("{{roleDescription}}");

    const projectCall = callJsonMock.mock.calls.find(
      ([request]) => request.jsonSchema.name === "project_selection",
    )?.[0];
    expect(projectCall.model).toBe("projects-model");
    const projectPrompt = projectCall.messages[0].content as string;
    expect(projectPrompt).toContain("payment");
    // Locked projects are always included and never offered for selection.
    expect(projectPrompt).not.toContain("game project");
  });

  it("uses a customised Role CV prompt template from settings", async () => {
    settingsMocks.getSetting.mockImplementation(async (key: string) =>
      key === "roleCvPromptTemplate"
        ? "CUSTOM ROLE PROMPT for {{roleName}}: {{roleDescription}}"
        : null,
    );

    await generateRoleCvTailoring({
      roleName: "Data Analyst",
      roleDescription: "SQL dashboards",
      profile,
    });

    const tailoringCall = callJsonMock.mock.calls.find(
      ([request]) => request.jsonSchema.name === "resume_tailoring",
    )?.[0];
    expect(tailoringCall.messages[0].content).toBe(
      "CUSTOM ROLE PROMPT for Data Analyst: SQL dashboards",
    );
  });

  it("surfaces a model failure as an upstream error", async () => {
    callJsonMock.mockResolvedValue({ success: false, error: "rate limited" });

    await expect(
      generateRoleCvTailoring({
        roleName: "Backend Engineer",
        roleDescription: "Go APIs",
        profile,
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR", status: 502 });
  });

  it("does not call a model in demo mode", async () => {
    demoState.demo = true;

    const content = await generateRoleCvTailoring({
      roleName: "Backend Engineer",
      roleDescription: "Go APIs",
      profile,
    });

    expect(callJsonMock).not.toHaveBeenCalled();
    expect(content.headline).toBe("Backend Engineer");
    expect(content.skills).toEqual([
      { name: "Backend", keywords: ["Go", "Postgres"] },
    ]);
    expect(content.selectedProjectIds).toEqual(["payments"]);
  });

  it("stores generated content with the same encodings as job tailoring and the master resume revision", async () => {
    const { getProfile } = await import("./profile");
    vi.mocked(getProfile).mockResolvedValue(profile);
    const row = {
      id: "role-1",
      name: "Backend Engineer",
      roleDescription: "Go APIs",
      tailoredHeadline: null,
      tailoredSummary: null,
      tailoredSkills: null,
      selectedProjectIds: null,
      masterResumeRevision: null,
      generatedAt: null,
      pdfPath: null,
      pdfFingerprint: null,
      pdfGeneratedAt: null,
      pdfRegeneratingSince: null,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    };
    repoMocks.getRoleCvRowById.mockResolvedValue(row);
    repoMocks.updateRoleCvRow.mockImplementation(
      async (_id: string, update: Record<string, unknown>) => ({
        ...row,
        ...update,
      }),
    );

    const roleCv = await generateRoleCv("role-1");

    expect(repoMocks.updateRoleCvRow).toHaveBeenCalledWith(
      "role-1",
      expect.objectContaining({
        tailoredHeadline: "Backend Engineer",
        tailoredSummary: "Backend engineer focused on payments.",
        tailoredSkills: JSON.stringify([
          { name: "Backend", keywords: ["Go", "PostgreSQL"] },
        ]),
        selectedProjectIds: "payments",
        masterResumeRevision: "design:design-1:4:2026-11-01T00:00:00.000Z",
      }),
    );
    expect(roleCv.isStale).toBe(false);
    expect(roleCv.generatedAt).toEqual(expect.any(String));
  });

  it("refuses to generate without a role description", async () => {
    repoMocks.getRoleCvRowById.mockResolvedValue({
      id: "role-1",
      name: "Empty",
      roleDescription: "  ",
    });

    await expect(generateRoleCv("role-1")).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(callJsonMock).not.toHaveBeenCalled();
  });
});
