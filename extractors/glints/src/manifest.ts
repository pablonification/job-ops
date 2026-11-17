import {
  INDONESIA_SUPPORTED_COUNTRY_KEYS,
  jobBoardOptionsFromContext,
  resolveWorkplaceTypes,
} from "@shared/extractors/indonesia/index.js";
import type { ExtractorManifest } from "@shared/types/extractors";
import { GLINTS_LABEL, runGlints } from "./run";

export const manifest: ExtractorManifest = {
  id: "glints",
  displayName: "Glints",
  providesSources: ["glints"],
  capabilities: { locationEvidence: true },
  locationCapabilities: {
    glints: { supportedCountryKeys: [...INDONESIA_SUPPORTED_COUNTRY_KEYS] },
  },
  async run(context) {
    if (context.shouldCancel?.()) return { success: true, jobs: [] };
    return runGlints({
      ...jobBoardOptionsFromContext(context, GLINTS_LABEL),
      workplaceTypes: resolveWorkplaceTypes(context),
      getExistingJobUrls: context.getExistingJobUrls,
    });
  },
};

export default manifest;
