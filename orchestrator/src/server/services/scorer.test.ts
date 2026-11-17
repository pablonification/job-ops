/**
 * Tests for scorer.ts - focusing on robust JSON parsing from AI responses
 */

import { getDefaultPromptTemplate } from "@shared/prompt-template-definitions.js";
import { createJob } from "@shared/testing/factories";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getEffectiveSettingsMock,
  getSettingMock,
  resolveLlmModelMock,
  createConfiguredLlmServiceMock,
  callJsonMock,
} = vi.hoisted(() => ({
  getEffectiveSettingsMock: vi.fn(),
  getSettingMock: vi.fn(),
  resolveLlmModelMock: vi.fn(),
  createConfiguredLlmServiceMock: vi.fn(),
  callJsonMock: vi.fn(),
}));

vi.mock("./settings", () => ({
  getEffectiveSettings: getEffectiveSettingsMock,
}));

vi.mock("../repositories/settings", () => ({
  getSetting: getSettingMock,
}));

vi.mock("./modelSelection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./modelSelection")>();
  return {
    ...actual,
    resolveLlmModel: resolveLlmModelMock,
    createConfiguredLlmService: createConfiguredLlmServiceMock,
  };
});

import { parseJsonFromContent } from "./scorer";

describe("parseJsonFromContent", () => {
  describe("valid JSON inputs", () => {
    it("should parse clean JSON object", () => {
      const input = '{"score": 85, "reason": "Great match"}';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(85);
      expect(result.reason).toBe("Great match");
    });

    it("should parse JSON with extra whitespace", () => {
      const input = '  { "score" : 75 , "reason" : "Good fit" }  ';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(75);
      expect(result.reason).toBe("Good fit");
    });

    it("should parse JSON with newlines", () => {
      const input = `{
        "score": 90,
        "reason": "Excellent match for the role"
      }`;
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(90);
      expect(result.reason).toBe("Excellent match for the role");
    });
  });

  describe("markdown code fences", () => {
    it("should strip ```json code fences", () => {
      const input = '```json\n{"score": 80, "reason": "Match"}\n```';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(80);
    });

    it("should strip ```JSON code fences (uppercase)", () => {
      const input = '```JSON\n{"score": 80, "reason": "Match"}\n```';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(80);
    });

    it("should strip ``` code fences without language specifier", () => {
      const input = '```\n{"score": 70, "reason": "Decent"}\n```';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(70);
    });

    it("should handle nested code fence patterns", () => {
      const input =
        'Here is the score:\n```json\n{"score": 65, "reason": "Partial match"}\n```\nEnd.';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(65);
    });
  });

  describe("surrounding text", () => {
    it("should extract JSON from text before", () => {
      const input =
        'Based on my analysis, here is my evaluation: {"score": 55, "reason": "Limited match"}';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(55);
    });

    it("should extract JSON from text after", () => {
      const input =
        '{"score": 60, "reason": "Moderate match"} I hope this helps!';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(60);
    });

    it("should extract JSON from surrounding text on both sides", () => {
      const input =
        'Here is my response:\n\n{"score": 45, "reason": "Below average fit"}\n\nLet me know if you need more details.';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(45);
    });
  });

  describe("common JSON formatting issues", () => {
    it("should handle trailing comma before closing brace", () => {
      const input = '{"score": 78, "reason": "Good skills",}';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(78);
    });

    it("should handle single quotes instead of double quotes", () => {
      const input = "{'score': 82, 'reason': 'Strong candidate'}";
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(82);
    });

    it("should handle unquoted keys", () => {
      const input = '{score: 77, reason: "Reasonable match"}';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(77);
    });

    it("should handle mixed issues (trailing comma, single quotes)", () => {
      const input = "{'score': 68, 'reason': 'Average fit',}";
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(68);
    });
  });

  describe("decimal scores", () => {
    it("should parse and round decimal scores", () => {
      // parseJsonFromContent returns raw value for valid JSON; rounding only in regex fallback
      const input = '{"score": 85.7, "reason": "Very good match"}';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(85.7);
    });

    it("should parse decimal scores in malformed text", () => {
      const input = 'The score is score: 72.3, reason: "Above average"';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(72);
    });
  });

  describe("malformed responses - regex fallback", () => {
    it("should extract score from completely malformed response", () => {
      const input =
        'I think the score should be score: 50 and the reason: "Average candidate"';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(50);
    });

    it("should extract score with equals sign syntax", () => {
      const input = 'score = 88, reason = "Excellent match"';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(88);
    });

    it("should handle reason with special characters", () => {
      const input =
        '{"score": 73, "reason": "Good match! The candidate\'s skills align well."}';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(73);
    });

    it("should provide default reason when only score is extractable", () => {
      const input = "I rate this candidate 85 out of 100 - score: 85";
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(85);
      expect(result.reason).toBeDefined();
    });
  });

  describe("edge cases", () => {
    it("should handle zero score", () => {
      const input = '{"score": 0, "reason": "No match at all"}';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(0);
    });

    it("should handle score of 100", () => {
      const input = '{"score": 100, "reason": "Perfect candidate"}';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(100);
    });

    it("should handle empty reason", () => {
      const input = '{"score": 50, "reason": ""}';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(50);
      expect(result.reason).toBe("");
    });

    it("should handle multiline reason", () => {
      const input = `{"score": 70, "reason": "Good skills match. Experience is a bit lacking."}`;
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(70);
      expect(result.reason).toContain("Good skills match");
    });

    it("should handle unicode in reason", () => {
      const input = '{"score": 80, "reason": "Great match ✓ for this role"}';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(80);
    });
  });

  describe("failure cases", () => {
    it("should throw when no score can be extracted", () => {
      const input = "This is just plain text with no JSON or score.";
      expect(() => parseJsonFromContent(input)).toThrow(
        "Unable to parse JSON from model response",
      );
    });

    it("should throw for empty input", () => {
      expect(() => parseJsonFromContent("")).toThrow(
        "Unable to parse JSON from model response",
      );
    });

    it("should throw for only whitespace", () => {
      expect(() => parseJsonFromContent("   \n\t   ")).toThrow(
        "Unable to parse JSON from model response",
      );
    });
  });

  describe("real-world AI responses", () => {
    it("should handle GPT-style verbose response", () => {
      const input = `Based on my analysis of the job description and candidate profile, I have evaluated the fit:

\`\`\`json
{
  "score": 72,
  "reason": "Strong React and TypeScript skills match. However, the role requires 5+ years experience which the candidate may not have."
}
\`\`\`

This score reflects the candidate's technical capabilities while accounting for the experience gap.`;
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(72);
      expect(result.reason).toContain("React and TypeScript");
    });

    it("should handle Claude-style response with thinking", () => {
      const input = `Let me evaluate this candidate against the job requirements.

{"score": 83, "reason": "Excellent frontend skills with React and modern tooling. Good culture fit based on startup experience."}`;
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(83);
    });

    it("should handle response with JSON5-style comments", () => {
      // Some models output JSON5-like syntax with comments
      const input = `{
  "score": 67, // Good but not great
  "reason": "Matches most requirements but lacks cloud experience"
}`;
      // This will fail standard parse but regex should catch it
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(67);
    });

    it("should handle response with extra properties", () => {
      const input =
        '{"score": 79, "reason": "Good match", "confidence": "high", "breakdown": {"skills": 25, "experience": 20}}';
      const result = parseJsonFromContent(input);
      expect(result.score).toBe(79);
      expect(result.reason).toBe("Good match");
    });
  });
});

describe("salary penalty", () => {
  beforeEach(() => {
    getSettingMock.mockResolvedValue(null);
    getEffectiveSettingsMock.mockResolvedValue({
      penalizeMissingSalary: { value: true, default: true, override: null },
      missingSalaryPenalty: { value: 10, default: 10, override: null },
      scoringInstructions: { value: "", default: "", override: null },
      scoringPromptTemplate: { value: "", default: "", override: null },
      rxresumeBaseResumeId: "base-resume-123",
    } as any);
    resolveLlmModelMock.mockResolvedValue("gpt-4.1-mini");
    callJsonMock.mockResolvedValue({
      success: true,
      data: { score: 80, reason: "Good match" },
    });
    createConfiguredLlmServiceMock.mockResolvedValue({
      callJson: callJsonMock,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function getScoringPrompt(): string {
    const call = callJsonMock.mock.calls.at(-1)?.[0];
    return call?.messages?.[0]?.content ?? "";
  }

  function getPromptProfile(): Record<string, any> {
    const prompt = getScoringPrompt();
    const match = prompt.match(
      /CANDIDATE PROFILE:\n(?<profile>[\s\S]*?)\n\nSCORING INSTRUCTIONS:/,
    );
    expect(match?.groups?.profile).toBeDefined();
    return JSON.parse(match?.groups?.profile ?? "{}");
  }

  it("sends minified source job JSON with nulls and no generated state", async () => {
    const { scoreJobSuitability } = await import("./scorer");
    getEffectiveSettingsMock.mockResolvedValue({
      penalizeMissingSalary: { value: false, default: false, override: null },
      missingSalaryPenalty: { value: 10, default: 10, override: null },
      scoringInstructions: { value: "", default: "", override: null },
      rxresumeBaseResumeId: "base-resume-123",
    } as any);

    await scoreJobSuitability(
      createJob({
        salary: null,
        jobDescription: "<p>Build <strong>TypeScript</strong> services.</p>",
        jobLevel: "senior",
        salaryMinAmount: 80_000,
        companyIndustry: "Fintech",
        skills: "TypeScript, Node.js",
        emails: "jobs@example.com",
        suitabilityScore: 42,
        jobBrief: '{"stale":true}',
        tailoredSummary: "Private tailored summary",
        pdfPath: "/private/resume.pdf",
      }),
      {},
    );

    const match = getScoringPrompt().match(
      /JOB DATA \(JSON\):\n(?<job>[^\n]+)\n\n/,
    );
    const job = JSON.parse(match?.groups?.job ?? "{}");
    expect(job).toMatchObject({
      salary: null,
      jobLevel: "senior",
      salaryMinAmount: 80_000,
      companyIndustry: "Fintech",
      skills: "TypeScript, Node.js",
      emails: "jobs@example.com",
      jobDescription: "Build TypeScript services.",
    });
    expect(job).not.toHaveProperty("suitabilityScore");
    expect(job).not.toHaveProperty("jobBrief");
    expect(job).not.toHaveProperty("tailoredSummary");
    expect(job).not.toHaveProperty("pdfPath");
    expect(getScoringPrompt()).not.toContain("<strong>");
  });

  describe("profile prompt sanitization", () => {
    it("omits globally excluded projects from scoring", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: false, default: false, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        scoringInstructions: { value: "", default: "", override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);
      getSettingMock.mockImplementation(async (key) =>
        key === "resumeProjects"
          ? JSON.stringify({
              maxProjects: 1,
              lockedProjectIds: ["included"],
              aiSelectableProjectIds: [],
            })
          : null,
      );

      await scoreJobSuitability(createJob({ id: "project-policy-score" }), {
        sections: {
          projects: {
            items: ["included", "excluded"].map((id) => ({
              id,
              name: `${id} project`,
              description: id,
              summary: id,
              date: "2026",
              visible: false,
            })),
          },
        },
      });

      expect(getScoringPrompt()).toContain("included project");
      expect(getScoringPrompt()).not.toContain("excluded project");
    });

    it("includes top-level education and the full top-level CV content", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: false, default: false, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        scoringInstructions: { value: "", default: "", override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      await scoreJobSuitability(
        createJob({
          id: "test-job-profile-top-level",
          title: "Software Engineer Intern",
        }),
        {
          basics: {
            label: "Software Engineer",
            summary: "Builds React and TypeScript applications.",
            location: "Sheffield",
            email: "private@example.com",
            phone: "+44 7000 000000",
            website: { url: "https://private.example.com" },
          },
          education: [
            {
              id: "education-private-id",
              school: "University of Lancashire",
              degree: "BSc Software Engineering",
              location: "Preston",
              period: "2022 - 2025",
              description: "Computer Science and Software Engineering.",
              website: { url: "https://university.example.com" },
            },
          ],
          experience: Array.from({ length: 6 }, (_, index) => ({
            company: `Company ${index + 1}`,
            position: "Software Engineer",
            summary: `Experience summary ${index + 1}`,
            roles:
              index === 0
                ? [
                    {
                      id: "role-private-id",
                      position: "Frontend Developer",
                      period: "2024",
                      description: "Built React features.",
                    },
                  ]
                : [],
          })),
        },
      );

      const promptProfile = getPromptProfile();
      expect(promptProfile.basics).toEqual({
        label: "Software Engineer",
        summary: "Builds React and TypeScript applications.",
        location: "Sheffield",
      });
      expect(promptProfile.education).toEqual([
        {
          school: "University of Lancashire",
          degree: "BSc Software Engineering",
          location: "Preston",
          period: "2022 - 2025",
          description: "Computer Science and Software Engineering.",
        },
      ]);
      expect(promptProfile.experience).toHaveLength(6);
      expect(promptProfile.experience[5]).toEqual({
        company: "Company 6",
        position: "Software Engineer",
        summary: "Experience summary 6",
      });
      expect(promptProfile.experience[0].roles).toEqual([
        {
          position: "Frontend Developer",
          period: "2024",
          description: "Built React features.",
        },
      ]);
      expect(getScoringPrompt()).not.toContain("private@example.com");
      expect(getScoringPrompt()).not.toContain("+44 7000 000000");
      expect(getScoringPrompt()).not.toContain("education-private-id");
      expect(getScoringPrompt()).not.toContain("role-private-id");
      expect(getScoringPrompt()).not.toContain(
        "https://university.example.com",
      );
    });

    it("includes education from nested resume sections", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: false, default: false, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        scoringInstructions: { value: "", default: "", override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      await scoreJobSuitability(
        createJob({ id: "test-job-profile-sections" }),
        {
          sections: {
            education: {
              title: "Education",
              hidden: false,
              items: [
                {
                  school: "University of Sheffield",
                  degree: "BSc Computer Science",
                  area: "Software Engineering",
                  location: "Sheffield",
                },
              ],
            },
          },
          metadata: {
            layout: "private-renderer-layout",
          },
        },
      );

      const promptProfile = getPromptProfile();
      expect(promptProfile.education).toEqual([
        {
          school: "University of Sheffield",
          degree: "BSc Computer Science",
          area: "Software Engineering",
          location: "Sheffield",
        },
      ]);
      expect(getScoringPrompt()).not.toContain("private-renderer-layout");
    });

    it("excludes hidden and invisible CV items from prompt content", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: false, default: false, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        scoringInstructions: { value: "", default: "", override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      await scoreJobSuitability(
        createJob({ id: "test-job-profile-hidden-items" }),
        {
          sections: {
            skills: {
              items: [
                { name: "Frontend", keywords: ["React"], visible: true },
                {
                  name: "Hidden Skill",
                  keywords: ["PrivateSkill"],
                  hidden: true,
                },
                {
                  name: "Invisible Skill",
                  keywords: ["InvisibleSkill"],
                  visible: false,
                },
              ],
            },
            education: {
              items: [
                { school: "Visible University", degree: "BSc Computing" },
                {
                  school: "Hidden University",
                  degree: "Private Degree",
                  hidden: true,
                },
                {
                  school: "Invisible University",
                  degree: "Invisible Degree",
                  visible: false,
                },
              ],
            },
          },
        },
      );

      const promptProfile = getPromptProfile();
      expect(promptProfile.skills).toEqual([
        { name: "Frontend", keywords: ["React"] },
      ]);
      expect(promptProfile.education).toEqual([
        { school: "Visible University", degree: "BSc Computing" },
      ]);
      expect(getScoringPrompt()).not.toContain("PrivateSkill");
      expect(getScoringPrompt()).not.toContain("InvisibleSkill");
      expect(getScoringPrompt()).not.toContain("Hidden University");
      expect(getScoringPrompt()).not.toContain("Invisible University");
    });
  });

  describe("isSalaryMissing detection", () => {
    it("uses accepted salary patches before applying the missing-salary penalty", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      callJsonMock.mockResolvedValue({
        success: true,
        data: {
          score: 80,
          reason: "Good match",
          jobPatches: [
            {
              field: "salaryMinAmount",
              value: 45_000,
              confidence: "high",
              evidence: "Salary: £45,000 per year",
            },
          ],
        },
      });

      const result = await scoreJobSuitability(
        createJob({
          salary: null,
          salaryMinAmount: null,
          salaryMaxAmount: null,
          jobDescription: "Salary: £45,000 per year",
        }),
        {},
      );

      expect(result.score).toBe(80);
      expect(result.reason).not.toContain("missing salary");
      expect(result.jobUpdates).toEqual({
        salaryMinAmount: 45_000,
        salarySource: "ai_job_fact_review",
      });
    });

    it("should detect null salary as missing", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: true, default: true, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: 80, reason: "Good match" },
      });

      const job = createJob({
        id: "test-job-1",
        salary: null,
        title: "Software Engineer",
      });
      const result = await scoreJobSuitability(job, {});

      expect(result.score).toBe(70); // 80 - 10
      expect(result.reason).toContain(
        "Score reduced by 10 points due to missing salary information",
      );
    });

    it("should detect empty string salary as missing", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: true, default: true, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: 80, reason: "Good match" },
      });

      const job = createJob({
        id: "test-job-1",
        salary: "",
        title: "Software Engineer",
      });
      const result = await scoreJobSuitability(job, {});

      expect(result.score).toBe(70);
      expect(result.reason).toContain("missing salary information");
    });

    it("should detect whitespace-only salary as missing", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: true, default: true, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: 80, reason: "Good match" },
      });

      const job = createJob({
        id: "test-job-1",
        salary: "   ",
        title: "Software Engineer",
      });
      const result = await scoreJobSuitability(job, {});

      expect(result.score).toBe(70);
      expect(result.reason).toContain("missing salary information");
    });

    it("should NOT penalize jobs with non-empty salary", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: true, default: true, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: 80, reason: "Good match" },
      });

      const job = createJob({
        id: "test-job-1",
        salary: "Competitive",
        title: "Software Engineer",
      });
      const result = await scoreJobSuitability(job, {});

      expect(result.score).toBe(80); // No penalty
      expect(result.reason).not.toContain("missing salary");
    });

    it("should NOT penalize jobs with actual salary value", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: true, default: true, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: 80, reason: "Good match" },
      });

      const job = createJob({
        id: "test-job-1",
        salary: "£40,000 - £50,000",
        title: "Software Engineer",
      });
      const result = await scoreJobSuitability(job, {});

      expect(result.score).toBe(80); // No penalty
      expect(result.reason).not.toContain("missing salary");
    });
  });

  describe("penalty application", () => {
    it("includes custom scoring instructions in the scorer prompt", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: false, default: false, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        scoringInstructions: {
          value:
            "Open to relocating, so do not mark down for location discrepancies.",
          default: "",
          override:
            "Open to relocating, so do not mark down for location discrepancies.",
        },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: 80, reason: "Good match" },
      });

      const job = createJob({
        id: "test-job-1",
        title: "Software Engineer",
      });

      await scoreJobSuitability(job, {});

      expect(callJsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            expect.objectContaining({
              content: expect.stringContaining(
                "Open to relocating, so do not mark down for location discrepancies.",
              ),
            }),
          ],
        }),
      );
    });

    it("uses per-run scoring instructions instead of global scoring settings", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: false, default: false, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        scoringInstructions: {
          value: "Global instruction that should not be used.",
          default: "",
          override: "Global instruction that should not be used.",
        },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: 80, reason: "Good match" },
      });

      await scoreJobSuitability(
        createJob({
          id: "test-job-per-run-instructions",
          title: "Software Engineer",
        }),
        {},
        {
          scoringInstructions:
            "Prefer roles above GBP 60k and lower-score graduate programmes.",
        },
      );

      const prompt =
        callJsonMock.mock.calls.at(-1)?.[0]?.messages?.[0]?.content;
      expect(prompt).toContain(
        "Prefer roles above GBP 60k and lower-score graduate programmes.",
      );
      expect(prompt).not.toContain(
        "Global instruction that should not be used.",
      );
    });

    it("uses a custom scoring prompt template override", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: false, default: false, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        scoringInstructions: {
          value: "Prioritize backend work.",
          default: "",
          override: "Prioritize backend work.",
        },
        scoringPromptTemplate: {
          value:
            "Custom scoring {{jobTitle}} {{scoringInstructionsText}} {{unknownToken}}",
          default: "",
          override:
            "Custom scoring {{jobTitle}} {{scoringInstructionsText}} {{unknownToken}}",
        },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: true,
        data: {
          score: 80,
          reason: "Good match",
          jobBrief: {
            role_summary: "Build backend services.",
            they_want: ["TypeScript"],
            specifics: ["Node.js"],
            company_offers: [],
            practical_details: ["Salary: Not stated"],
            missing_or_unclear: ["Sponsorship"],
            repeated_signals: ["Ownership"],
          },
        },
      });

      const result = await scoreJobSuitability(
        createJob({
          id: "test-job-custom-template",
          title: "Backend Engineer",
        }),
        {},
      );

      expect(callJsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            expect.objectContaining({
              content: expect.stringContaining(
                "Custom scoring Backend Engineer Prioritize backend work. {{unknownToken}}",
              ),
            }),
          ],
          jsonSchema: expect.objectContaining({
            schema: expect.objectContaining({
              required: [
                "score",
                "reason",
                "jobBrief",
                "jobPatches",
                "jobWarnings",
              ],
            }),
          }),
        }),
      );
      expect(getScoringPrompt()).toContain('"jobBrief"');
      expect(getScoringPrompt()).toContain('"jobPatches"');
      expect(getScoringPrompt()).toContain(
        "Do not guess, infer from general knowledge, estimate, annualise compensation",
      );
      expect(getScoringPrompt()).toContain("JOB DATA (JSON):");
      expect(getScoringPrompt()).toContain(
        '"jobDescription":"Job description content"',
      );
      expect(JSON.parse(result.jobBrief as string)).toEqual(
        expect.objectContaining({ role_summary: "Build backend services." }),
      );
    });

    it("should not apply penalty when disabled", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: false, default: false, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: 80, reason: "Good match" },
      });

      const job = createJob({
        id: "test-job-1",
        salary: null,
        title: "Software Engineer",
      });
      const result = await scoreJobSuitability(job, {});

      expect(result.score).toBe(80); // No penalty when disabled
      expect(result.reason).not.toContain("missing salary");
    });

    it("should clamp score to minimum 0 (high penalty on medium score)", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: true, default: true, override: null },
        missingSalaryPenalty: { value: 100, default: 100, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: 50, reason: "Average match" },
      });

      const job = createJob({
        id: "test-job-1",
        salary: null,
        title: "Software Engineer",
      });
      const result = await scoreJobSuitability(job, {});

      expect(result.score).toBe(0); // Clamped, not negative
      expect(result.reason).toContain("Score reduced by 100 points");
    });

    it("should clamp score to minimum 0 (low score with penalty)", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: true, default: true, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: 5, reason: "Weak match" },
      });

      const job = createJob({
        id: "test-job-1",
        salary: null,
        title: "Software Engineer",
      });
      const result = await scoreJobSuitability(job, {});

      expect(result.score).toBe(0); // 5 - 10 = -5, clamped to 0
      expect(result.reason).toContain("Score reduced by 10 points");
    });

    it("should handle penalty of 0", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: true, default: true, override: null },
        missingSalaryPenalty: { value: 0, default: 0, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: 80, reason: "Good match" },
      });

      const job = createJob({
        id: "test-job-1",
        salary: null,
        title: "Software Engineer",
      });
      const result = await scoreJobSuitability(job, {});

      expect(result.score).toBe(80); // No change with 0 penalty
      expect(result.reason).toContain("Score reduced by 0 points");
    });

    it("should apply penalty with correct amount", async () => {
      const { scoreJobSuitability } = await import("./scorer");
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: true, default: true, override: null },
        missingSalaryPenalty: { value: 25, default: 25, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: 90, reason: "Excellent match" },
      });

      const job = createJob({
        id: "test-job-1",
        salary: null,
        title: "Software Engineer",
      });
      const result = await scoreJobSuitability(job, {});

      expect(result.score).toBe(65); // 90 - 25
      expect(result.reason).toContain(
        "Score reduced by 25 points due to missing salary information",
      );
    });
  });

  describe("LlmNotConfiguredError", () => {
    it("should throw LlmNotConfiguredError when API key is not configured", async () => {
      const { scoreJobSuitability, LlmNotConfiguredError } = await import(
        "./scorer"
      );
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: false, default: false, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: false,
        error: "LLM API key not configured",
      });

      const job = createJob({
        id: "test-job-1",
        salary: null,
        title: "Software Engineer",
      });

      await expect(scoreJobSuitability(job, {})).rejects.toThrow(
        LlmNotConfiguredError,
      );
    });

    it("should throw LlmNotConfiguredError when the provider rejects the credentials", async () => {
      const { scoreJobSuitability, LlmNotConfiguredError } = await import(
        "./scorer"
      );
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: false, default: false, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: false,
        error: "LLM API error: 401 - Invalid API key",
      });

      const job = createJob({
        id: "test-job-2",
        title: "Software Engineer",
      });

      await expect(scoreJobSuitability(job, {})).rejects.toThrow(
        LlmNotConfiguredError,
      );
    });

    it("should throw ScoringUnavailableError for transient provider faults", async () => {
      const { scoreJobSuitability, ScoringUnavailableError } = await import(
        "./scorer"
      );
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: false, default: false, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: false,
        error: "No content in response",
      });

      const job = createJob({
        id: "test-job-2",
        title: "Software Engineer",
      });

      await expect(scoreJobSuitability(job, {})).rejects.toThrow(
        ScoringUnavailableError,
      );
    });

    it("should throw ScoringUnavailableError when the AI returns no numeric score", async () => {
      const { scoreJobSuitability, ScoringUnavailableError } = await import(
        "./scorer"
      );
      getEffectiveSettingsMock.mockResolvedValue({
        penalizeMissingSalary: { value: false, default: false, override: null },
        missingSalaryPenalty: { value: 10, default: 10, override: null },
        rxresumeBaseResumeId: "base-resume-123",
      } as any);

      callJsonMock.mockResolvedValue({
        success: true,
        data: { score: "not-a-number", reason: "Confused model" },
      });

      const job = createJob({
        id: "test-job-3",
        title: "Software Engineer",
      });

      await expect(scoreJobSuitability(job, {})).rejects.toThrow(
        ScoringUnavailableError,
      );
    });
  });
});

describe("target companies and dealbreakers in the scoring prompt", () => {
  // The default scoring template exactly as it was before the target
  // companies and dealbreakers placeholders were added.
  const PREVIOUS_DEFAULT_SCORING_TEMPLATE = `You are evaluating a job listing for a candidate. Score how suitable this job is for the candidate on a scale of 0-100.

SCORING CRITERIA:
- Skills match (technologies, frameworks, languages): 0-30 points
- Experience level match: 0-25 points
- Location/remote work alignment: 0-15 points
- Industry/domain fit: 0-15 points
- Career growth potential: 0-15 points

CANDIDATE PROFILE:
{{profileJson}}

SCORING INSTRUCTIONS:
{{scoringInstructionsText}}`;

  const profile = {
    basics: { label: "Software Engineering Intern" },
    skills: [{ name: "Backend", keywords: ["Go", "PostgreSQL"] }],
  };

  function mockSettings(
    overrides: {
      template?: string;
      targetCompanies?: string[];
      dealbreakers?: string;
      scoringInstructions?: string;
    } = {},
  ) {
    const template =
      overrides.template ?? getDefaultPromptTemplate("scoringPromptTemplate");
    getEffectiveSettingsMock.mockResolvedValue({
      penalizeMissingSalary: { value: false, default: false, override: null },
      missingSalaryPenalty: { value: 10, default: 10, override: null },
      scoringInstructions: {
        value: overrides.scoringInstructions ?? "",
        default: "",
        override: null,
      },
      scoringPromptTemplate: { value: template, default: "", override: null },
      targetCompanies: {
        value: overrides.targetCompanies ?? [],
        default: [],
        override: null,
      },
      dealbreakers: {
        value: overrides.dealbreakers ?? "",
        default: "",
        override: null,
      },
    } as any);
  }

  async function scorePrompt(
    job = createJob({
      id: "job-target",
      title: "Backend Engineer Intern",
      employer: "PT GoTo Gojek Tokopedia Tbk",
    }),
  ): Promise<string> {
    const { scoreJobSuitability } = await import("./scorer");
    await scoreJobSuitability(job, profile);
    return callJsonMock.mock.calls.at(-1)?.[0]?.messages?.[0]?.content ?? "";
  }

  function count(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
  }

  beforeEach(() => {
    getSettingMock.mockResolvedValue(null);
    resolveLlmModelMock.mockResolvedValue("gpt-4.1-mini");
    callJsonMock.mockResolvedValue({
      success: true,
      data: { score: 70, reason: "Good match" },
    });
    createConfiguredLlmServiceMock.mockResolvedValue({
      callJson: callJsonMock,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the default-template prompt byte-identical when both settings are empty", async () => {
    mockSettings();
    const withNewDefault = await scorePrompt();

    mockSettings({ template: PREVIOUS_DEFAULT_SCORING_TEMPLATE });
    const withPreviousDefault = await scorePrompt();

    expect(withNewDefault).toBe(withPreviousDefault);
    expect(withNewDefault).not.toContain("TARGET COMPANIES");
    expect(withNewDefault).not.toContain("DEALBREAKERS");
    expect(withNewDefault).not.toContain("{{");
  });

  it("only adds the two placeholders to the previous default template", () => {
    expect(
      getDefaultPromptTemplate("scoringPromptTemplate").replace(
        "{{targetCompaniesSection}}{{dealbreakersSection}}",
        "",
      ),
    ).toBe(PREVIOUS_DEFAULT_SCORING_TEMPLATE);
  });

  it("fills the placeholders in the default template", async () => {
    mockSettings({
      scoringInstructions: "Prefer backend roles.",
      targetCompanies: ["GoTo | Gojek | Tokopedia", "Grab"],
      dealbreakers: "No unpaid internships.\nNo roles outside Jakarta.",
    });
    const prompt = await scorePrompt();

    const instructionsAt = prompt.indexOf("Prefer backend roles.");
    const targetAt = prompt.indexOf(
      "TARGET COMPANIES (employers the candidate most wants to join):\n- GoTo (also: Gojek, Tokopedia)\n- Grab\n",
    );
    const dealbreakersAt = prompt.indexOf(
      "DEALBREAKERS (conditions the candidate will not accept):\nNo unpaid internships.\nNo roles outside Jakarta.\n",
    );
    const jobDataAt = prompt.indexOf("JOB DATA (JSON):");

    expect(instructionsAt).toBeGreaterThan(-1);
    expect(targetAt).toBeGreaterThan(instructionsAt);
    expect(dealbreakersAt).toBeGreaterThan(targetAt);
    expect(jobDataAt).toBeGreaterThan(dealbreakersAt);
    expect(count(prompt, "TARGET COMPANIES")).toBe(1);
    expect(count(prompt, "DEALBREAKERS")).toBe(1);
    expect(prompt).toContain(
      'This job\'s employer matches the target company "GoTo".',
    );
    expect(prompt).toContain(
      "When fit is otherwise comparable, favour a job at a target company",
    );
    expect(prompt).toContain("Never let it lift a poor fit to a high score.");
    expect(prompt).toContain(
      "If the listing clearly violates a dealbreaker, score it 20 or lower and name the violated dealbreaker in the reason.",
    );
  });

  it("lists target companies without a match line for other employers", async () => {
    mockSettings({ targetCompanies: ["Grab"] });
    const prompt = await scorePrompt(
      createJob({ id: "job-other", employer: "Grabango" }),
    );

    expect(prompt).toContain("TARGET COMPANIES");
    expect(prompt).toContain("- Grab\n");
    expect(prompt).not.toContain("employer matches the target company");
  });

  it("appends the context to a custom template that lacks the placeholders", async () => {
    mockSettings({
      template: "Custom scoring for {{jobTitle}}.",
      targetCompanies: ["Grab"],
      dealbreakers: "No unpaid roles.",
    });
    const prompt = await scorePrompt(
      createJob({
        id: "job-custom",
        title: "Mobile Intern",
        employer: "GrabTaxi Holdings",
      }),
    );

    expect(prompt.startsWith("Custom scoring for Mobile Intern.\n\n")).toBe(
      true,
    );
    expect(count(prompt, "TARGET COMPANIES")).toBe(1);
    expect(count(prompt, "DEALBREAKERS")).toBe(1);
    expect(prompt.indexOf("TARGET COMPANIES")).toBeLessThan(
      prompt.indexOf("DEALBREAKERS"),
    );
    expect(prompt.indexOf("DEALBREAKERS")).toBeLessThan(
      prompt.indexOf("JOB DATA (JSON):"),
    );
    expect(prompt).toContain(
      'This job\'s employer matches the target company "Grab".',
    );
    expect(prompt).toContain("No unpaid roles.");
  });

  it("appends only the context whose placeholder a custom template lacks", async () => {
    mockSettings({
      template: "Custom start.{{dealbreakersSection}}\nCustom end.",
      targetCompanies: ["Grab"],
      dealbreakers: "No unpaid roles.",
    });
    const prompt = await scorePrompt();

    expect(prompt).toMatch(
      /^Custom start\.\n\nDEALBREAKERS[^\n]*\nNo unpaid roles\.\n[^\n]+\nCustom end\.\n\nTARGET COMPANIES/,
    );
    expect(count(prompt, "DEALBREAKERS")).toBe(1);
    expect(count(prompt, "TARGET COMPANIES")).toBe(1);
  });

  it("leaves a custom template unchanged when both settings are empty", async () => {
    mockSettings({ template: "Custom scoring for {{jobTitle}}." });
    const prompt = await scorePrompt(
      createJob({ id: "job-plain", title: "Data Intern" }),
    );

    expect(
      prompt.startsWith("Custom scoring for Data Intern.\n\nJOB DATA"),
    ).toBe(true);
  });

  it("never sends the computed target-company flag as job data", async () => {
    mockSettings({ targetCompanies: ["Grab"] });
    const prompt = await scorePrompt(
      createJob({ id: "job-flag", employer: "Grab", isTargetCompany: true }),
    );

    const match = prompt.match(/JOB DATA \(JSON\):\n(?<job>[^\n]+)\n\n/);
    const job = JSON.parse(match?.groups?.job ?? "{}");
    expect(job.employer).toBe("Grab");
    expect(job).not.toHaveProperty("isTargetCompany");
  });
});
