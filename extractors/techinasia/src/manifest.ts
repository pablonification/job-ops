import {
  INDONESIA_SUPPORTED_COUNTRY_KEYS,
  resolveMaxJobsPerTerm,
  toExtractorProgress,
} from "@shared/extractors/indonesia.js";
import type { ExtractorManifest } from "@shared/types/extractors";
import { runTechInAsia, TECHINASIA_LABEL } from "./run";

export const manifest: ExtractorManifest = {
  id: "techinasia",
  displayName: "Tech in Asia Jobs",
  providesSources: ["techinasia"],
  capabilities: { locationEvidence: true },
  locationCapabilities: {
    techinasia: { supportedCountryKeys: [...INDONESIA_SUPPORTED_COUNTRY_KEYS] },
  },
  async run(context) {
    if (context.shouldCancel?.()) return { success: true, jobs: [] };

    return runTechInAsia({
      searchTerms: context.searchTerms,
      maxJobsPerTerm: resolveMaxJobsPerTerm(context.settings),
      shouldCancel: context.shouldCancel,
      onProgress: (event) => {
        if (!context.shouldCancel?.()) {
          context.onProgress?.(toExtractorProgress(TECHINASIA_LABEL, event));
        }
      },
    });
  },
};

export default manifest;
