import {
  INDONESIA_SUPPORTED_COUNTRY_KEYS,
  resolveMaxJobsPerTerm,
  toExtractorProgress,
} from "@shared/extractors/indonesia.js";
import type { ExtractorManifest } from "@shared/types/extractors";
import { DEALLS_LABEL, runDealls } from "./run";

export const manifest: ExtractorManifest = {
  id: "dealls",
  displayName: "Dealls",
  providesSources: ["dealls"],
  capabilities: { locationEvidence: true },
  locationCapabilities: {
    dealls: { supportedCountryKeys: [...INDONESIA_SUPPORTED_COUNTRY_KEYS] },
  },
  async run(context) {
    if (context.shouldCancel?.()) return { success: true, jobs: [] };

    return runDealls({
      searchTerms: context.searchTerms,
      maxJobsPerTerm: resolveMaxJobsPerTerm(context.settings),
      getExistingJobUrls: context.getExistingJobUrls,
      shouldCancel: context.shouldCancel,
      onProgress: (event) => {
        if (!context.shouldCancel?.()) {
          context.onProgress?.(toExtractorProgress(DEALLS_LABEL, event));
        }
      },
    });
  },
};

export default manifest;
