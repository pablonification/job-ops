import type { JobBoardProgressEvent } from "@shared/extractors/indonesia/index.js";
import { describe, expect, it } from "vitest";
import { runIdBigTech } from "../src/run";
import gotoLever from "./fixtures/goto_lever.json";
import xenditBoard from "./fixtures/xendit_greenhouse.json";
import { jsonResponse, routedFetch, testOptions } from "./helpers";

const GOTO = "api.lever.co/v0/postings/GoToGroup";
const XENDIT = "boards-api.greenhouse.io/v1/boards/xendit/jobs";
const GRAB = "api.smartrecruiters.com/v1/companies/grab/postings";
const TIKTOK = "api.lifeattiktok.com/api/v1/public/supplier/search/job/posts";

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
      "Grab request failed with status 403 (term: data scientist)",
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
      sourceErrors: ["Grab returned an invalid jobs response (term: golang)"],
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
        "Grab request failed with status 503 (term: engineer); GoTo request failed (network error) (term: engineer)",
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

    expect(
      requests.filter((request) => request.url.host === "api.lever.co"),
    ).toHaveLength(1);
    expect(result.success).toBe(true);
    expect(result.sourceErrors).toEqual([
      "GoTo request failed with status 500 (term: customer success manager)",
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
