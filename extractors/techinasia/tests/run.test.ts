import { matchJobLocationIntent } from "@shared/job-matching";
import { normalizeLocationIntent } from "@shared/location-domain";
import { describe, expect, it, vi } from "vitest";
import {
  buildTechInAsiaSearchUrl,
  mapTechInAsiaJob,
  runTechInAsia,
} from "../src/run";
import sample from "./fixtures/job-postings.json";

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

function page(
  ids: string[],
  extra: { current_page?: number; last_page?: number } = {},
) {
  return {
    ...sample,
    ...extra,
    data: ids.map((id, index) => ({
      ...sample.data[index % sample.data.length],
      id,
    })),
  };
}

const noSleep = vi.fn().mockResolvedValue(undefined);

describe("Tech in Asia extractor", () => {
  it("builds an Indonesia-only search URL with small pages", () => {
    const url = buildTechInAsiaSearchUrl({
      searchTerm: "software engineer",
      page: 2,
      pageSize: 100,
    });

    expect(url.origin + url.pathname).toBe(
      "https://www.techinasia.com/api/2.0/job-postings",
    );
    expect(url.searchParams.get("query")).toBe("software engineer");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("per_page")).toBe("20");
    expect(url.searchParams.getAll("country_name[]")).toEqual(["Indonesia"]);
  });

  it("maps a recorded job posting into a normalized job", () => {
    const job = mapTechInAsiaJob(sample.data[0]);

    expect(job).toEqual(
      expect.objectContaining({
        source: "techinasia",
        sourceJobId: "ee637b19-6657-46c1-9cf4-87b1df0f1e53",
        title: "QA Automation",
        employer: "Daya Wira Performa",
        jobUrl:
          "https://www.techinasia.com/jobs/ee637b19-6657-46c1-9cf4-87b1df0f1e53",
        applicationLink:
          "https://www.techinasia.com/jobs/ee637b19-6657-46c1-9cf4-87b1df0f1e53",
        location: "Jakarta, Jakarta Raya, Indonesia",
        datePosted: "2026-11-16T07:08:26Z",
        deadline: "2027-01-15T07:08:26Z",
        salary: "IDR 7,000,000–10,000,000 / month",
        salaryMinAmount: 7_000_000,
        salaryMaxAmount: 10_000_000,
        salaryCurrency: "IDR",
        salaryInterval: "monthly",
        jobType: "Contract",
        jobFunction: "QA & Testing",
        isRemote: false,
        workFromHomeType: "onsite",
        skills: "Test Automation, Automation, QA",
        experienceRange: "3 years",
        vacancyCount: 1,
        companyIndustry: "Outsourcing",
        companyNumEmployees: "11–50 employees",
        companyUrlDirect: "https://dayawiraperforma.com/",
      }),
    );
    expect(job?.jobDescription).toContain(
      "Minimum 3 Years experience as IT QA Automation",
    );
    expect(job?.companyLogo).toMatch(/^https:\/\/cdn\.techinasia\.com\//);
    expect(job?.locationEvidence).toMatchObject({
      country: "Indonesia",
      city: "Jakarta",
      regionHints: ["Jakarta Raya"],
      workplaceType: "onsite",
      source: "techinasia",
    });
  });

  it("omits unpublished salaries, uses external apply links and maps remote work", () => {
    const job = mapTechInAsiaJob({
      ...sample.data[1],
      work_arrangement: "remote",
      external_link: "https://careers.example.com/apply/1",
    });

    expect(job?.salary).toBeUndefined();
    expect(job?.salaryMinAmount).toBeUndefined();
    expect(job?.applicationLink).toBe("https://careers.example.com/apply/1");
    expect(job?.isRemote).toBe(true);
    expect(job?.locationEvidence).toMatchObject({ isRemote: true });
    expect(mapTechInAsiaJob({ ...sample.data[0], status: "closed" })).toBe(
      null,
    );
    expect(mapTechInAsiaJob({ id: "x", title: "No employer" })).toBe(null);
  });

  it("keeps recorded jobs through the shared Indonesia location filter", () => {
    const job = mapTechInAsiaJob(sample.data[0]);
    if (!job) throw new Error("expected a job");
    const intent = normalizeLocationIntent({
      selectedCountry: "indonesia",
      cityLocations: ["Jakarta"],
    });
    expect(matchJobLocationIntent(job, intent).matched).toBe(true);
  });

  it("pages politely until the per-term cap and de-duplicates across terms", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(page(["a", "b"], { last_page: 5 })))
      .mockResolvedValueOnce(jsonResponse(page(["c", "d"], { last_page: 5 })))
      .mockResolvedValueOnce(jsonResponse(page(["a", "e"], { last_page: 1 })));

    const result = await runTechInAsia({
      searchTerms: ["qa", "crm"],
      maxJobsPerTerm: 3,
      pageSize: 2,
      fetchImpl: fetchMock,
      delayMs: 1_500,
      sleep: noSleep,
    });

    expect(result.success).toBe(true);
    expect(result.jobs.map((job) => job.sourceJobId)).toEqual([
      "a",
      "b",
      "c",
      "e",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map((call) => call[0] as URL);
    expect(urls.map((url) => url.searchParams.get("page"))).toEqual([
      "1",
      "2",
      "1",
    ]);
    expect(urls[0].searchParams.get("per_page")).toBe("2");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["User-Agent"]).toMatch(
      /Mozilla\/5\.0/,
    );
    expect(noSleep).toHaveBeenCalledWith(1_500);
  });

  it("stops paging a term whose first page was already taken by an earlier term", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(page(["a", "b"], { last_page: 61 })))
      .mockResolvedValueOnce(jsonResponse(page(["a", "b"], { last_page: 61 })));

    const result = await runTechInAsia({
      searchTerms: ["qa", "qa automation"],
      maxJobsPerTerm: 2,
      pageSize: 2,
      fetchImpl: fetchMock,
      sleep: noSleep,
    });

    expect(result.jobs.map((job) => job.sourceJobId)).toEqual(["a", "b"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("filters requested cities client-side before counting toward the cap", async () => {
    const bandung = {
      ...sample.data[0],
      id: "bdg",
      city: { ...sample.data[0].city, name: "Bandung", state: null },
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        ...sample,
        last_page: 1,
        data: [sample.data[0], sample.data[1], bandung],
      }),
    );

    const result = await runTechInAsia({
      searchTerms: ["qa"],
      cities: ["Bandung"],
      maxJobsPerTerm: 1,
      fetchImpl: fetchMock,
      sleep: noSleep,
    });

    expect(result.jobs.map((job) => job.sourceJobId)).toEqual(["bdg"]);
    expect(result.jobs[0].location).toBe("Bandung, Indonesia");
    // No server-side city parameter is sent.
    const url = fetchMock.mock.calls[0][0] as URL;
    expect([...url.searchParams.keys()].sort()).toEqual([
      "country_name[]",
      "page",
      "per_page",
      "query",
    ]);
  });

  it("emits per-term progress and honours cancellation", async () => {
    let cancelled = false;
    const events: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async () => {
      cancelled = true;
      return jsonResponse(page(["a", "b"], { last_page: 5 }));
    });

    const result = await runTechInAsia({
      searchTerms: ["qa", "crm"],
      maxJobsPerTerm: 10,
      pageSize: 2,
      fetchImpl: fetchMock,
      sleep: noSleep,
      shouldCancel: () => cancelled,
      onProgress: (event) => events.push(`${event.type}:${event.searchTerm}`),
    });

    expect(result).toEqual({ success: true, jobs: expect.any(Array) });
    expect(result.jobs).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["term_start:qa", "term_complete:qa"]);
  });

  it("returns a status-only error when the source fails", async () => {
    const result = await runTechInAsia({
      searchTerms: ["qa"],
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ boom: 1 }, 503)),
      sleep: noSleep,
    });

    expect(result).toEqual({
      success: false,
      jobs: [],
      error: "Tech in Asia request failed with status 503 (term: qa)",
    });
  });
});
