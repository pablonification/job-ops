import { describe, expect, it, vi } from "vitest";
import { matchJobLocationIntent } from "../job-matching";
import { normalizeLocationIntent } from "../location-domain";
import {
  getSourceSupportedCountryKeys,
  isSourceAllowedForCountry,
} from "../location-support";
import {
  BROWSER_USER_AGENT,
  buildIndonesianLocation,
  buildSalaryFields,
  createPoliteJsonClient,
  normalizeSalaryInterval,
  resolveMaxJobsPerTerm,
  runTermSearches,
  toExtractorProgress,
} from "./indonesia";

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

describe("Indonesian extractor helpers", () => {
  it("gates the Indonesian boards to Indonesia in the static country map", () => {
    for (const source of ["techinasia", "kalibrr", "dealls"]) {
      expect(getSourceSupportedCountryKeys(source)).toEqual(["indonesia"]);
      expect(isSourceAllowedForCountry(source, "indonesia")).toBe(true);
      expect(isSourceAllowedForCountry(source, "united kingdom")).toBe(false);
    }
  });

  it("keeps city-only Indonesian locations through the shared location filter", () => {
    const { location, locationEvidence } = buildIndonesianLocation({
      city: "Jakarta Selatan",
      workplaceType: "onsite",
      source: "dealls",
    });

    expect(location).toBe("Jakarta Selatan, Indonesia");
    expect(locationEvidence).toMatchObject({
      country: "Indonesia",
      countryKey: "indonesia",
      city: "Jakarta Selatan",
      workplaceType: "onsite",
      isRemote: false,
      evidenceQuality: "exact",
      source: "dealls",
    });

    const job = { location, locationEvidence, isRemote: false };
    const intent = (cityLocations: string[]) =>
      normalizeLocationIntent({ selectedCountry: "indonesia", cityLocations });
    expect(matchJobLocationIntent(job, intent([])).matched).toBe(true);
    expect(matchJobLocationIntent(job, intent(["Jakarta"])).matched).toBe(true);
    expect(
      matchJobLocationIntent(job, intent(["Jakarta Selatan"])).matched,
    ).toBe(true);
    expect(matchJobLocationIntent(job, intent(["Surabaya"])).matched).toBe(
      false,
    );
    expect(
      matchJobLocationIntent(
        job,
        normalizeLocationIntent({ selectedCountry: "singapore" }),
      ).matched,
    ).toBe(false);
  });

  it("does not repeat location parts and defaults the country", () => {
    expect(
      buildIndonesianLocation({
        city: "Jakarta",
        region: "Jakarta",
        workplaceType: "remote",
        source: "techinasia",
      }),
    ).toMatchObject({
      location: "Jakarta, Indonesia",
      locationEvidence: { isRemote: true, regionHints: ["Jakarta"] },
    });
    expect(buildIndonesianLocation({ source: "kalibrr" })).toMatchObject({
      location: "Indonesia",
      locationEvidence: { city: null, evidenceQuality: "approximate" },
    });
  });

  it("builds rupiah salary fields and ignores unpublished amounts", () => {
    expect(
      buildSalaryFields({
        min: 7_000_000,
        max: 10_000_000,
        currency: "idr",
        interval: "MONTHLY",
      }),
    ).toEqual({
      salary: "IDR 7,000,000–10,000,000 / month",
      salaryMinAmount: 7_000_000,
      salaryMaxAmount: 10_000_000,
      salaryCurrency: "IDR",
      salaryInterval: "monthly",
    });
    expect(buildSalaryFields({ min: 0, max: 0, currency: "IDR" })).toEqual({});
    expect(buildSalaryFields({ min: null, max: undefined })).toEqual({});
    expect(buildSalaryFields({ max: 5_000_000, currency: "IDR" }).salary).toBe(
      "IDR up to 5,000,000",
    );
    expect(normalizeSalaryInterval("Per Month")).toBe("monthly");
    expect(normalizeSalaryInterval("tahun")).toBe("yearly");
    expect(normalizeSalaryInterval("fortnight")).toBeUndefined();
  });

  it("reads the per-term cap from the shared results-wanted setting", () => {
    expect(resolveMaxJobsPerTerm({ jobspyResultsWanted: "25" })).toBe(25);
    expect(resolveMaxJobsPerTerm({})).toBe(50);
    expect(resolveMaxJobsPerTerm({ jobspyResultsWanted: "nope" })).toBe(50);
    expect(resolveMaxJobsPerTerm({ jobspyResultsWanted: "5000" })).toBe(200);
  });

  it("sends a browser user agent and pauses between requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: 1 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = createPoliteJsonClient({
      label: "Board",
      fetchImpl: fetchMock,
      delayMs: 1_000,
      sleep,
    });

    await client.getJson("https://example.com/a");
    await client.getJson("https://example.com/b");

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(client.requestCount).toBe(2);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe(
      BROWSER_USER_AGENT,
    );
  });

  it("reports sanitised errors without upstream bodies", async () => {
    const failing = createPoliteJsonClient({
      label: "Board",
      delayMs: 0,
      fetchImpl: vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({ secret: "upstream body" }),
      } as Response),
    });
    await expect(failing.getJson("https://example.com")).rejects.toThrow(
      /^Board request failed with status 429$/,
    );

    const offline = createPoliteJsonClient({
      label: "Board",
      delayMs: 0,
      fetchImpl: vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    });
    await expect(offline.getJson("https://example.com")).rejects.toThrow(
      "Board request failed (network error)",
    );
  });

  it("keeps successful terms when another term fails", async () => {
    const job = (url: string) => ({
      source: "kalibrr",
      title: "Engineer",
      employer: "Acme",
      jobUrl: url,
    });
    const events: string[] = [];

    const result = await runTermSearches({
      searchTerms: ["a", "b", "c"],
      onProgress: (event) => events.push(`${event.type}:${event.searchTerm}`),
      searchTerm: async ({ searchTerm, accept }) => {
        if (searchTerm === "b") throw new Error("Board request failed");
        accept(job("https://example.com/1"));
        accept(job(`https://example.com/${searchTerm}`));
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
      runTermSearches({
        searchTerms: ["a"],
        searchTerm: async () => {
          throw new Error("Board request failed with status 503");
        },
      }),
    ).resolves.toEqual({
      success: false,
      jobs: [],
      error: "Board request failed with status 503 (term: a)",
    });
  });

  it("stops before the next term when cancelled", async () => {
    let cancelled = false;
    const searchTerm = vi.fn(async () => {
      cancelled = true;
    });
    const result = await runTermSearches({
      searchTerms: ["a", "b"],
      shouldCancel: () => cancelled,
      searchTerm,
    });
    expect(result).toEqual({ success: true, jobs: [] });
    expect(searchTerm).toHaveBeenCalledTimes(1);
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
