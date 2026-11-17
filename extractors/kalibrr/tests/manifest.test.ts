import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/run", () => ({
  KALIBRR_LABEL: "Kalibrr",
  runKalibrr: vi.fn(),
}));

describe("kalibrr manifest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is gated to Indonesia", async () => {
    const { manifest } = await import("../src/manifest");
    expect(manifest.providesSources).toEqual(["kalibrr"]);
    expect(manifest.locationCapabilities?.kalibrr).toEqual({
      supportedCountryKeys: ["indonesia"],
    });
  });

  it("forwards the results-wanted cap, requested cities and per-term progress", async () => {
    const { manifest } = await import("../src/manifest");
    const { runKalibrr } = await import("../src/run");
    vi.mocked(runKalibrr).mockImplementation(async (options) => {
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
      source: "kalibrr",
      selectedSources: ["kalibrr"],
      settings: { jobspyResultsWanted: "30", searchCities: "Jakarta Selatan" },
      searchTerms: ["backend engineer"],
      selectedCountry: "indonesia",
      onProgress,
    });

    expect(runKalibrr).toHaveBeenCalledWith(
      expect.objectContaining({
        searchTerms: ["backend engineer"],
        maxJobsPerTerm: 30,
        cities: ["Jakarta Selatan"],
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
