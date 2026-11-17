import { matchJobLocationIntent } from "@shared/job-matching";
import { normalizeLocationIntent } from "@shared/location-domain";
import { describe, expect, it, vi } from "vitest";
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

function inCity(row: typeof softwareJob, city: string, id: number) {
  return {
    ...row,
    id,
    google_location: {
      address_components: {
        ...row.google_location.address_components,
        city,
      },
    },
  };
}

describe("Kalibrr extractor", () => {
  it("builds an Indonesia search URL with small pages and an optional city", () => {
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
    expect(url.searchParams.has("location")).toBe(false);
    expect(
      buildKalibrrSearchUrl({
        searchTerm: "qa",
        offset: 0,
        limit: 20,
        location: "Jakarta",
      }).searchParams.get("location"),
    ).toBe("Jakarta");
  });

  it("maps a recorded job into a normalized job with a slug-free URL", () => {
    const job = mapKalibrrJob(softwareJob);
    const url = "https://www.kalibrr.com/c/pt-akhdani-reka-solusi/jobs/262972";

    expect(job).toEqual(
      expect.objectContaining({
        source: "kalibrr",
        sourceJobId: "262972",
        title: "Software Engineer",
        employer: "PT Akhdani Reka Solusi",
        jobUrl: url,
        applicationLink: url,
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
    expect(
      mapKalibrrJob({ ...softwareJob, name: "Renamed role" })?.jobUrl,
    ).toBe(url);
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
      city: "Jakarta Pusat",
      regionHints: ["DKI Jakarta"],
      source: "kalibrr",
    });

    if (!job) throw new Error("expected a job");
    for (const city of ["Jakarta", "Jakarta Pusat", "Central Jakarta"]) {
      const intent = normalizeLocationIntent({
        selectedCountry: "indonesia",
        cityLocations: [city],
      });
      expect(matchJobLocationIntent(job, intent).matched).toBe(true);
    }
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

  it("drops results whose title does not match the term, pages by offset and caps per term", async () => {
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

  it("sends districts to the location filter as their city and keeps only the district", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        ...sample,
        count: 3,
        jobs: [
          inCity(softwareJob, "South Jakarta", 1),
          inCity(softwareJob, "Jakarta Selatan", 2),
          inCity(softwareJob, "West Jakarta", 3),
        ],
      }),
    );

    const result = await runKalibrr({
      searchTerms: ["software engineer"],
      cities: ["Jakarta Selatan", "South Jakarta"],
      fetchImpl: fetchMock,
      sleep: noSleep,
    });

    expect(result.jobs.map((job) => job.sourceJobId)).toEqual(["1", "2"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as URL;
    expect(url.searchParams.get("location")).toBe("Jakarta");
  });

  it("bounds the number of scanned results when matches are rare", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: URL) =>
      jsonResponse({
        ...sample,
        count: 1000,
        jobs: [0, 1].map((index) => ({
          ...taxJob,
          id: Number(url.searchParams.get("offset")) + index,
        })),
      }),
    );

    const result = await runKalibrr({
      searchTerms: ["software engineer"],
      maxJobsPerTerm: 2,
      pageSize: 2,
      fetchImpl: fetchMock,
      sleep: noSleep,
    });

    expect(result).toEqual({ success: true, jobs: [] });
    // Three times the cap (6 results) => three pages of two.
    expect(fetchMock).toHaveBeenCalledTimes(3);
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
