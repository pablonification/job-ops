import { matchJobLocationIntent } from "@shared/job-matching";
import { normalizeLocationIntent } from "@shared/location-domain";
import { describe, expect, it, vi } from "vitest";
import { isRelevantToSearchTerm } from "../src/relevance";
import { buildKalibrrSearchUrl, mapKalibrrJob, runKalibrr } from "../src/run";
import sample from "./fixtures/search.json";

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

const [taxJob, softwareJob] = sample.jobs;
const noSleep = vi.fn().mockResolvedValue(undefined);

describe("Kalibrr extractor", () => {
  it("builds an Indonesia search URL with small pages", () => {
    const url = buildKalibrrSearchUrl({
      searchTerm: "software engineer",
      offset: 40,
      limit: 500,
    });

    expect(url.origin + url.pathname).toBe(
      "https://www.kalibrr.com/kjs/job_board/search",
    );
    expect(url.searchParams.get("text")).toBe("software engineer");
    expect(url.searchParams.get("country")).toBe("Indonesia");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.get("offset")).toBe("40");
  });

  it("maps a recorded job into a normalized job", () => {
    const job = mapKalibrrJob(softwareJob);

    expect(job).toEqual(
      expect.objectContaining({
        source: "kalibrr",
        sourceJobId: "262972",
        title: "Software Engineer",
        employer: "PT Akhdani Reka Solusi",
        jobUrl:
          "https://www.kalibrr.com/c/pt-akhdani-reka-solusi/jobs/262972/software-engineer-5",
        applicationLink:
          "https://www.kalibrr.com/c/pt-akhdani-reka-solusi/jobs/262972/software-engineer-5",
        location: "Central Jakarta, DKI Jakarta, Indonesia",
        datePosted: "2026-11-04T02:58:41.312837+00:00",
        deadline: "2026-12-19T17:00:00+00:00",
        jobType: "Full time",
        jobFunction: "IT and Software",
        isRemote: false,
        workFromHomeType: "onsite",
        vacancyCount: 10,
        companyIndustry: "Information Technology / IT",
        companyUrlDirect: "http://www.akhdani.co.id/",
      }),
    );
    expect(job?.salary).toBeUndefined();
    expect(job?.jobDescription).toContain(
      "Design, develop, test, and maintain",
    );
    expect(job?.jobDescription).toContain(
      "<p><strong>Qualifications</strong></p>",
    );
    expect(job?.jobDescription).toContain("Proficient in one or more");
    expect(job?.locationEvidence).toMatchObject({
      country: "Indonesia",
      city: "Central Jakarta",
      regionHints: ["DKI Jakarta"],
      source: "kalibrr",
    });

    const intent = normalizeLocationIntent({
      selectedCountry: "indonesia",
      cityLocations: ["Jakarta"],
    });
    if (!job) throw new Error("expected a job");
    expect(matchJobLocationIntent(job, intent).matched).toBe(true);
  });

  it("maps published salary, hybrid work and redirect apply links", () => {
    const job = mapKalibrrJob({
      ...taxJob,
      salary_shown: true,
      base_salary: 8_000_000,
      maximum_salary: 12_000_000,
      salary_currency: "IDR",
      salary_interval: "Monthly",
      apply_redirect_url: "https://careers.example.com/jobs/1",
    });

    expect(job).toMatchObject({
      salary: "IDR 8,000,000–12,000,000 / month",
      salaryMinAmount: 8_000_000,
      salaryMaxAmount: 12_000_000,
      salaryCurrency: "IDR",
      salaryInterval: "monthly",
      workFromHomeType: "hybrid",
      applicationLink: "https://careers.example.com/jobs/1",
      skills: "Auditing and Compliance, Financial Statement Analysis, Taxation",
    });
    expect(job?.locationEvidence).toMatchObject({ isHybrid: true });
    expect(
      mapKalibrrJob({ ...taxJob, salary_shown: false, base_salary: 1 })?.salary,
    ).toBeUndefined();
  });

  it("tightens Kalibrr's loose keyword matching", () => {
    const relevance = (row: typeof taxJob, term: string) =>
      isRelevantToSearchTerm(
        {
          title: row.name,
          description: row.description,
          qualifications: row.qualifications,
        },
        term,
      );

    expect(relevance(taxJob, "software engineer")).toBe(false);
    expect(relevance(softwareJob, "software engineer")).toBe(true);
    expect(relevance(softwareJob, "Engineering")).toBe(false);
    expect(relevance(softwareJob, "kotlin")).toBe(true);
    expect(relevance(softwareJob, "go")).toBe(false);
    expect(relevance(taxJob, "tax & audit")).toBe(true);
    expect(relevance(taxJob, "and")).toBe(true);
  });

  it("drops irrelevant results, pages by offset and caps per term", async () => {
    const response = (offset: number) =>
      jsonResponse({
        ...sample,
        count: 6,
        jobs: [taxJob, softwareJob].map((row, index) => ({
          ...row,
          id: offset + index,
        })),
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(0))
      .mockResolvedValueOnce(response(2))
      .mockResolvedValueOnce(response(4));

    const result = await runKalibrr({
      searchTerms: ["software engineer"],
      maxJobsPerTerm: 5,
      pageSize: 2,
      fetchImpl: fetchMock,
      sleep: noSleep,
    });

    expect(result.success).toBe(true);
    expect(result.jobs.map((job) => job.sourceJobId)).toEqual(["1", "3", "5"]);
    expect(result.jobs.every((job) => job.title === "Software Engineer")).toBe(
      true,
    );
    const offsets = fetchMock.mock.calls.map((call) =>
      (call[0] as URL).searchParams.get("offset"),
    );
    expect(offsets).toEqual(["0", "2", "4"]);
  });

  it("bounds the number of scanned results when matches are rare", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ ...sample, count: 1000, jobs: [taxJob, taxJob] }),
      );

    const result = await runKalibrr({
      searchTerms: ["software engineer"],
      maxJobsPerTerm: 2,
      pageSize: 2,
      fetchImpl: fetchMock,
      sleep: noSleep,
    });

    expect(result).toEqual({ success: true, jobs: [] });
    // Twice the cap (4 results) => two pages of two.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns a status-only error when the source fails", async () => {
    const result = await runKalibrr({
      searchTerms: ["software engineer"],
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({}, 500)),
      sleep: noSleep,
    });

    expect(result).toEqual({
      success: false,
      jobs: [],
      error: "Kalibrr request failed with status 500 (term: software engineer)",
    });
  });
});
