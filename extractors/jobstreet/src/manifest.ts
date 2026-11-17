import {
  INDONESIA_SUPPORTED_COUNTRY_KEYS,
  jobBoardOptionsFromContext,
  resolveWorkplaceTypes,
} from "@shared/extractors/indonesia/index.js";
import type { ExtractorManifest } from "@shared/types/extractors";
import { JOBSTREET_LABEL, runJobStreet } from "./run";

export const manifest: ExtractorManifest = {
  id: "jobstreet",
  displayName: "JobStreet",
  providesSources: ["jobstreet"],
  capabilities: { locationEvidence: true },
  locationCapabilities: {
    jobstreet: { supportedCountryKeys: [...INDONESIA_SUPPORTED_COUNTRY_KEYS] },
  },
  async run(context) {
    if (context.shouldCancel?.()) return { success: true, jobs: [] };
    return runJobStreet({
      ...jobBoardOptionsFromContext(context, JOBSTREET_LABEL),
      workplaceTypes: resolveWorkplaceTypes(context),
      getExistingJobUrls: context.getExistingJobUrls,
    });
  },
};

export default manifest;
