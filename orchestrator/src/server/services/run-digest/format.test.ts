import { describe, expect, it } from "vitest";
import {
  buildDigestMessage,
  type DigestJob,
  sanitizeDigestReason,
} from "./format";

const BASE = "https://jobs.example.com";

function job(overrides: Partial<DigestJob> & { id: string }): DigestJob {
  return {
    title: "Software Engineer",
    employer: "Acme",
    score: 70,
    isTargetCompany: false,
    ...overrides,
  };
}

function completed(
  jobs: DigestJob[],
  options: { maxJobs?: number; baseUrl?: string | null } = {},
) {
  return {
    kind: "completed" as const,
    trigger: "schedule" as const,
    counts: {
      found: 48,
      new: jobs.length,
      autoSkipped: 0,
      scored: jobs.length,
      tailored: 2,
    },
    jobs,
    maxJobs: options.maxJobs ?? 5,
    baseUrl: options.baseUrl === undefined ? BASE : options.baseUrl,
  };
}

describe("run digest message", () => {
  it("lists counts, then the top new jobs by score with links", () => {
    const text = buildDigestMessage(
      completed([
        job({ id: "low", title: "QA Intern", employer: "Smallco", score: 41 }),
        job({
          id: "top",
          title: "Software Engineer Intern",
          employer: "Grab",
          score: 92,
          isTargetCompany: true,
        }),
        job({ id: "unscored", title: "Data Intern", score: null }),
        job({
          id: "mid",
          title: "Backend Engineer",
          employer: "GoTo",
          score: 85,
        }),
      ]),
    );

    expect(text).toBe(
      [
        "JobOps: scheduled run finished",
        "Found 48, 4 new. Scored 4, tailored 2.",
        "",
        "Top new jobs:",
        "",
        "1. Software Engineer Intern",
        "Grab · score 92 · 🎯 target company",
        "https://jobs.example.com/job/top",
        "",
        "2. Backend Engineer",
        "GoTo · score 85",
        "https://jobs.example.com/job/mid",
        "",
        "3. QA Intern",
        "Smallco · score 41",
        "https://jobs.example.com/job/low",
        "",
        "4. Data Intern",
        "Acme · score unscored",
        "https://jobs.example.com/job/unscored",
      ].join("\n"),
    );
  });

  it("sends nothing for a finished run without new jobs", () => {
    expect(buildDigestMessage(completed([]))).toBeNull();
  });

  it("counts auto-skipped jobs but does not list them", () => {
    const base = completed([job({ id: "kept", score: 72 })]);
    const text = buildDigestMessage({
      ...base,
      counts: { ...base.counts, new: 3, autoSkipped: 2, scored: 3 },
    });
    expect(text?.split("\n").slice(0, 5)).toEqual([
      "JobOps: scheduled run finished",
      "Found 48, 3 new (2 auto-skipped). Scored 3, tailored 2.",
      "",
      "Top new jobs:",
      "",
    ]);
    expect(text).toContain("/job/kept");
    expect(text).not.toContain("more new");

    // Every new job skipped: a short note instead of a list.
    expect(
      buildDigestMessage({
        ...base,
        jobs: [],
        counts: { ...base.counts, new: 2, autoSkipped: 2 },
      }),
    ).toBe(
      [
        "JobOps: scheduled run finished",
        "Found 48, 2 new (2 auto-skipped). Scored 1, tailored 2.",
        "None of the new jobs reached your auto-skip score.",
        "https://jobs.example.com/jobs/all",
      ].join("\n"),
    );
  });

  it("keeps job text as plain text, on one line each", () => {
    const text = buildDigestMessage(
      completed([
        job({
          id: "a",
          title: "C++ *Senior* [Remote] <Engineer> & _Lead_\nsecond line",
          employer: "A&B <Corp>",
        }),
      ]),
    );
    expect(text).toContain(
      "1. C++ *Senior* [Remote] <Engineer> & _Lead_ second line",
    );
    expect(text).toContain("A&B <Corp> · score 70");
  });

  it("drops links, not jobs, without a public base URL", () => {
    const text = buildDigestMessage(
      completed([job({ id: "a" }), job({ id: "b" })], { baseUrl: null }),
    );
    expect(text).not.toContain("http");
    expect(text).toContain("2. Software Engineer");
  });

  it("caps the list at the configured number and says how many more", () => {
    const jobs = Array.from({ length: 9 }, (_, index) =>
      job({ id: `job-${index}`, score: 90 - index }),
    );
    const text = buildDigestMessage(completed(jobs, { maxJobs: 3 })) ?? "";
    expect(text).toContain("3. Software Engineer");
    expect(text).not.toContain("4. Software Engineer");
    expect(
      text.endsWith(
        "+6 more new jobs in JobOps.\nhttps://jobs.example.com/jobs/all",
      ),
    ).toBe(true);
  });

  it("truncates by whole jobs to stay within the message limit", () => {
    const jobs = Array.from({ length: 20 }, (_, index) =>
      job({
        id: `job-${index}`,
        title: `${"Very long title ".repeat(20)}${index}`,
        employer: "Employer ".repeat(20),
        score: 99 - index,
      }),
    );
    const limit = 1200;
    const text =
      buildDigestMessage(completed(jobs, { maxJobs: 20 }), limit) ?? "";
    expect(text.length).toBeLessThanOrEqual(limit);

    const lines = text.split("\n");
    // Every job that is shown has its title, employer and link lines.
    const shown = lines.filter((line) => /^\d+\. /.test(line)).length;
    expect(shown).toBeGreaterThan(0);
    expect(lines.filter((line) => line.includes("/job/job-")).length).toBe(
      shown,
    );
    expect(text).toContain(`+${20 - shown} more new jobs in JobOps.`);
    // Titles are shortened at a character boundary, never mid-line.
    expect(lines.every((line) => line.length <= 130)).toBe(true);
  });

  it("stays under Telegram's limit with the largest settings", () => {
    const jobs = Array.from({ length: 500 }, (_, index) =>
      job({
        id: `job-${index}-${"x".repeat(30)}`,
        title: "🚀".repeat(300),
        employer: "Ünïcode GmbH ".repeat(30),
        score: 50,
        isTargetCompany: index % 2 === 0,
      }),
    );
    const text = buildDigestMessage(completed(jobs, { maxJobs: 20 })) ?? "";
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).not.toContain("�");
  });

  it("writes a short failure notice with a cleaned reason", () => {
    const text = buildDigestMessage({
      kind: "failed",
      trigger: "schedule",
      reason:
        "Upstream 401 from https://api.example.com/v1/chat?key=abc123 with token=sk-live-abcdefghijkl\nand more",
      baseUrl: BASE,
    });
    expect(text).toBe(
      [
        "JobOps: scheduled run failed",
        "Reason: Upstream 401 from api.example.com with token [redacted] and more",
        "https://jobs.example.com/overview",
      ].join("\n"),
    );
  });

  it("explains pauses that need the owner", () => {
    expect(
      buildDigestMessage({
        kind: "paused",
        trigger: "schedule",
        reason: "challenge",
        sources: ["Hiring Cafe"],
        baseUrl: BASE,
      }),
    ).toBe(
      [
        "JobOps: scheduled run is paused",
        "A job site asked for a bot check (Hiring Cafe). Open JobOps to solve it or skip that search.",
        "https://jobs.example.com/jobs/discovered",
      ].join("\n"),
    );
    expect(
      buildDigestMessage({
        kind: "paused",
        trigger: "user",
        reason: "configuration",
        baseUrl: null,
      }),
    ).toBe(
      [
        "JobOps: run is paused",
        "No AI model is set up, so jobs cannot be scored. Fix it in Settings, then resume the run.",
      ].join("\n"),
    );
  });

  it("caps long reasons and removes credentials", () => {
    const reason = sanitizeDigestReason(
      `Bearer abc.def.ghi failed for 123456789:${"A".repeat(35)} ${"x".repeat(1000)}`,
    );
    expect(reason).not.toContain("abc.def.ghi");
    expect(reason).not.toContain("AAAA");
    expect(Array.from(reason).length).toBeLessThanOrEqual(300);
    expect(sanitizeDigestReason("")).toBe("Unknown error");
  });
});
