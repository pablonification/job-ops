import { matchJobLocationIntent } from "@shared/job-matching";
import { normalizeLocationIntent } from "@shared/location-domain";
import { describe, expect, it, vi } from "vitest";
import {
  buildJobStreetDetailRequest,
  buildJobStreetSearchUrl,
  mapJobStreetJob,
  runJobStreet,
} from "../src/run";
// Fixture sources: search.json rows 1-2 and detail.json are the recorded
// research samples (Indonesian locale); search.json rows 3-4,
// search-tangerang.json (`where=Tangerang`) and search-unknown-where.json
// (`where=Qwzxville`) are trimmed copies of live responses received on
// 2026-11-17 with `locale=en-ID`.
import detailSample from "./fixtures/detail.json";
import searchSample from "./fixtures/search.json";
import tangerangSample from "./fixtures/search-tangerang.json";
import unknownWhereSample from "./fixtures/search-unknown-where.json";

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

const [managerRow, drafterRow, remoteRow, hybridRow] = searchSample.data;
// The recorded rows answer "software engineer" sorted by date, so most
// titles are unrelated; one is renamed to give the term two matches.
const engineerRow = { ...managerRow, title: "Software Engineer" };
const ENGINEER_URL = "https://id.jobstreet.com/job/95924141";
const REMOTE_URL = "https://id.jobstreet.com/job/95949297";
const noSleep = vi.fn().mockResolvedValue(undefined);

const [tangerangRow, , westJakartaRow] = tangerangSample.data;
// How JobStreet answers a recognised `where` (from the live Jakarta search).
const JAKARTA_LOCATION = {
  description: "Jakarta",
  type: "State",
  whereId: "2030500",
};

function searchPage(
  rows: unknown[],
  totalCount = rows.length,
  location?: unknown,
) {
  return { totalCount, data: rows, ...(location ? { location } : {}) };
}

function retitled(
  row: (typeof searchSample.data)[number],
  id: string,
  title: string,
) {
  return { ...row, id, title };
}

type Route = (url: URL) => Response | Promise<Response>;

/** Answers searches with `list` and detail requests by job id. */
function routedFetch(list: Route, details: Record<string, Route> = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/jobsearch/v5/search") return list(url);
    if (url.pathname === "/graphql") {
      const body = JSON.parse(String(init?.body));
      const handler = details[body.variables.jobId];
      return handler ? handler() : jsonResponse(detailSample);
    }
    throw new Error(`unexpected request ${url.pathname}`);
  });
}

describe("JobStreet extractor", () => {
  it("builds a newest-first Indonesia search URL with optional filters", () => {
    const url = buildJobStreetSearchUrl({
      searchTerm: "software engineer",
      page: 2,
      pageSize: 100,
    });

    expect(url.origin + url.pathname).toBe(
      "https://id.jobstreet.com/api/jobsearch/v5/search",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      siteKey: "ID-Main",
      sourcesystem: "houston",
      keywords: "software engineer",
      page: "2",
      pageSize: "20",
      sortmode: "ListedDate",
      locale: "en-ID",
    });

    const filtered = buildJobStreetSearchUrl({
      searchTerm: "backend",
      page: 1,
      pageSize: 20,
      where: "Jakarta",
      workplaceTypes: ["remote", "hybrid"],
    });
    expect(filtered.searchParams.get("where")).toBe("Jakarta");
    expect(filtered.searchParams.get("workarrangement")).toBe("2,3");
    expect(filtered.searchParams.has("daterange")).toBe(false);
    expect(
      buildJobStreetSearchUrl({
        searchTerm: "qa",
        page: 1,
        pageSize: 20,
        workplaceTypes: ["remote", "hybrid", "onsite"],
      }).searchParams.has("workarrangement"),
    ).toBe(false);
  });

  it("builds the detail GraphQL body with only the variables its query uses", () => {
    const body = buildJobStreetDetailRequest("95924141");

    expect(body.operationName).toBe("jobDetails");
    expect(body.variables.jobId).toBe("95924141");
    const declared = [...body.query.matchAll(/\$(\w+):/g)].map(
      (match) => match[1],
    );
    expect(Object.keys(body.variables).sort()).toEqual(declared.sort());
    expect(body.query).toContain("content(platform: WEB)");
  });

  it("maps a search result enriched by its detail", () => {
    const job = mapJobStreetJob(managerRow, detailSample.data.jobDetails.job);

    expect(job).toEqual(
      expect.objectContaining({
        source: "jobstreet",
        sourceJobId: "95924141",
        title: "PROJECT TEST MANAGER",
        employer: "PT SHIYUN TECHNOLOGY INDONESIA",
        jobUrl: ENGINEER_URL,
        applicationLink: ENGINEER_URL,
        location: "Cikarang Pusat, Jawa Barat, Indonesia",
        datePosted: "2026-11-16T10:06:08Z",
        salary: "IDR 20,000,000–30,000,000 / month",
        salaryMinAmount: 20_000_000,
        salaryMaxAmount: 30_000_000,
        salaryCurrency: "IDR",
        salaryInterval: "monthly",
        jobType: "Full time",
        jobFunction: "Manajemen Proyek",
        isRemote: false,
        workFromHomeType: "onsite",
        companyLogo:
          "https://bx-branding-gateway.cloud.seek.com.au/3a853d77-49a7-4304-92c0-ac3fafb361e2.1/jdpLogo",
      }),
    );
    expect(job?.jobDescription).toMatch(/^<h2>About the Role<\/h2>/);
    expect(job?.jobDescription).toMatch(/<\/ol>$/);
    expect(job?.locationEvidence).toMatchObject({
      country: "Indonesia",
      city: "Cikarang Pusat",
      regionHints: ["Jawa Barat"],
      source: "jobstreet",
    });
  });

  it("maps remote and hybrid results, anonymous advertisers and missing salaries", () => {
    expect(mapJobStreetJob(remoteRow)).toEqual(
      expect.objectContaining({
        employer: "Private Advertiser",
        location: "Jakarta, Indonesia",
        isRemote: true,
        workFromHomeType: "remote",
        salaryMinAmount: 6_000_000,
        jobDescription: undefined,
      }),
    );
    expect(mapJobStreetJob(drafterRow)?.employer).toBe("Pengiklan Anonim");
    const hybrid = mapJobStreetJob(hybridRow);
    expect(hybrid).toEqual(
      expect.objectContaining({
        location: "South Jakarta, Jakarta, Indonesia",
        workFromHomeType: "hybrid",
        isRemote: false,
      }),
    );
    expect(hybrid?.salary).toBeUndefined();
    expect(hybrid?.locationEvidence?.city).toBe("Jakarta Selatan");
  });

  it("skips results outside Indonesia and rows without an id", () => {
    expect(
      mapJobStreetJob({
        ...remoteRow,
        locations: [{ label: "Singapore", countryCode: "SG" }],
      }),
    ).toBeNull();
    expect(mapJobStreetJob({ ...remoteRow, id: "" })).toBeNull();
  });

  it("keeps a district-level location through the shared location filter", () => {
    // "South Jakarta, Jakarta" as received from the live en-ID search.
    const job = mapJobStreetJob(hybridRow);
    if (!job) throw new Error("expected a job");
    const intent = (cityLocations: string[]) =>
      normalizeLocationIntent({ selectedCountry: "indonesia", cityLocations });

    expect(matchJobLocationIntent(job, intent([])).matched).toBe(true);
    for (const city of ["Jakarta", "Jakarta Selatan", "South Jakarta"]) {
      expect(matchJobLocationIntent(job, intent([city])).matched).toBe(true);
    }
    expect(matchJobLocationIntent(job, intent(["Bandung"])).matched).toBe(
      false,
    );

    // "Tangerang District, Banten" as received from the live Tangerang search.
    const regency = mapJobStreetJob(tangerangRow);
    if (!regency) throw new Error("expected a job");
    expect(regency.location).toBe("Tangerang District, Banten, Indonesia");
    expect(matchJobLocationIntent(regency, intent(["Tangerang"])).matched).toBe(
      true,
    );
    expect(
      matchJobLocationIntent(regency, intent(["Tangerang Selatan"])).matched,
    ).toBe(false);
  });

  it("counts the posting's work type as a level for the title check", async () => {
    const internship = {
      ...retitled(remoteRow, "3001", "Software Engineer"),
      workTypes: ["Internship"],
    };
    const fullTime = retitled(remoteRow, "3002", "Software Engineer");
    const result = await runJobStreet({
      searchTerms: ["software engineer intern"],
      fetchImpl: routedFetch(() =>
        jsonResponse(searchPage([internship, fullTime])),
      ),
      sleep: noSleep,
    });

    expect(result.jobs.map((job) => job.sourceJobId)).toEqual(["3001"]);
  });

  it("splits the cap between cities and hands an unused share to the others", async () => {
    const jakartaRows = [1, 2, 3, 4, 5].map((n) =>
      retitled(remoteRow, `100${n}`, "Backend Engineer"),
    );
    const tangerangRows = [
      retitled(tangerangRow, tangerangRow.id, "Backend Engineer"),
      ...tangerangSample.data.slice(1),
    ];
    const fetchMock = routedFetch((url) =>
      url.searchParams.get("where") === "Jakarta"
        ? jsonResponse(searchPage(jakartaRows, 5, JAKARTA_LOCATION))
        : jsonResponse({ ...tangerangSample, data: tangerangRows }),
    );

    const result = await runJobStreet({
      searchTerms: ["backend engineer"],
      cities: ["Jakarta", "Tangerang"],
      maxJobsPerTerm: 4,
      fetchImpl: fetchMock,
      sleep: noSleep,
    });

    // Two each at first; Tangerang has one match, so Jakarta takes the rest.
    expect(result.jobs.map((job) => job.sourceJobId)).toEqual([
      "1001",
      "1002",
      tangerangRow.id,
      "1003",
    ]);
    const searches = fetchMock.mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((url) => url.pathname.endsWith("/search"));
    expect(searches.map((url) => url.searchParams.get("where"))).toEqual([
      "Jakarta",
      "Tangerang",
    ]);
    // The other Tangerang results are not backend roles.
    expect(westJakartaRow.title).toBe("DRAFTER ENGINEERING (PANEL LISTRIK)");
  });

  it("keeps the term's scan bound across all cities", async () => {
    const unrelated = (prefix: string) =>
      Array.from({ length: 5 }, (_, n) =>
        retitled(remoteRow, `${prefix}${n}`, "Account Executive"),
      );
    const fetchMock = routedFetch((url) =>
      jsonResponse(
        searchPage(
          unrelated(
            `${url.searchParams.get("where")}-${url.searchParams.get("page")}-`,
          ),
          1000,
          JAKARTA_LOCATION,
        ),
      ),
    );

    await runJobStreet({
      searchTerms: ["backend engineer"],
      cities: ["Jakarta", "Tangerang"],
      maxJobsPerTerm: 4,
      pageSize: 5,
      fetchImpl: fetchMock,
      sleep: noSleep,
    });

    // At most 3 x 4 = 12 results for the term: 6 per city, so two pages each.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("reports a location JobStreet does not recognise instead of succeeding with nothing", async () => {
    const fetchMock = routedFetch((url) =>
      url.searchParams.get("where") === "Jakarta"
        ? jsonResponse(searchPage([remoteRow], 1, JAKARTA_LOCATION))
        : jsonResponse(unknownWhereSample),
    );

    const result = await runJobStreet({
      searchTerms: ["software engineer"],
      cities: ["Qwzxville", "Jakarta"],
      fetchImpl: fetchMock,
      sleep: noSleep,
    });

    expect(result.success).toBe(true);
    expect(result.jobs.map((job) => job.jobUrl)).toEqual([REMOTE_URL]);
    expect(result.sourceErrors).toEqual([
      'JobStreet: the location "Qwzxville" was not recognised, so no jobs were searched there (term: software engineer)',
    ]);

    const alone = await runJobStreet({
      searchTerms: ["software engineer"],
      cities: ["Qwzxville"],
      fetchImpl: routedFetch(() => jsonResponse(unknownWhereSample)),
      sleep: noSleep,
    });
    expect(alone).toEqual({
      success: true,
      jobs: [],
      sourceErrors: [
        'JobStreet: the location "Qwzxville" was not recognised, so no jobs were searched there (term: software engineer)',
      ],
    });
  });

  it("keeps matching titles, fetches details for new jobs and skips known ones", async () => {
    const fetchMock = routedFetch(() =>
      jsonResponse(searchPage([engineerRow, drafterRow, remoteRow, hybridRow])),
    );
    const getExistingJobUrls = vi.fn().mockResolvedValue([REMOTE_URL]);
    const events: unknown[] = [];

    const result = await runJobStreet({
      searchTerms: ["software engineer"],
      maxJobsPerTerm: 5,
      fetchImpl: fetchMock,
      sleep: noSleep,
      getExistingJobUrls,
      onProgress: (event) => events.push(event),
    });

    expect(result.success).toBe(true);
    expect(result.sourceErrors).toBeUndefined();
    expect(result.jobs.map((job) => job.jobUrl)).toEqual([
      ENGINEER_URL,
      REMOTE_URL,
    ]);
    expect(result.jobs[0].jobDescription).toContain("About the Role");
    expect(result.jobs[1].jobDescription).toBeUndefined();
    // One search page plus one detail request.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(noSleep).toHaveBeenCalled();
    const [, detailInit] = fetchMock.mock.calls[1];
    expect(detailInit?.method).toBe("POST");
    expect(detailInit?.headers).toMatchObject({
      "seek-request-brand": "jobstreet",
      "seek-request-country": "ID",
      "User-Agent": expect.stringContaining("Mozilla/5.0"),
    });
    expect(JSON.parse(String(detailInit?.body)).variables.jobId).toBe(
      "95924141",
    );
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

  it("sends cities as base cities and a narrower workplace choice to the search", async () => {
    const fetchMock = routedFetch(() => jsonResponse(searchPage([hybridRow])));

    const result = await runJobStreet({
      searchTerms: ["data scientist"],
      cities: ["South Jakarta", "Jakarta Selatan"],
      workplaceTypes: ["hybrid"],
      maxJobsPerTerm: 5,
      fetchImpl: fetchMock,
      sleep: noSleep,
    });

    expect(result.jobs.map((job) => job.jobUrl)).toEqual([
      "https://id.jobstreet.com/job/95918022",
    ]);
    const searches = fetchMock.mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((url) => url.pathname.endsWith("/search"));
    expect(searches).toHaveLength(1);
    expect(searches[0].searchParams.get("where")).toBe("Jakarta");
    expect(searches[0].searchParams.get("workarrangement")).toBe("2");
  });

  it("does not count jobs outside the requested cities toward the cap", async () => {
    const cikarangEngineer = { ...drafterRow, title: "Backend Engineer" };
    const fetchMock = routedFetch(() =>
      jsonResponse(searchPage([cikarangEngineer, remoteRow, hybridRow])),
    );

    const result = await runJobStreet({
      searchTerms: ["engineer"],
      cities: ["Jakarta"],
      maxJobsPerTerm: 1,
      fetchImpl: fetchMock,
      sleep: noSleep,
    });

    expect(result.jobs.map((job) => job.jobUrl)).toEqual([REMOTE_URL]);
    // The Cikarang job never gets a detail request.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("de-duplicates jobs returned by more than one term", async () => {
    const fetchMock = routedFetch(() =>
      jsonResponse(searchPage([engineerRow, remoteRow])),
    );

    const result = await runJobStreet({
      searchTerms: ["software engineer", "engineer"],
      maxJobsPerTerm: 5,
      fetchImpl: fetchMock,
      sleep: noSleep,
    });

    expect(result.jobs.map((job) => job.jobUrl)).toEqual([
      ENGINEER_URL,
      REMOTE_URL,
    ]);
    // Two details for the first term; the second term's page holds nothing new.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not import a job whose detail request failed, so the next run retries it", async () => {
    const result = await runJobStreet({
      searchTerms: ["software engineer"],
      maxJobsPerTerm: 5,
      fetchImpl: routedFetch(
        () => jsonResponse(searchPage([engineerRow, remoteRow])),
        {
          "95924141": () => jsonResponse({}, 502),
          "95949297": () =>
            jsonResponse({ data: { jobDetails: null }, errors: [{}] }),
        },
      ),
      sleep: noSleep,
    });

    expect(result).toEqual({
      success: false,
      jobs: [],
      error:
        "JobStreet: 2 job detail request(s) failed; those jobs were not imported and will be retried on the next run (term: software engineer)",
    });
  });

  it("keeps the other jobs when one detail request fails and drops expired jobs", async () => {
    const expired = {
      data: {
        jobDetails: {
          job: { ...detailSample.data.jobDetails.job, isExpired: true },
        },
      },
    };
    const result = await runJobStreet({
      searchTerms: ["engineer"],
      maxJobsPerTerm: 5,
      fetchImpl: routedFetch(
        () =>
          jsonResponse(
            searchPage([
              engineerRow,
              remoteRow,
              { ...hybridRow, title: "Data Engineer" },
            ]),
          ),
        {
          "95924141": () => jsonResponse({}, 500),
          "95949297": () => jsonResponse(expired),
        },
      ),
      sleep: noSleep,
    });

    expect(result.success).toBe(true);
    expect(result.jobs.map((job) => job.sourceJobId)).toEqual(["95918022"]);
    expect(result.sourceErrors).toEqual([
      "JobStreet: 1 job detail request(s) failed; those jobs were not imported and will be retried on the next run (term: engineer)",
    ]);
  });

  it("pages until the cap and stops at the last page", async () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      ...remoteRow,
      id: String(1000 + index),
      title: `Software Engineer ${index}`,
    }));
    let page = 0;
    const fetchMock = routedFetch(() => {
      page += 1;
      return jsonResponse(
        searchPage(page === 1 ? rows : [{ ...remoteRow, id: "2000" }], 21),
      );
    });

    const result = await runJobStreet({
      searchTerms: ["software engineer"],
      maxJobsPerTerm: 50,
      fetchImpl: fetchMock,
      sleep: noSleep,
    });

    expect(result.jobs).toHaveLength(21);
    expect(page).toBe(2);
  });

  it("stops fetching details when cancelled", async () => {
    let cancelled = false;
    const fetchMock = routedFetch(
      () => jsonResponse(searchPage([engineerRow, remoteRow])),
      {
        "95924141": () => {
          cancelled = true;
          return jsonResponse(detailSample);
        },
      },
    );

    const result = await runJobStreet({
      searchTerms: ["software engineer", "backend"],
      maxJobsPerTerm: 5,
      fetchImpl: fetchMock,
      sleep: noSleep,
      shouldCancel: () => cancelled,
    });

    expect(result.success).toBe(true);
    expect(result.jobs.map((job) => job.jobUrl)).toEqual([ENGINEER_URL]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns a status-only error when the search fails, and keeps other terms", async () => {
    let calls = 0;
    const fetchMock = routedFetch(() => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ message: "secret upstream text" }, 503)
        : jsonResponse(searchPage([remoteRow]));
    });

    const result = await runJobStreet({
      searchTerms: ["backend", "software engineer"],
      fetchImpl: fetchMock,
      sleep: noSleep,
    });

    expect(result.success).toBe(true);
    expect(result.jobs.map((job) => job.jobUrl)).toEqual([REMOTE_URL]);
    expect(result.sourceErrors).toEqual([
      "JobStreet request failed with status 503 (term: backend)",
    ]);

    const failed = await runJobStreet({
      searchTerms: ["backend"],
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({ oops: true })),
      sleep: noSleep,
    });
    expect(failed).toEqual({
      success: false,
      jobs: [],
      error: "JobStreet returned an invalid jobs response (term: backend)",
    });
  });
});
