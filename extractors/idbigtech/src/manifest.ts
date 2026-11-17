import {
  INDONESIA_SUPPORTED_COUNTRY_KEYS,
  jobBoardOptionsFromContext,
  parseEnabledIdBigTechCompanies,
} from "@shared/extractors/indonesia/index.js";
import type { ExtractorManifest } from "@shared/types/extractors";
import { runIdBigTech } from "./run";
import { ID_BIG_TECH_LABEL, ID_BIG_TECH_SOURCE } from "./types";

export const manifest: ExtractorManifest = {
  id: ID_BIG_TECH_SOURCE,
  displayName: ID_BIG_TECH_LABEL,
  providesSources: [ID_BIG_TECH_SOURCE],
  capabilities: { locationEvidence: true },
  locationCapabilities: {
    [ID_BIG_TECH_SOURCE]: {
      supportedCountryKeys: [...INDONESIA_SUPPORTED_COUNTRY_KEYS],
    },
  },
  async run(context) {
    if (context.shouldCancel?.()) return { success: true, jobs: [] };
    return runIdBigTech({
      ...jobBoardOptionsFromContext(context, ID_BIG_TECH_LABEL),
      companies: parseEnabledIdBigTechCompanies(
        context.settings.idbigtechCompanies,
      ),
      getExistingJobUrls: context.getExistingJobUrls,
    });
  },
};

export default manifest;
