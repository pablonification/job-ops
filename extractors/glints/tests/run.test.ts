import { matchJobLocationIntent } from "@shared/job-matching";
import { normalizeLocationIntent } from "@shared/location-domain";
import { describe, expect, it, vi } from "vitest";
import {
  buildGlintsDetailRequest,
  buildGlintsSearchRequest,
  mapGlintsJob,
  runGlints,
} from "../src/run";
// Fixture sources: search.json and detail.json are live searchJobsV3
// ("backend engineer", pageSize 4) and getJobById responses received on
// 2026-11-17 with the place hierarchy and status; search-recorded.json is
// the recorded research sample, whose `location` only has `formattedName`
// (a district) and `city: null`.
import detailSample from "./fixtures/detail.json";
import searchSample from "./fixtures/search.json";
import recordedSample from "./fixtures/search-recorded.json";

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

const liveRows = searchSample.data.searchJobsV3.jobsInPage;
const [golangRow, javaRow, juniorRow, pondokRow] = liveRows;
const [recordedIntern, recordedDeveloper] =
  recordedSample.data.searchJobsV3.jobsInPage;
const detail = detailSample.data.getJobById;
const rows: Array<{ id: string }> = [
  ...liveRows,
  recordedIntern,
  recordedDeveloper,
];
const jobUrl = (id: string) => `https://glints.com/id/opportunities/jobs/${id}`;
const GOLANG_URL = jobUrl(golangRow.id);
const INTERN_URL = jobUrl(recordedIntern.id);
const noSleep = vi.fn().mockResolvedValue(undefined);

function searchPage(jobs: unknown[], hasMore = false) {
  return {
    data: { searchJobsV3: { hasMore, jobsInPage: jobs } },
    isAuthenticated: false,
  };
}

/** A detail response for a search row: the row's fields plus the recorded description. */
function detailFor(row: { id: string }) {
  return {
    data: {
      getJobById: {
        ...detail,
        ...row,
        descriptionJsonString: detail.descriptionJsonString,
      },
    },
  };
}

type Route = (body: {
  variables: Record<string, unknown>;
}) => Response | Promise<Response>;

/** Answers searches with `list` and detail requests by job id. */
function routedFetch(list: Route, details: Record<string, Route> = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body));
    if (url.searchParams.get("op") === "searchJobsV3") return list(body);
    if (url.searchParams.get("op") === "getJobById") {
      const handler = details[body.variables.id];
      if (handler) return handler(body);
      if (body.variables.id === detail.id) return jsonResponse(detailSample);
      const row = rows.find((candidate) => candidate.id === body.variables.id);
      return jsonResponse(detailFor(row ?? { id: body.variables.id }));
    }
    throw new Error(`unexpected request ${url}`);
  });
}

function searchBody(mock: ReturnType<typeof routedFetch>, call = 0) {
  return JSON.parse(String(mock.mock.calls[call][1]?.body)).variables.data;
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
    const body = buildGlintsDetailRequest(recordedIntern.id);
    expect(body.operationName).toBe("getJobById");
    expect(body.variables).toEqual({ id: recordedIntern.id });
    expect(body.query).toMatch(/^query getJobById\(\$id: String!\)/);
    expect(body.query).toContain("descriptionJsonString");
  });

  it("maps a recorded search row enriched by its live detail", () => {
    const job = mapGlintsJob(recordedIntern, detail, "<p>Text</p>");

    expect(job).toEqual(
      expect.objectContaining({
        source: "glints",
        sourceJobId: "55a19578-f3d7-4588-a77e-28c201108fa4",
        title: "Software Engineer Intern",
        employer: "AKSION DIGITAL INDONESIA",
        jobUrl: INTERN_URL,
        applicationLink: INTERN_URL,
        // The detail's hierarchy: Pagedangan -> Kab. Tangerang -> Banten.
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
    expect(job?.locationEvidence?.cityUnknown).toBeUndefined();
  });

  it("maps live search rows: legal names, contract jobs and hidden salaries", () => {
    expect(mapGlintsJob(golangRow)).toEqual(
      expect.objectContaining({
        employer: "Pt. Empore Hezer Tama",
        salary: "IDR 13,500,000–18,000,000 / month",
        jobType: "Contract",
        experienceRange: "1–3 years",
        workFromHomeType: "onsite",
        isRemote: false,
      }),
    );
    // Received with `salaries: null` and `shouldShowSalary: false`.
    const hidden = mapGlintsJob(juniorRow);
    expect(hidden?.salary).toBeUndefined();
    expect(hidden?.salaryMinAmount).toBeUndefined();
    expect(mapGlintsJob(recordedDeveloper)).toEqual(
      expect.objectContaining({
        salary: "IDR from 2,000,000 / month",
        salaryMaxAmount: undefined,
        jobType: "Project-based",
        workFromHomeType: "hybrid",
      }),
    );
  });

  it("does not let an upstream job type reach a prototype key", () => {
    expect(mapGlintsJob({ ...golangRow, type: "constructor" })?.jobType).toBe(
      "constructor",
    );
  });

  it("skips closed jobs and jobs outside Indonesia", () => {
    expect(mapGlintsJob({ ...golangRow, status: "CLOSED" })).toBeNull();
    expect(mapGlintsJob(golangRow, { status: "CLOSED" })).toBeNull();
    expect(
      mapGlintsJob({
        ...golangRow,
        country: { code: "SG", name: "Singapore" },
      }),
    ).toBeNull();
  });

  it("keeps a district-level location through the shared location filter", () => {
    // Kebayoran Baru -> Jakarta Selatan -> DKI Jakarta, as received live.
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

  it("keeps a job without a place hierarchy as city-unknown", () => {
    // The recorded shape: `location: { formattedName: "Sumbersari" }`, no city.
    const job = mapGlintsJob(recordedDeveloper);
    if (!job) throw new Error("expected a job");

    expect(job.location).toBe("Sumbersari, Indonesia");
    expect(job.locationEvidence).toMatchObject({
      country: "Indonesia",
      city: null,
      cityUnknown: true,
    });
    const intent = normalizeLocationIntent({
      selectedCountry: "indonesia",
      cityLocations: ["Jakarta"],
    });
    expect(matchJobLocationIntent(job, intent).matched).toBe(true);

    // A hierarchy that stops above city level is city-unknown too.
    const province = mapGlintsJob({
      ...golangRow,
      location: golangRow.location.parents[1],
    });
    expect(province?.location).toBe("DKI Jakarta, Indonesia");
    expect(province?.locationEvidence?.cityUnknown).toBe(true);
  });

  it("keeps city-unknown jobs when a city is selected", async () => {
    const fetchMock = routedFetch(() =>
      jsonResponse(searchPage([recordedDeveloper, pondokRow])),
    );

    const result = await runGlints({
      searchTerms: ["software developer"],
      cities: ["Jakarta"],
      fetchImpl: fetchMock,
      sleep: noSleep,
    });

    // Sumbersari has no known city and is kept; Pondok Aren is in Tangerang
    // Selatan, so a Jakarta filter drops it before any detail request.
    expect(result.jobs.map((job) => job.sourceJobId)).toEqual([
      recordedDeveloper.id,
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("asks for the whole first page with the device cookie, keeps matching titles and skips known jobs", async () => {
    const fetchMock = routedFetch(() =>
      jsonResponse(
        searchPage([
          recordedIntern,
          {
            ...recordedDeveloper,
            id: "x-1",
            title: "Mekanik Electrical Engineer",
          },
          golangRow,
        ]),
      ),
    );
    const getExistingJobUrls = vi.fn().mockResolvedValue([GOLANG_URL]);
    const events: unknown[] = [];

    const result = await runGlints({
      searchTerms: ["software engineer"],
      maxJobsPerTerm: 1,
      fetchImpl: fetchMock,
      sleep: noSleep,
      getExistingJobUrls,
      onProgress: (event) => events.push(event),
    });

    expect(result.success).toBe(true);
    expect(result.sourceErrors).toBeUndefined();
    expect(result.jobs.map((job) => job.jobUrl)).toEqual([INTERN_URL]);
    expect(result.jobs[0].jobDescription).toContain(
      "<p><strong>Deskripsi Pekerjaan</strong></p>",
    );
    // One search (first page only) plus one detail request.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://glints.com/api/v2/graphql?op=searchJobsV3",
    );
    // The cap is 1, but the page costs the same, so all 50 are requested.
    expect(searchBody(fetchMock)).toMatchObject({ page: 1, pageSize: 50 });
    const cookies = fetchMock.mock.calls.map(
      ([, init]) => (init?.headers as Record<string, string>).Cookie,
    );
    expect(cookies[0]).toMatch(
      /^deviceid=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(new Set(cookies).size).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "term_complete",
      searchTerm: "software engineer",
      jobsFoundTerm: 1,
    });
  });

  it("skips detail requests for jobs already in job-ops", async () => {
    const fetchMock = routedFetch(() =>
      jsonResponse(searchPage([golangRow, javaRow])),
    );
    const events: unknown[] = [];

    const result = await runGlints({
      searchTerms: ["backend engineer"],
      fetchImpl: fetchMock,
      sleep: noSleep,
      getExistingJobUrls: vi.fn().mockResolvedValue([GOLANG_URL]),
      onProgress: (event) => events.push(event),
    });

    expect(result.jobs.map((job) => job.jobUrl)).toEqual([
      GOLANG_URL,
      jobUrl(javaRow.id),
    ]);
    expect(result.jobs[0].jobDescription).toBeUndefined();
    expect(result.jobs[1].jobDescription).toContain("Deskripsi Pekerjaan");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "details",
        detailsTotal: 2,
        detailsFetched: 1,
        detailsSkipped: 1,
      }),
    );
  });

  it("notes when a full first page limited a term's results", async () => {
    const fullPage = Array.from({ length: 50 }, (_, n) => ({
      ...golangRow,
      id: `full-${n}`,
    }));
    const result = await runGlints({
      searchTerms: ["backend engineer"],
      maxJobsPerTerm: 2,
      fetchImpl: routedFetch(() => jsonResponse(searchPage(fullPage, true))),
      sleep: noSleep,
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(2);
    expect(result.sourceErrors).toEqual([
      "Glints: results were limited to the first page (50 jobs), the most Glints serves without login (term: backend engineer)",
    ]);
  });

  it("counts the posting's job type as a level for the title check", async () => {
    const internshipTitledPlainly = {
      ...recordedIntern,
      title: "Software Engineer",
    };
    const result = await runGlints({
      searchTerms: ["software engineer intern"],
      fetchImpl: routedFetch(() =>
        jsonResponse(searchPage([internshipTitledPlainly, golangRow])),
      ),
      sleep: noSleep,
    });

    // INTERNSHIP counts as "intern"; the contract Golang job does not.
    expect(result.jobs.map((job) => job.sourceJobId)).toEqual([
      recordedIntern.id,
    ]);
  });

  it("uses a new device id per run and sends a narrower workplace choice", async () => {
    const first = routedFetch(() => jsonResponse(searchPage([])));
    const second = routedFetch(() => jsonResponse(searchPage([])));
    await runGlints({ maxJobsPerTerm: 1, fetchImpl: first, sleep: noSleep });
    await runGlints({
      maxJobsPerTerm: 30,
      fetchImpl: second,
      sleep: noSleep,
      workplaceTypes: ["onsite"],
    });

    const headers = (mock: typeof first) =>
      mock.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers(first).Cookie).not.toBe(headers(second).Cookie);
    expect(searchBody(first)).not.toHaveProperty("workArrangementOptions");
    expect(searchBody(second)).toMatchObject({
      pageSize: 50,
      workArrangementOptions: ["ONSITE"],
    });
  });

  it("retries without a rejected workplace filter and filters locally for the rest of the run", async () => {
    const remoteJava = { ...javaRow, workArrangementOption: "REMOTE" };
    const fetchMock = routedFetch((body) => {
      const data = body.variables.data as Record<string, unknown>;
      return data.workArrangementOptions
        ? jsonResponse({
            errors: [
              {
                message: 'Variable "$data" got invalid value "ONSITE"',
                extensions: { code: "BAD_USER_INPUT" },
              },
            ],
          })
        : jsonResponse(searchPage([golangRow, remoteJava]));
    });

    const result = await runGlints({
      searchTerms: ["backend developer", "golang"],
      workplaceTypes: ["onsite"],
      fetchImpl: fetchMock,
      sleep: noSleep,
    });

    expect(result.success).toBe(true);
    // The remote Java job is dropped locally; Golang is on-site.
    expect(result.jobs.map((job) => job.sourceJobId)).toEqual([golangRow.id]);
    expect(result.sourceErrors).toEqual([
      "Glints: Glints rejected its work-arrangement filter, so job-ops now filters workplace types itself (term: backend developer)",
    ]);
    const searches = fetchMock.mock.calls
      .filter(([input]) => String(input).endsWith("searchJobsV3"))
      .map(([, init]) => JSON.parse(String(init?.body)).variables.data);
    // Rejected once, retried without it, and not sent again for "golang".
    expect(searches.map((data) => "workArrangementOptions" in data)).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("also retries when the filter is rejected with HTTP 400", async () => {
    let calls = 0;
    const result = await runGlints({
      searchTerms: ["backend developer"],
      workplaceTypes: ["remote", "onsite"],
      fetchImpl: routedFetch(() => {
        calls += 1;
        return calls === 1
          ? jsonResponse({}, 400)
          : jsonResponse(searchPage([golangRow]));
      }),
      sleep: noSleep,
    });

    expect(result.jobs.map((job) => job.sourceJobId)).toEqual([golangRow.id]);
    expect(result.sourceErrors).toHaveLength(1);
  });

  it("imports a job with an unreadable description and reports a source error", async () => {
    const result = await runGlints({
      searchTerms: ["backend engineer"],
      fetchImpl: routedFetch(() => jsonResponse(searchPage([golangRow])), {
        [golangRow.id]: () =>
          jsonResponse({
            data: {
              getJobById: { ...golangRow, descriptionJsonString: "{not json" },
            },
          }),
      }),
      sleep: noSleep,
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].jobDescription).toBeUndefined();
    expect(result.jobs[0].title).toBe("Golang Backend Developer");
    expect(result.sourceErrors).toEqual([
      "Glints: 1 job description(s) could not be read; those jobs were imported without a description (term: backend engineer)",
    ]);
  });

  it("does not import jobs whose detail request failed and drops closed ones", async () => {
    const result = await runGlints({
      searchTerms: ["backend developer"],
      fetchImpl: routedFetch(
        () => jsonResponse(searchPage([golangRow, javaRow, pondokRow])),
        {
          [golangRow.id]: () => jsonResponse({}, 502),
          [javaRow.id]: () =>
            jsonResponse({ data: { getJobById: null }, errors: [{}] }),
          [pondokRow.id]: () =>
            jsonResponse({
              data: { getJobById: { ...pondokRow, status: "CLOSED" } },
            }),
        },
      ),
      sleep: noSleep,
    });

    expect(result).toEqual({
      success: false,
      jobs: [],
      error:
        "Glints: 2 job detail request(s) failed; those jobs were not imported and will be retried on the next run (term: backend developer)",
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
          return jsonResponse(detailFor(golangRow));
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
