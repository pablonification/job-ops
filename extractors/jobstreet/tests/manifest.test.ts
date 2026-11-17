import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/run", () => ({
  JOBSTREET_LABEL: "JobStreet",
  runJobStreet: vi.fn(),
}));

describe("jobstreet manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is gated to Indonesia", async () => {
    const { manifest } = await import("../src/manifest");
    expect(manifest.providesSources).toEqual(["jobstreet"]);
    expect(manifest.locationCapabilities?.jobstreet).toEqual({
      supportedCountryKeys: ["indonesia"],
    });
  });

  it("forwards the results-wanted cap, cities, workplace types and per-term progress", async () => {
    const { manifest } = await import("../src/manifest");
    const { runJobStreet } = await import("../src/run");
    vi.mocked(runJobStreet).mockImplementation(async (options) => {
      options?.onProgress?.({
        type: "term_start",
        termIndex: 1,
        termTotal: 1,
        searchTerm: "backend engineer",
      });
      return { success: true, jobs: [] };
    });
    const onProgress = vi.fn();
    const getExistingJobUrls = vi.fn().mockResolvedValue([]);

    await manifest.run({
      source: "jobstreet",
      selectedSources: ["jobstreet"],
      settings: {
        jobspyResultsWanted: "30",
        searchCities: "Jakarta Selatan",
        workplaceTypes: JSON.stringify(["remote", "hybrid"]),
      },
      searchTerms: ["backend engineer"],
      selectedCountry: "indonesia",
      onProgress,
      getExistingJobUrls,
    });

    expect(runJobStreet).toHaveBeenCalledWith(
      expect.objectContaining({
        searchTerms: ["backend engineer"],
        maxJobsPerTerm: 30,
        cities: ["Jakarta Selatan"],
        workplaceTypes: ["remote", "hybrid"],
        getExistingJobUrls,
      }),
    );
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "list",
        currentUrl: "backend engineer",
        termsProcessed: 0,
        termsTotal: 1,
      }),
    );
  });
});
