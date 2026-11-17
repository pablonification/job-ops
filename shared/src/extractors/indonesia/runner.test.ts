import { describe, expect, it, vi } from "vitest";
import type { CreateJobInput } from "../../types/jobs";
import { buildIndonesianLocation } from "./places";
import {
  collectPages,
  jobBoardOptionsFromContext,
  resolveMaxJobsPerTerm,
  resolveRequestedCities,
  runJobBoard,
  toExtractorProgress,
} from "./runner";

function job(id: string, city = "Jakarta Selatan"): CreateJobInput {
  return {
    source: "dealls",
    title: "Engineer",
    employer: "Acme",
    jobUrl: `https://example.com/${id}`,
    ...buildIndonesianLocation({ city, source: "dealls" }),
  };
}

function jsonResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as Response;
}

const noSleep = vi.fn().mockResolvedValue(undefined);

describe("job-board runner", () => {
  it("reads the per-term cap from the shared results-wanted setting", () => {
    expect(resolveMaxJobsPerTerm({ jobspyResultsWanted: "25" })).toBe(25);
    expect(resolveMaxJobsPerTerm({})).toBe(50);
    expect(resolveMaxJobsPerTerm({ jobspyResultsWanted: "nope" })).toBe(50);
    expect(resolveMaxJobsPerTerm({ jobspyResultsWanted: "5000" })).toBe(200);
  });

  it("resolves requested cities like FreeHire and skips flexible matching", () => {
    const base = {
      settings: { searchCities: "Bandung" },
      sourceLocationPlan: undefined,
      locationIntent: undefined,
    };
    expect(resolveRequestedCities(base)).toEqual(["Bandung"]);
    expect(
      resolveRequestedCities({
        ...base,
        sourceLocationPlan: {
          requestedCities: ["Jakarta Selatan", "Indonesia"],
        } as never,
      }),
    ).toEqual(["Jakarta Selatan"]);
    expect(
      resolveRequestedCities({
        ...base,
        locationIntent: { matchStrictness: "flexible" } as never,
      }),
    ).toEqual([]);
  });

  it("builds manifest options with cities, cap and term-keyed progress", () => {
    const onProgress = vi.fn();
    const options = jobBoardOptionsFromContext(
      {
        source: "dealls",
        selectedSources: ["dealls"],
        settings: { jobspyResultsWanted: "30", searchCities: "Jakarta" },
        searchTerms: ["backend"],
        selectedCountry: "indonesia",
        onProgress,
      },
      "Dealls",
    );
    expect(options).toMatchObject({
      searchTerms: ["backend"],
      cities: ["Jakarta"],
      maxJobsPerTerm: 30,
    });
    options.onProgress?.({
      type: "term_start",
      termIndex: 1,
      termTotal: 1,
      searchTerm: "backend",
    });
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ currentUrl: "backend", termsProcessed: 0 }),
    );
  });

  it("keeps successful terms when another term fails", async () => {
    const events: string[] = [];
    const result = await runJobBoard({
      label: "Board",
      maxPageSize: 20,
      options: {
        searchTerms: ["a", "b", "c"],
        onProgress: (event) => events.push(`${event.type}:${event.searchTerm}`),
      },
      runTerm: async ({ searchTerm, accept }) => {
        if (searchTerm === "b") throw new Error("Board request failed");
        accept(job("1"));
        accept(job(searchTerm));
      },
    });

    expect(result.success).toBe(true);
    expect(result.jobs.map((item) => item.jobUrl)).toEqual([
      "https://example.com/1",
      "https://example.com/a",
      "https://example.com/c",
    ]);
    expect(result.sourceErrors).toEqual(["Board request failed (term: b)"]);
    expect(events).toEqual([
      "term_start:a",
      "term_complete:a",
      "term_start:b",
      "term_complete:b",
      "term_start:c",
      "term_complete:c",
    ]);
  });

  it("fails the source only when no term produced jobs", async () => {
    await expect(
      runJobBoard({
        label: "Board",
        maxPageSize: 20,
        options: { searchTerms: ["a"] },
        runTerm: async () => {
          throw new Error("Board request failed with status 503");
        },
      }),
    ).resolves.toEqual({
      success: false,
      jobs: [],
      error: "Board request failed with status 503 (term: a)",
    });
  });

  it("lets a caller decide when recorded errors fail the run", async () => {
    const events: unknown[] = [];
    const result = await runJobBoard({
      label: "Board",
      maxPageSize: 20,
      options: {
        searchTerms: ["a"],
        onProgress: (event) => events.push(event),
      },
      shouldFail: ({ errors }) => errors.length > 1,
      runTerm: async ({ reportError, reportProgress }) => {
        reportError("Grab: request failed with status 403");
        reportProgress("GoTo: 0 jobs");
      },
    });

    expect(result).toEqual({
      success: true,
      jobs: [],
      sourceErrors: ["Grab: request failed with status 403 (term: a)"],
    });
    expect(events).toContainEqual({
      type: "note",
      termIndex: 1,
      termTotal: 1,
      searchTerm: "a",
      detail: "GoTo: 0 jobs",
    });
    expect(
      toExtractorProgress("Board", {
        type: "note",
        termIndex: 1,
        termTotal: 2,
        searchTerm: "a",
        detail: "GoTo: 0 jobs",
      }),
    ).toEqual({
      phase: "list",
      termsProcessed: 0,
      termsTotal: 2,
      currentUrl: "a",
      detail: "Board: term 1/2 (a), GoTo: 0 jobs",
    });
  });

  it("filters requested cities before a job is accepted", async () => {
    const result = await runJobBoard({
      label: "Board",
      maxPageSize: 20,
      options: { searchTerms: ["a"], cities: ["Jakarta Selatan"] },
      runTerm: async ({ accept }) => {
        expect(accept(job("1", "South Jakarta"))).toBe("added");
        expect(accept(job("2", "Bandung"))).toBe("filtered");
        expect(accept(job("1", "South Jakarta"))).toBe("duplicate");
      },
    });
    expect(result.jobs.map((item) => item.jobUrl)).toEqual([
      "https://example.com/1",
    ]);
  });

  it("stops before the next term when cancelled", async () => {
    let cancelled = false;
    const runTerm = vi.fn(async () => {
      cancelled = true;
    });
    const result = await runJobBoard({
      label: "Board",
      maxPageSize: 20,
      options: { searchTerms: ["a", "b"], shouldCancel: () => cancelled },
      runTerm,
    });
    expect(result).toEqual({ success: true, jobs: [] });
    expect(runTerm).toHaveBeenCalledTimes(1);
  });

  it("returns collected jobs with an error once the time budget is spent", async () => {
    let clock = 0;
    const fetchImpl = vi.fn(async () => {
      clock += 60_000;
      return jsonResponse({ items: [] });
    });
    const result = await runJobBoard({
      label: "Board",
      maxPageSize: 20,
      options: {
        searchTerms: ["a"],
        timeBudgetMs: 120_000,
        now: () => clock,
        fetchImpl,
        sleep: noSleep,
        delayMs: 0,
      },
      runTerm: async ({ client, accept, searchTerm }) => {
        // A single term has the whole budget.
        await client.getJson("https://example.com/page");
        accept(job(searchTerm));
        await client.getJson("https://example.com/page");
        await client.getJson("https://example.com/page");
      },
    });

    expect(result).toEqual({
      success: true,
      jobs: [expect.objectContaining({ jobUrl: "https://example.com/a" })],
      sourceErrors: [
        "Board: stopped after 2 minutes to stay within the source time limit; kept the 1 jobs collected so far",
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives each term at most its fair share of the remaining time", async () => {
    let clock = 0;
    const fetchImpl = vi.fn(async () => {
      clock += 60_000;
      return jsonResponse({ items: [] });
    });
    const started: Array<[string, number]> = [];
    const result = await runJobBoard({
      label: "Board",
      maxPageSize: 20,
      options: {
        searchTerms: ["a", "b", "c"],
        timeBudgetMs: 180_000,
        now: () => clock,
        fetchImpl,
        sleep: noSleep,
        delayMs: 0,
      },
      runTerm: async ({ client, accept, searchTerm }) => {
        started.push([searchTerm, clock]);
        // Each term would keep requesting forever; its share stops it.
        for (;;) {
          await client.getJson("https://example.com/page");
          accept(job(`${searchTerm}-${clock}`));
        }
      },
    });

    // 180s over three terms: one 60s request each, so every term gets a turn.
    expect(started).toEqual([
      ["a", 0],
      ["b", 60_000],
      ["c", 120_000],
    ]);
    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(3);
    expect(result.sourceErrors).toEqual([
      "Board: used this term's share of the time limit (about 60 seconds) and moved on so later search terms get their turn; kept 1 jobs for it (term: a)",
      "Board: used this term's share of the time limit (about 60 seconds) and moved on so later search terms get their turn; kept 1 jobs for it (term: b)",
      "Board: stopped after 3 minutes to stay within the source time limit; kept the 3 jobs collected so far",
    ]);
  });

  it("hands time a quick term leaves unused to the later terms", async () => {
    let clock = 0;
    const fetchImpl = vi.fn(async () => {
      clock += 10_000;
      return jsonResponse({ items: [] });
    });
    const requestsByTerm: Record<string, number> = {};
    const result = await runJobBoard({
      label: "Board",
      maxPageSize: 20,
      options: {
        searchTerms: ["quick", "slow-1", "slow-2"],
        timeBudgetMs: 120_000,
        now: () => clock,
        fetchImpl,
        sleep: noSleep,
        delayMs: 0,
      },
      runTerm: async ({ client, searchTerm, shouldStop }) => {
        const wanted = searchTerm === "quick" ? 1 : 100;
        for (let request = 0; request < wanted && !shouldStop(); request += 1) {
          await client.getJson("https://example.com/page");
          requestsByTerm[searchTerm] = (requestsByTerm[searchTerm] ?? 0) + 1;
        }
      },
    });

    // "quick" uses 10s of its 40s share; the 110s left are split between the
    // two slow terms: 55s each (a request started before the share ends may
    // finish after it, so slow-1 runs from 10s to 70s and slow-2 to 120s).
    expect(requestsByTerm).toEqual({ quick: 1, "slow-1": 6, "slow-2": 5 });
    expect(result).toEqual({
      success: false,
      jobs: [],
      error:
        "Board: used this term's share of the time limit (about 55 seconds) and moved on so later search terms get their turn; kept 0 jobs for it (term: slow-1); Board: stopped after 2 minutes to stay within the source time limit; kept the 0 jobs collected so far",
    });
  });

  it("reports notes as source messages that never fail the run", async () => {
    const quiet = await runJobBoard({
      label: "Board",
      maxPageSize: 20,
      options: { searchTerms: ["a"] },
      runTerm: async ({ reportNote }) => {
        reportNote("Board: results were limited to the first page");
      },
    });
    expect(quiet).toEqual({
      success: true,
      jobs: [],
      sourceErrors: ["Board: results were limited to the first page (term: a)"],
    });

    const failed = await runJobBoard({
      label: "Board",
      maxPageSize: 20,
      options: { searchTerms: ["a"] },
      runTerm: async ({ reportNote, reportError }) => {
        reportNote("Board: note");
        reportError("Board: broken");
      },
    });
    expect(failed).toEqual({
      success: false,
      jobs: [],
      error: "Board: note (term: a); Board: broken (term: a)",
    });
  });

  it("stops paging a term when a page holds only jobs taken by earlier terms", async () => {
    const pages: number[] = [];
    const result = await runJobBoard({
      label: "Board",
      maxPageSize: 2,
      options: { searchTerms: ["a", "b"], maxJobsPerTerm: 10 },
      runTerm: async (context) => {
        await collectPages(context, {
          toJob: (item) => job(String(item)),
          fetchPage: async ({ number }) => {
            pages.push(number);
            return { items: [`${number}-1`, `${number}-2`], hasMore: true };
          },
        });
      },
    });

    // Term "a" pages to its scan limit (10 jobs = 5 pages); term "b" sees the
    // same first page, finds nothing new and stops.
    expect(result.jobs).toHaveLength(10);
    expect(pages).toEqual([1, 2, 3, 4, 5, 1]);
  });

  it("bounds scanning when client-side filters drop most results", async () => {
    let requests = 0;
    const result = await runJobBoard({
      label: "Board",
      maxPageSize: 2,
      options: { searchTerms: ["a"], maxJobsPerTerm: 2, cities: ["Bandung"] },
      runTerm: async (context) => {
        await collectPages(context, {
          toJob: (item) => job(String(item), "Jakarta"),
          fetchPage: async ({ number }) => {
            requests += 1;
            return { items: [`${number}-1`, `${number}-2`], hasMore: true };
          },
        });
      },
    });
    expect(result).toEqual({ success: true, jobs: [] });
    // Three times the cap of 2 = 6 results = 3 pages.
    expect(requests).toBe(3);
  });

  it("maps per-term events to pipeline progress keyed by the term", () => {
    expect(
      toExtractorProgress("Board", {
        type: "term_start",
        termIndex: 2,
        termTotal: 3,
        searchTerm: "backend",
      }),
    ).toMatchObject({
      phase: "list",
      termsProcessed: 1,
      termsTotal: 3,
      currentUrl: "backend",
    });
    expect(
      toExtractorProgress("Board", {
        type: "details",
        termIndex: 1,
        termTotal: 1,
        searchTerm: "backend",
        detailsTotal: 5,
        detailsFetched: 2,
        detailsSkipped: 1,
      }),
    ).toMatchObject({
      phase: "job",
      jobPagesEnqueued: 5,
      jobPagesProcessed: 2,
      jobPagesSkipped: 1,
      detail: "Board: term 1/1 (backend) details 3/5 (1 already known)",
    });
  });
});
