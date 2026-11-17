/**
 * Server side of the Target companies setting. The flag is computed from the
 * current setting on every read and never stored, so editing the list takes
 * effect immediately without a backfill.
 */
import * as settingsRepo from "@server/repositories/settings";
import { settingsRegistry } from "@shared/settings-registry";
import {
  createTargetCompanyMatcher,
  type TargetCompanyMatcher,
} from "@shared/target-companies";

export type { TargetCompanyMatcher } from "@shared/target-companies";

/**
 * Load the current tenant's target-company matcher. Settings reads are
 * tenant-scoped by the repository. Load it once per request and reuse it for
 * every job in that request.
 */
export async function loadTargetCompanyMatcher(): Promise<TargetCompanyMatcher> {
  const raw = await settingsRepo.getSetting("targetCompanies");
  const lines =
    settingsRegistry.targetCompanies.parse(raw ?? undefined) ??
    settingsRegistry.targetCompanies.default();
  return createTargetCompanyMatcher(lines);
}

/** Return a copy of the job with its computed `isTargetCompany` flag. */
export function withTargetCompanyFlag<T extends { employer: string }>(
  job: T,
  matcher: TargetCompanyMatcher,
): T & { isTargetCompany: boolean } {
  return { ...job, isTargetCompany: matcher.matches(job.employer) };
}

/**
 * Whether a job is at one of the current tenant's target companies. Pass a
 * matcher from `loadTargetCompanyMatcher()` when checking many jobs, so the
 * setting is read once.
 */
export async function isJobAtTargetCompany(
  job: { employer: string | null | undefined },
  matcher?: TargetCompanyMatcher,
): Promise<boolean> {
  const resolved = matcher ?? (await loadTargetCompanyMatcher());
  return resolved.matches(job.employer);
}
