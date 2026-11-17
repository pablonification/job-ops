import type { JobBoardProgressEvent } from "@shared/extractors/indonesia/index.js";
import { describe, expect, it } from "vitest";
import { runIdBigTech } from "../src/run";
import blibliSearch from "./fixtures/blibli_search.json";
import gotoLever from "./fixtures/goto_lever.json";
import xenditBoard from "./fixtures/xendit_greenhouse.json";
import { jsonResponse, routedFetch, testOptions } from "./helpers";

const GOTO = "api.lever.co/v0/postings/GoToGroup";
const XENDIT = "boards-api.greenhouse.io/v1/boards/xendit/jobs";
const GRAB = "api.smartrecruiters.com/v1/companies/grab/postings";
const TIKTOK = "api.lifeattiktok.com/api/v1/public/supplier/search/job/posts";
const BLIBLI = "careers.blibli.com/ext/api/job/search";

describe("Indonesia Big Tech run", () => {
  it("scans only the enabled companies", async () => {
    const { fetchImpl, requests } = routedFetch({
      [GOTO]: () => jsonResponse(gotoLever),
      [XENDIT]: () => jsonResponse(xenditBoard),
    });
    const result = await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["xendit", "goto"],
      searchTerms: ["data scientist", "customer success manager"],
    });

    expect(requests.map((request) => request.url.host)).toEqual([
      "api.lever.co",
      "boards-api.greenhouse.io",
    ]);
    expect(result.success).toBe(true);
    expect(result.jobs.map((job) => job.employer)).toEqual(["GoTo", "Xendit"]);
  });

  it("reports a failing company and keeps the others' jobs", async () => {
    const { fetchImpl } = routedFetch({
      [GRAB]: () => jsonResponse({}, 403),
      [GOTO]: () => jsonResponse(gotoLever),
    });
    const result = await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["grab", "goto"],
      searchTerms: ["data scientist"],
    });

    expect(result.success).toBe(true);
    expect(result.jobs.map((job) => job.title)).toEqual([
      "Data Scientist Intern",
    ]);
    expect(result.sourceErrors).toEqual([
      "Grab request failed with status 403; skipped for the rest of this run (term: data scientist)",
    ]);
  });

  it("succeeds without jobs when one company fails and the others find nothing", async () => {
    const { fetchImpl } = routedFetch({
      [GRAB]: () => jsonResponse({ unexpected: true }),
      [GOTO]: () => jsonResponse(gotoLever),
    });
    const result = await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["grab", "goto"],
      searchTerms: ["golang"],
    });

    expect(result).toEqual({
      success: true,
      jobs: [],
      sourceErrors: [
        "Grab returned an invalid jobs response; skipped for the rest of this run (term: golang)",
      ],
    });
  });

  it("fails only when every enabled company fails", async () => {
    const { fetchImpl } = routedFetch({
      [GRAB]: () => jsonResponse({}, 503),
      [GOTO]: () => {
        throw new TypeError("fetch failed");
      },
    });
    const result = await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["grab", "goto"],
      searchTerms: ["engineer"],
    });

    expect(result).toEqual({
      success: false,
      jobs: [],
      error:
        "Grab request failed with status 503; skipped for the rest of this run (term: engineer); GoTo request failed (network error); skipped for the rest of this run (term: engineer)",
    });
  });

  it("reports a failed board once, not once per term", async () => {
    const { fetchImpl, requests } = routedFetch({
      [GOTO]: () => jsonResponse({}, 500),
      [XENDIT]: () => jsonResponse(xenditBoard),
    });
    const result = await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["goto", "xendit"],
      searchTerms: ["customer success manager", "product manager"],
    });

    // One request plus one retry for the 500, then never again this run.
    expect(
      requests.filter((request) => request.url.host === "api.lever.co"),
    ).toHaveLength(2);
    expect(result.success).toBe(true);
    expect(result.sourceErrors).toEqual([
      "GoTo request failed with status 500; skipped for the rest of this run (term: customer success manager)",
    ]);
  });

  it("skips a company that is down for the remaining terms", async () => {
    const { fetchImpl, requests } = routedFetch({
      [GRAB]: () => jsonResponse({}, 503),
      [GOTO]: () => jsonResponse(gotoLever),
    });
    const notes: string[] = [];
    const result = await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["grab", "goto"],
      searchTerms: ["data scientist", "associate", "intern"],
      onProgress: (event: JobBoardProgressEvent) => {
        if (event.type === "note" && event.detail.startsWith("Grab")) {
          notes.push(`${event.searchTerm} | ${event.detail}`);
        }
      },
    });

    // One request plus one retry for the 503, then never again this run.
    expect(
      requests.filter((request) =>
        request.url.host.includes("smartrecruiters"),
      ),
    ).toHaveLength(2);
    expect(result.sourceErrors).toEqual([
      "Grab request failed with status 503; skipped for the rest of this run (term: data scientist)",
    ]);
    expect(result.jobs.map((job) => job.title)).toEqual([
      "Data Scientist Intern",
      "Facilities and Maintenance Associate",
    ]);
    expect(notes).toEqual([
      "data scientist | Grab: searching",
      "data scientist | Grab: failed",
      "associate | Grab: skipped after an earlier failure",
      "intern | Grab: skipped after an earlier failure",
    ]);
  });

  it("retries a transient failure once and carries on", async () => {
    let calls = 0;
    const { fetchImpl, requests } = routedFetch({
      [GOTO]: () => {
        calls += 1;
        return calls === 1 ? jsonResponse({}, 429) : jsonResponse(gotoLever);
      },
    });
    const result = await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["goto"],
      searchTerms: ["data scientist", "intern"],
    });

    expect(requests).toHaveLength(2);
    expect(result).toEqual({
      success: true,
      jobs: [expect.objectContaining({ title: "Data Scientist Intern" })],
    });
  });

  it("marks a company down at once on a permanent failure", async () => {
    const { fetchImpl, requests } = routedFetch({
      [GRAB]: () => jsonResponse({}, 404),
      [GOTO]: () => jsonResponse(gotoLever),
    });
    await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["grab", "goto"],
      searchTerms: ["data scientist", "intern"],
    });
    expect(
      requests.filter((request) =>
        request.url.host.includes("smartrecruiters"),
      ),
    ).toHaveLength(1);
  });

  it("keeps a board's earlier pages when a later page fails", async () => {
    const { fetchImpl, requests } = routedFetch({
      [BLIBLI]: (request) =>
        (request.body as { paginationToken?: string }).paginationToken
          ? jsonResponse({}, 502)
          : jsonResponse(blibliSearch),
    });
    const result = await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["blibli"],
      searchTerms: ["engineer", "it support"],
    });

    // Page 1, then page 2 and its retry; nothing more for the second term.
    expect(requests).toHaveLength(3);
    expect(result.success).toBe(true);
    expect(result.jobs.map((job) => job.title)).toContain(
      "Junior IT Support Staff",
    );
    expect(result.sourceErrors).toEqual([
      "Blibli request failed with status 502; kept the 5 jobs from the first 1 page(s) (term: engineer)",
    ]);
  });

  it("emits per-company progress keyed by the search term", async () => {
    const { fetchImpl } = routedFetch({
      [GOTO]: () => jsonResponse(gotoLever),
      [GRAB]: () => jsonResponse({}, 403),
    });
    const notes: string[] = [];
    await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["grab", "goto"],
      searchTerms: ["data scientist"],
      onProgress: (event: JobBoardProgressEvent) => {
        if (event.type === "note") {
          notes.push(`${event.searchTerm} | ${event.detail}`);
        }
      },
    });

    expect(notes).toEqual([
      "data scientist | Grab: searching",
      "data scientist | Grab: failed",
      "data scientist | GoTo: searching",
      "data scientist | GoTo: 1 new job",
    ]);
  });

  it("stops between companies once cancelled", async () => {
    let cancelled = false;
    const { fetchImpl, requests } = routedFetch({
      [GOTO]: () => {
        cancelled = true;
        return jsonResponse(gotoLever);
      },
      [TIKTOK]: () => jsonResponse({ code: 0, data: { job_post_list: [] } }),
    });
    const result = await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["goto", "tiktok"],
      searchTerms: ["data scientist", "engineer"],
      shouldCancel: () => cancelled,
    });

    expect(requests).toHaveLength(1);
    expect(result.success).toBe(true);
  });

  it("returns a clear error when no company is enabled", async () => {
    const { fetchImpl, requests } = routedFetch({});
    await expect(
      runIdBigTech({ ...testOptions(fetchImpl), companies: [] }),
    ).resolves.toEqual({
      success: false,
      jobs: [],
      error:
        "Indonesia Big Tech: no companies are enabled; choose at least one in Settings",
    });
    expect(requests).toHaveLength(0);
  });
});
