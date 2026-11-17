import { matchJobLocationIntent } from "@shared/job-matching";
import { normalizeLocationIntent } from "@shared/location-domain";
import { describe, expect, it, vi } from "vitest";
import {
  buildGlintsDetailRequest,
  buildGlintsSearchRequest,
  mapGlintsJob,
  runGlints,
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

const rows = searchSample.data.searchJobsV3.jobsInPage;
const [internRow, developerRow, golangRow, javaRow] = rows;
const detail = detailSample.data.getJobById;
const INTERN_URL =
  "https://glints.com/id/opportunities/jobs/55a19578-f3d7-4588-a77e-28c201108fa4";
const GOLANG_URL =
  "https://glints.com/id/opportunities/jobs/f8a490b0-7c1f-4409-9667-f7cd127eceec";
const noSleep = vi.fn().mockResolvedValue(undefined);

function searchPage(jobs: unknown[]) {
  return {
    data: { searchJobsV3: { hasMore: true, jobsInPage: jobs } },
    isAuthenticated: false,
  };
}

type Route = () => Response | Promise<Response>;

/** Answers searches with `list` and detail requests by job id. */
function routedFetch(list: Route, details: Record<string, Route> = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body));
    if (url.searchParams.get("op") === "searchJobsV3") return list();
    if (url.searchParams.get("op") === "getJobById") {
      const handler = details[body.variables.id];
      if (handler) return handler();
      const row = rows.find((candidate) => candidate.id === body.variables.id);
      return jsonResponse({
        data: {
          getJobById: {
            ...detail,
            ...row,
            descriptionJsonString: detail.descriptionJsonString,
          },
        },
      });
    }
    throw new Error(`unexpected request ${url}`);
  });
}

describe("Glints extractor", () => {
  it("builds a first-page, newest-first search body", () => {
    const body = buildGlintsSearchRequest({
      searchTerm: "software engineer",
      pageSize: 500,
    });

    expect(body.operationName).toBe("searchJobsV3");
    expect(body.variables).toEqual({
      data: {
        CountryCode: "ID",
        SearchTerm: "software engineer",
        page: 1,
        pageSize: 50,
        sortBy: "LATEST",
      },
    });
    expect(body.query).toContain("searchJobsV3(data: $data)");
    expect(body.query).toContain("parents { name formattedName");

    expect(
      buildGlintsSearchRequest({
        searchTerm: "qa",
        pageSize: 3,
        workplaceTypes: ["remote", "hybrid"],
      }).variables.data,
    ).toMatchObject({
      pageSize: 3,
      workArrangementOptions: ["REMOTE", "HYBRID"],
    });
    expect(
      buildGlintsSearchRequest({
        searchTerm: "qa",
        pageSize: 3,
        workplaceTypes: ["remote", "hybrid", "onsite"],
      }).variables.data,
    ).not.toHaveProperty("workArrangementOptions");
  });

  it("builds the detail body", () => {
    const body = buildGlintsDetailRequest(internRow.id);
    expect(body.operationName).toBe("getJobById");
    expect(body.variables).toEqual({ id: internRow.id });
    expect(body.query).toMatch(/^query getJobById\(\$id: String!\)/);
    expect(body.query).toContain("descriptionJsonString");
  });

  it("maps a job with its structured salary, work arrangement and place hierarchy", () => {
    const job = mapGlintsJob(internRow, detail, "<p>Text</p>");

    expect(job).toEqual(
      expect.objectContaining({
        source: "glints",
        sourceJobId: "55a19578-f3d7-4588-a77e-28c201108fa4",
        title: "Software Engineer Intern",
        employer: "AKSION DIGITAL INDONESIA",
        jobUrl: INTERN_URL,
        applicationLink: INTERN_URL,
        location: "Pagedangan, Tangerang, Banten, Indonesia",
        jobDescription: "<p>Text</p>",
        datePosted: "2026-11-16T08:39:30.38099Z",
        salary: "IDR 800,000–1,000,000 / month",
        salaryMinAmount: 800_000,
        salaryMaxAmount: 1_000_000,
        salaryCurrency: "IDR",
        salaryInterval: "monthly",
        jobType: "Internship",
        experienceRange: "0–1 years",
        isRemote: true,
        workFromHomeType: "remote",
      }),
    );
    expect(job?.locationEvidence).toMatchObject({
      country: "Indonesia",
      city: "Tangerang",
      regionHints: ["Banten"],
      workplaceType: "remote",
      source: "glints",
    });
  });

  it("maps open-ended salaries, legal names, other job types and hidden salaries", () => {
    expect(mapGlintsJob(developerRow)).toEqual(
      expect.objectContaining({
        salary: "IDR from 2,000,000 / month",
        salaryMinAmount: 2_000_000,
        salaryMaxAmount: undefined,
        jobType: "Project-based",
        workFromHomeType: "hybrid",
        location: "Sumbersari, Jember, Jawa Timur, Indonesia",
      }),
    );
    expect(mapGlintsJob(golangRow)).toEqual(
      expect.objectContaining({
        employer: "Pt. Empore Hezer Tama",
        jobType: "Contract",
        workFromHomeType: "onsite",
        isRemote: false,
      }),
    );
    const hidden = mapGlintsJob({ ...golangRow, shouldShowSalary: false });
    expect(hidden?.salary).toBeUndefined();
    expect(hidden?.salaryMinAmount).toBeUndefined();
  });

  it("skips closed jobs and jobs outside Indonesia", () => {
    expect(mapGlintsJob({ ...internRow, status: "CLOSED" })).toBeNull();
    expect(mapGlintsJob(internRow, { status: "CLOSED" })).toBeNull();
    expect(
      mapGlintsJob({
        ...internRow,
        country: { code: "SG", name: "Singapore" },
      }),
    ).toBeNull();
  });

  it("falls back to the city field when there is no place hierarchy", () => {
    expect(
      mapGlintsJob({ ...internRow, location: null, city: { name: "Bandung" } })
        ?.location,
    ).toBe("Bandung, Indonesia");
  });

  it("keeps a district-level location through the shared location filter", () => {
    const job = mapGlintsJob(golangRow);
    if (!job) throw new Error("expected a job");
    const intent = (cityLocations: string[]) =>
      normalizeLocationIntent({ selectedCountry: "indonesia", cityLocations });

    expect(job.location).toBe(
      "Kebayoran Baru, Jakarta Selatan, DKI Jakarta, Indonesia",
    );
    expect(matchJobLocationIntent(job, intent([])).matched).toBe(true);
    for (const city of [
      "Jakarta",
      "Jakarta Selatan",
      "South Jakarta",
      "Kebayoran Baru",
    ]) {
      expect(matchJobLocationIntent(job, intent([city])).matched).toBe(true);
    }
    expect(matchJobLocationIntent(job, intent(["Bandung"])).matched).toBe(
      false,
    );
  });

  it("sends one search with the device cookie, keeps matching titles and skips known jobs", async () => {
    const fetchMock = routedFetch(() =>
      jsonResponse(
        searchPage([
          internRow,
          { ...developerRow, id: "x-1", title: "Mekanik Electrical Engineer" },
          golangRow,
        ]),
      ),
    );
    const getExistingJobUrls = vi.fn().mockResolvedValue([GOLANG_URL]);
    const events: unknown[] = [];

    const result = await runGlints({
      searchTerms: ["software engineer"],
      maxJobsPerTerm: 10,
      fetchImpl: fetchMock,
      sleep: noSleep,
      getExistingJobUrls,
      onProgress: (event) => events.push(event),
    });

    expect(result.success).toBe(true);
    expect(result.sourceErrors).toBeUndefined();
    expect(result.jobs.map((job) => job.jobUrl)).toEqual([
      INTERN_URL,
      GOLANG_URL,
    ]);
    expect(result.jobs[0].jobDescription).toContain(
      "<p><strong>Deskripsi Pekerjaan</strong></p>",
    );
    expect(result.jobs[1].jobDescription).toBeUndefined();
    // One search (first page only) plus one detail request.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [searchInput, searchInit] = fetchMock.mock.calls[0];
    expect(String(searchInput)).toBe(
      "https://glints.com/api/v2/graphql?op=searchJobsV3",
    );
    expect(JSON.parse(String(searchInit?.body)).variables.data).toMatchObject({
      page: 1,
      pageSize: 30,
    });
    const cookies = fetchMock.mock.calls.map(
      ([, init]) => (init?.headers as Record<string, string>).Cookie,
    );
    expect(cookies[0]).toMatch(
      /^deviceid=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(new Set(cookies).size).toBe(1);
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

  it("uses a new device id per run and the largest page for a city filter", async () => {
    const first = routedFetch(() => jsonResponse(searchPage([])));
    const second = routedFetch(() => jsonResponse(searchPage([])));
    await runGlints({ maxJobsPerTerm: 1, fetchImpl: first, sleep: noSleep });
    await runGlints({
      maxJobsPerTerm: 30,
      fetchImpl: second,
      sleep: noSleep,
      workplaceTypes: ["onsite"],
    });

    const init = (mock: typeof first) => mock.mock.calls[0][1];
    const headers = (mock: typeof first) =>
      init(mock)?.headers as Record<string, string>;
    expect(headers(first).Cookie).not.toBe(headers(second).Cookie);
    expect(JSON.parse(String(init(first)?.body)).variables.data.pageSize).toBe(
      3,
    );
    expect(JSON.parse(String(init(second)?.body)).variables.data).toMatchObject(
      { pageSize: 50, workArrangementOptions: ["ONSITE"] },
    );
  });

  it("filters cities before detail requests and does not count other cities toward the cap", async () => {
    const fetchMock = routedFetch(() =>
      jsonResponse(searchPage([internRow, developerRow, golangRow, javaRow])),
    );

    const result = await runGlints({
      searchTerms: ["backend developer"],
      cities: ["South Jakarta"],
      maxJobsPerTerm: 1,
      fetchImpl: fetchMock,
      sleep: noSleep,
    });

    // The intern (Tangerang) and developer (Jember) jobs neither match the
    // term nor the city; the first Jakarta Selatan job fills the cap.
    expect(result.jobs.map((job) => job.jobUrl)).toEqual([GOLANG_URL]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("imports a job with an unreadable description and reports a source error", async () => {
    const result = await runGlints({
      searchTerms: ["software engineer"],
      maxJobsPerTerm: 10,
      fetchImpl: routedFetch(() => jsonResponse(searchPage([internRow])), {
        [internRow.id]: () =>
          jsonResponse({
            data: {
              getJobById: { ...detail, descriptionJsonString: "{not json" },
            },
          }),
      }),
      sleep: noSleep,
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].jobDescription).toBeUndefined();
    expect(result.jobs[0].title).toBe("Software Engineer Intern");
    expect(result.sourceErrors).toEqual([
      "Glints: 1 job description(s) could not be read; those jobs were imported without a description (term: software engineer)",
    ]);
  });

  it("does not import jobs whose detail request failed and drops closed ones", async () => {
    const result = await runGlints({
      searchTerms: ["developer"],
      maxJobsPerTerm: 10,
      fetchImpl: routedFetch(
        () => jsonResponse(searchPage([internRow, developerRow, golangRow])),
        {
          [internRow.id]: () => jsonResponse({}, 502),
          [developerRow.id]: () =>
            jsonResponse({ data: { getJobById: null }, errors: [{}] }),
          [golangRow.id]: () =>
            jsonResponse({
              data: { getJobById: { ...detail, status: "CLOSED" } },
            }),
        },
      ),
      sleep: noSleep,
    });

    expect(result).toEqual({
      success: false,
      jobs: [],
      error:
        "Glints: 2 job detail request(s) failed; those jobs were not imported and will be retried on the next run (term: developer)",
    });
  });

  it("de-duplicates jobs returned by more than one term", async () => {
    const fetchMock = routedFetch(() =>
      jsonResponse(searchPage([golangRow, javaRow])),
    );

    const result = await runGlints({
      searchTerms: ["backend developer", "backend engineer"],
      fetchImpl: fetchMock,
      sleep: noSleep,
    });

    expect(result.jobs).toHaveLength(2);
    // Two searches and two details; the second term finds nothing new.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("stops fetching details when cancelled", async () => {
    let cancelled = false;
    const fetchMock = routedFetch(
      () => jsonResponse(searchPage([golangRow, javaRow])),
      {
        [golangRow.id]: () => {
          cancelled = true;
          return jsonResponse({
            data: {
              getJobById: {
                ...detail,
                ...golangRow,
                descriptionJsonString: detail.descriptionJsonString,
              },
            },
          });
        },
      },
    );

    const result = await runGlints({
      searchTerms: ["backend developer", "golang"],
      fetchImpl: fetchMock,
      sleep: noSleep,
      shouldCancel: () => cancelled,
    });

    expect(result.success).toBe(true);
    expect(result.jobs.map((job) => job.jobUrl)).toEqual([GOLANG_URL]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports the GraphQL error code (never the message) when the search is refused", async () => {
    const refused = await runGlints({
      searchTerms: ["backend"],
      fetchImpl: routedFetch(() =>
        jsonResponse({
          data: null,
          errors: [
            {
              message: "please login with token abc",
              extensions: { code: "NO_PERMISSION" },
            },
          ],
        }),
      ),
      sleep: noSleep,
    });
    expect(refused).toEqual({
      success: false,
      jobs: [],
      error:
        "Glints search returned GraphQL error NO_PERMISSION (term: backend)",
    });

    const failed = await runGlints({
      searchTerms: ["backend"],
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse({}, 503)),
      sleep: noSleep,
    });
    expect(failed).toEqual({
      success: false,
      jobs: [],
      error: "Glints request failed with status 503 (term: backend)",
    });
  });
});
