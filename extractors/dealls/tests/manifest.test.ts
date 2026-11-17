import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/run", () => ({
  DEALLS_LABEL: "Dealls",
  runDealls: vi.fn(),
}));

describe("dealls manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is gated to Indonesia", async () => {
    const { manifest } = await import("../src/manifest");
    expect(manifest.providesSources).toEqual(["dealls"]);
    expect(manifest.locationCapabilities?.dealls).toEqual({
      supportedCountryKeys: ["indonesia"],
    });
  });

  it("forwards the results-wanted cap and per-term progress", async () => {
    const { manifest } = await import("../src/manifest");
    const { runDealls } = await import("../src/run");
    vi.mocked(runDealls).mockImplementation(async (options) => {
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
      source: "dealls",
      selectedSources: ["dealls"],
      settings: { jobspyResultsWanted: "30" },
      searchTerms: ["backend engineer"],
      selectedCountry: "indonesia",
      onProgress,
      getExistingJobUrls,
    });

    expect(runDealls).toHaveBeenCalledWith(
      expect.objectContaining({
        searchTerms: ["backend engineer"],
        maxJobsPerTerm: 30,
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
