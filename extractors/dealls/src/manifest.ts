import {
  INDONESIA_SUPPORTED_COUNTRY_KEYS,
  jobBoardOptionsFromContext,
} from "@shared/extractors/indonesia/index.js";
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
      ...jobBoardOptionsFromContext(context, DEALLS_LABEL),
      getExistingJobUrls: context.getExistingJobUrls,
    });
  },
};

export default manifest;
