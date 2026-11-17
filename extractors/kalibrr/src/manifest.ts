import {
  INDONESIA_SUPPORTED_COUNTRY_KEYS,
  resolveMaxJobsPerTerm,
  toExtractorProgress,
} from "@shared/extractors/indonesia.js";
import type { ExtractorManifest } from "@shared/types/extractors";
import { KALIBRR_LABEL, runKalibrr } from "./run";

export const manifest: ExtractorManifest = {
  id: "kalibrr",
  displayName: "Kalibrr",
  providesSources: ["kalibrr"],
  capabilities: { locationEvidence: true },
  locationCapabilities: {
    kalibrr: { supportedCountryKeys: [...INDONESIA_SUPPORTED_COUNTRY_KEYS] },
  },
  async run(context) {
    if (context.shouldCancel?.()) return { success: true, jobs: [] };

    return runKalibrr({
      searchTerms: context.searchTerms,
      maxJobsPerTerm: resolveMaxJobsPerTerm(context.settings),
      shouldCancel: context.shouldCancel,
      onProgress: (event) => {
        if (!context.shouldCancel?.()) {
          context.onProgress?.(toExtractorProgress(KALIBRR_LABEL, event));
        }
      },
    });
  },
};

export default manifest;
