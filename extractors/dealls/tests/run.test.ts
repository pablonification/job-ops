import { matchJobLocationIntent } from "@shared/job-matching";
import { normalizeLocationIntent } from "@shared/location-domain";
import { describe, expect, it, vi } from "vitest";
import {
  buildDeallsDetailUrl,
  buildDeallsSearchUrl,
  mapDeallsJob,
  runDealls,
} from "../src/run";
import detailSample from "./fixtures/detail.json";
import searchSample from "./fixtures/search.json";

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

const [engineerDoc, internDoc] = searchSample.data.docs;
const detail = detailSample.data.result;
const ENGINEER_URL =
  "https://dealls.com/loker/software-engineer-42~pt-ultra-sakti-1";
const INTERN_URL =
  "https://dealls.com/loker/software-engineer-intern-14~dexa-group";
const noSleep = vi.fn().mockResolvedValue(undefined);

function routedFetch(
  routes: Record<string, () => Response | Promise<Response>>,
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const handler =
      routes[
        url.pathname.startsWith("/v1/explore-job/") ? "list" : url.pathname
      ];
    if (!handler) throw new Error(`unexpected request ${url.pathname}`);
    return handler();
  });
}

describe("Dealls extractor", () => {
  it("builds list and detail URLs", () => {
    const search = buildDeallsSearchUrl({
      searchTerm: "software engineer",
      page: 2,
      limit: 100,
    });
    expect(search.origin + search.pathname).toBe(
      "https://api.sejutacita.id/v1/explore-job/job",
    );
    expect(search.searchParams.get("search")).toBe("software engineer");
    expect(search.searchParams.get("page")).toBe("2");
    expect(search.searchParams.get("limit")).toBe("20");
    expect(buildDeallsDetailUrl("software-engineer-42").toString()).toBe(
      "https://api.sejutacita.id/v1/job-portal/job/slug/software-engineer-42",
    );
  });

  it("maps a list item enriched by its detail record", () => {
    const job = mapDeallsJob(engineerDoc, detail);

    expect(job).toEqual(
      expect.objectContaining({
        source: "dealls",
        sourceJobId: "6af41eb8664fdd0012b75935",
        title: "Software Engineer",
        employer: "PT Ultra Sakti",
        jobUrl: ENGINEER_URL,
        applicationLink: ENGINEER_URL,
        location: "Jakarta Utara, Indonesia",
        datePosted: "2026-11-11T07:52:24.896Z",
        jobType: "Full-time",
        jobFunction: "Full-Stack Developer",
        isRemote: false,
        workFromHomeType: "onsite",
        skills: "Web Development",
        companyIndustry: "Manufacturing (Pharmaceutical)",
        companyUrlDirect: "https://www.ultrasakti.com/",
        companyNumEmployees: "100+ employees",
      }),
    );
    expect(job?.salary).toBeUndefined();
    expect(job?.jobDescription).toContain(
      "<p><strong>Responsibilities</strong></p>",
    );
    expect(job?.jobDescription).toContain(
      "<p><strong>Requirements</strong></p>",
    );
    expect(job?.jobDescription).toContain("Develop, maintain, and enhance");
    expect(job?.jobDescription).not.toContain("&nbsp;");
    expect(job?.locationEvidence).toMatchObject({
      country: "Indonesia",
      city: "Jakarta Utara",
      source: "dealls",
    });
  });

  it("maps list-only salary, internship type and city", () => {
    expect(mapDeallsJob(internDoc)).toEqual(
      expect.objectContaining({
        jobUrl: INTERN_URL,
        location: "Tangerang Selatan, Indonesia",
        salary: "IDR 3,000,000–4,000,000 / month",
        salaryMinAmount: 3_000_000,
        salaryMaxAmount: 4_000_000,
        salaryCurrency: "IDR",
        salaryInterval: "monthly",
        jobType: "Internship",
        jobDescription: undefined,
      }),
    );
  });

  it("keeps a city-only source location such as Jakarta Selatan through the location filter", () => {
    const job = mapDeallsJob({
      ...engineerDoc,
      city: { id: 158, name: "Jakarta Selatan" },
    });
    if (!job) throw new Error("expected a job");
    const intent = (cityLocations: string[]) =>
      normalizeLocationIntent({ selectedCountry: "indonesia", cityLocations });

    expect(job.locationEvidence?.country).toBe("Indonesia");
    expect(matchJobLocationIntent(job, intent([])).matched).toBe(true);
    expect(matchJobLocationIntent(job, intent(["Jakarta"])).matched).toBe(true);
    expect(
      matchJobLocationIntent(job, intent(["Jakarta Selatan"])).matched,
    ).toBe(true);
  });

  it("fetches details only for jobs that are not already known", async () => {
    const fetchMock = routedFetch({
      list: () => jsonResponse(searchSample),
      "/v1/job-portal/job/slug/software-engineer-42": () =>
        jsonResponse(detailSample),
    });
    const getExistingJobUrls = vi.fn().mockResolvedValue([INTERN_URL]);
    const events: unknown[] = [];

    const result = await runDealls({
      searchTerms: ["software engineer"],
      maxJobsPerTerm: 2,
      fetchImpl: fetchMock,
      sleep: noSleep,
      getExistingJobUrls,
      onProgress: (event) => events.push(event),
    });

    expect(result.success).toBe(true);
    expect(result.sourceErrors).toBeUndefined();
    expect(result.jobs.map((job) => job.jobUrl)).toEqual([
      ENGINEER_URL,
      INTERN_URL,
    ]);
    expect(result.jobs[0].jobDescription).toContain("Responsibilities");
    expect(result.jobs[1].jobDescription).toBeUndefined();
    // One list page (cap reached) plus one detail request.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(noSleep).toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "details",
        detailsTotal: 2,
        detailsFetched: 1,
        detailsSkipped: 1,
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "term_complete",
      searchTerm: "software engineer",
      jobsFoundTerm: 2,
    });
  });

  it("does not import a job whose detail request failed, so the next run retries it", async () => {
    const internDetail = {
      ...detailSample,
      data: {
        result: {
          ...detail,
          id: internDoc.id,
          slug: internDoc.slug,
          role: internDoc.role,
          company: {
            ...detail.company,
            slug: "dexa-group",
            name: "Dexa Group",
          },
        },
      },
    };
    const result = await runDealls({
      searchTerms: ["software engineer"],
      maxJobsPerTerm: 2,
      fetchImpl: routedFetch({
        list: () => jsonResponse(searchSample),
        "/v1/job-portal/job/slug/software-engineer-42": () =>
          jsonResponse({}, 502),
        "/v1/job-portal/job/slug/software-engineer-intern-14": () =>
          jsonResponse(internDetail),
      }),
      sleep: noSleep,
    });

    expect(result.success).toBe(true);
    expect(result.jobs.map((job) => job.jobUrl)).toEqual([INTERN_URL]);
    expect(result.sourceErrors).toEqual([
      "Dealls: 1 job detail request(s) failed; those jobs were not imported and will be retried on the next run (term: software engineer)",
    ]);
  });

  it("fails the source when every detail request fails", async () => {
    const result = await runDealls({
      searchTerms: ["software engineer"],
      maxJobsPerTerm: 1,
      fetchImpl: routedFetch({
        list: () => jsonResponse(searchSample),
        "/v1/job-portal/job/slug/software-engineer-42": () =>
          jsonResponse({}, 502),
      }),
      sleep: noSleep,
    });

    expect(result).toEqual({
      success: false,
      jobs: [],
      error:
        "Dealls: 1 job detail request(s) failed; those jobs were not imported and will be retried on the next run (term: software engineer)",
    });
  });

  it("filters requested cities before fetching details", async () => {
    const fetchMock = routedFetch({
      list: () =>
        jsonResponse({
          ...searchSample,
          data: { ...searchSample.data, totalPages: 1 },
        }),
      "/v1/job-portal/job/slug/software-engineer-intern-14": () =>
        jsonResponse({
          ...detailSample,
          data: {
            result: {
              ...detail,
              slug: internDoc.slug,
              location: {
                country: internDoc.country,
                city: internDoc.city,
              },
              company: { ...detail.company, slug: "dexa-group" },
            },
          },
        }),
    });

    const result = await runDealls({
      searchTerms: ["software engineer"],
      cities: ["South Tangerang"],
      maxJobsPerTerm: 2,
      fetchImpl: fetchMock,
      sleep: noSleep,
    });

    expect(result.jobs.map((job) => job.jobUrl)).toEqual([INTERN_URL]);
    // The Jakarta Utara job never gets a detail request.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns the jobs collected so far when the time budget runs out", async () => {
    let clock = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      clock += 60_000;
      const url = new URL(String(input));
      return url.pathname.startsWith("/v1/explore-job/")
        ? jsonResponse(searchSample)
        : jsonResponse(detailSample);
    });

    const result = await runDealls({
      searchTerms: ["software engineer"],
      maxJobsPerTerm: 2,
      fetchImpl: fetchMock,
      sleep: noSleep,
      now: () => clock,
      timeBudgetMs: 120_000,
    });

    // One term has the whole budget: list (0 -> 60s), first detail
    // (60 -> 120s); the second detail would start past the 2-minute budget.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.jobs.map((job) => job.jobUrl)).toEqual([ENGINEER_URL]);
    expect(result.sourceErrors).toEqual([
      "Dealls: stopped after 2 minutes to stay within the source time limit; kept the 1 jobs collected so far",
    ]);
  });

  it("drops jobs whose detail says they are closed", async () => {
    const result = await runDealls({
      searchTerms: ["software engineer"],
      maxJobsPerTerm: 1,
      fetchImpl: routedFetch({
        list: () => jsonResponse(searchSample),
        "/v1/job-portal/job/slug/software-engineer-42": () =>
          jsonResponse({
            ...detailSample,
            data: { result: { ...detail, closed: true } },
          }),
      }),
      sleep: noSleep,
    });

    expect(result).toEqual({ success: true, jobs: [] });
  });

  it("stops fetching details when cancelled", async () => {
    let cancelled = false;
    const fetchMock = routedFetch({
      list: () => jsonResponse(searchSample),
      "/v1/job-portal/job/slug/software-engineer-42": () => {
        cancelled = true;
        return jsonResponse(detailSample);
      },
    });

    const result = await runDealls({
      searchTerms: ["software engineer", "backend"],
      maxJobsPerTerm: 2,
      fetchImpl: fetchMock,
      sleep: noSleep,
      shouldCancel: () => cancelled,
    });

    expect(result.success).toBe(true);
    expect(result.jobs.map((job) => job.jobUrl)).toEqual([ENGINEER_URL]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns a status-only error when the list request fails", async () => {
    const result = await runDealls({
      searchTerms: ["software engineer"],
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({}, 503)),
      sleep: noSleep,
    });

    expect(result).toEqual({
      success: false,
      jobs: [],
      error: "Dealls request failed with status 503 (term: software engineer)",
    });
  });
});
