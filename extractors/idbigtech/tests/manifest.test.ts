import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/run", () => ({
  runIdBigTech: vi.fn(),
}));

describe("idbigtech manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("provides one source gated to Indonesia", async () => {
    const { manifest } = await import("../src/manifest");
    expect(manifest.id).toBe("idbigtech");
    expect(manifest.displayName).toBe("Indonesia Big Tech");
    expect(manifest.providesSources).toEqual(["idbigtech"]);
    expect(manifest.locationCapabilities?.idbigtech).toEqual({
      supportedCountryKeys: ["indonesia"],
    });
  });

  it("forwards enabled companies, cap, cities and term-keyed progress", async () => {
    const { manifest } = await import("../src/manifest");
    const { runIdBigTech } = await import("../src/run");
    vi.mocked(runIdBigTech).mockImplementation(async (options) => {
      options?.onProgress?.({
        type: "note",
        termIndex: 1,
        termTotal: 1,
        searchTerm: "backend engineer",
        detail: "Grab: searching",
      });
      return { success: true, jobs: [] };
    });
    const onProgress = vi.fn();
    const getExistingJobUrls = vi.fn().mockResolvedValue([]);

    await manifest.run({
      source: "idbigtech",
      selectedSources: ["idbigtech"],
      settings: {
        jobspyResultsWanted: "30",
        searchCities: "Jakarta",
        idbigtechCompanies: JSON.stringify(["xendit", "grab", "unknown"]),
      },
      searchTerms: ["backend engineer"],
      selectedCountry: "indonesia",
      onProgress,
      getExistingJobUrls,
    });

    expect(runIdBigTech).toHaveBeenCalledWith(
      expect.objectContaining({
        searchTerms: ["backend engineer"],
        maxJobsPerTerm: 30,
        cities: ["Jakarta"],
        companies: ["grab", "xendit"],
        getExistingJobUrls,
      }),
    );
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "list",
        currentUrl: "backend engineer",
        termsProcessed: 0,
        detail:
          "Indonesia Big Tech: term 1/1 (backend engineer), Grab: searching",
      }),
    );
  });

  it("scans every company when the setting is not saved", async () => {
    const { manifest } = await import("../src/manifest");
    const { runIdBigTech } = await import("../src/run");
    vi.mocked(runIdBigTech).mockResolvedValue({ success: true, jobs: [] });

    await manifest.run({
      source: "idbigtech",
      selectedSources: ["idbigtech"],
      settings: {},
      searchTerms: ["engineer"],
      selectedCountry: "indonesia",
    });

    expect(runIdBigTech).toHaveBeenCalledWith(
      expect.objectContaining({
        companies: [
          "grab",
          "goto",
          "tiktok",
          "shopee",
          "traveloka",
          "tiket",
          "blibli",
          "xendit",
        ],
      }),
    );
  });
});
