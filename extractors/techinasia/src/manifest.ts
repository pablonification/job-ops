import {
  INDONESIA_SUPPORTED_COUNTRY_KEYS,
  jobBoardOptionsFromContext,
} from "@shared/extractors/indonesia/index.js";
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
    return runTechInAsia(jobBoardOptionsFromContext(context, TECHINASIA_LABEL));
  },
};

export default manifest;
