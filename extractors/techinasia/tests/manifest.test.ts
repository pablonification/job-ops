import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/run", () => ({
  TECHINASIA_LABEL: "Tech in Asia",
  runTechInAsia: vi.fn(),
}));

describe("techinasia manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is gated to Indonesia", async () => {
    const { manifest } = await import("../src/manifest");
    expect(manifest.providesSources).toEqual(["techinasia"]);
    expect(manifest.locationCapabilities?.techinasia).toEqual({
      supportedCountryKeys: ["indonesia"],
    });
  });

  it("forwards the results-wanted cap and per-term progress", async () => {
    const { manifest } = await import("../src/manifest");
    const { runTechInAsia } = await import("../src/run");
    vi.mocked(runTechInAsia).mockImplementation(async (options) => {
      options?.onProgress?.({
        type: "term_start",
        termIndex: 1,
        termTotal: 1,
        searchTerm: "backend engineer",
      });
      return { success: true, jobs: [] };
    });
    const onProgress = vi.fn();

    await manifest.run({
      source: "techinasia",
      selectedSources: ["techinasia"],
      settings: { jobspyResultsWanted: "30" },
      searchTerms: ["backend engineer"],
      selectedCountry: "indonesia",
      onProgress,
    });

    expect(runTechInAsia).toHaveBeenCalledWith(
      expect.objectContaining({
        searchTerms: ["backend engineer"],
        maxJobsPerTerm: 30,
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
