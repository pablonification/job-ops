import {
  INDONESIA_SUPPORTED_COUNTRY_KEYS,
  jobBoardOptionsFromContext,
} from "@shared/extractors/indonesia/index.js";
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
    return runKalibrr(jobBoardOptionsFromContext(context, KALIBRR_LABEL));
  },
};

export default manifest;
