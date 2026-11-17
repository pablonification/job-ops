import type { CreateJobInput } from "../../types/jobs";
import { TimeBudgetExceededError } from "./client";
import type { AcceptResult, TermSearchContext } from "./runner";

/**
 * Loads the job URLs already in job-ops once per run (on first use). A failed
 * lookup counts as "nothing known", so details are fetched rather than lost.
 */
export function createKnownJobUrls(
  getExistingJobUrls?: () => Promise<string[]>,
): () => Promise<Set<string>> {
  let known: Promise<Set<string>> | null = null;
  return () => {
    known ??= (getExistingJobUrls?.() ?? Promise.resolve([])).then(
      (urls) => new Set(urls),
      () => new Set<string>(),
    );
    return known;
  };
}

export interface DetailCandidate<T> {
  /** The job mapped from its list result. */
  job: CreateJobInput;
  /** The raw list result, for the detail request. */
  item: T;
}

/**
 * Gathers one term's list results that still need a detail request. Pass
 * `consume` to `collectPages`: it counts a candidate as "added" so paging
 * stops at the per-term cap, skips jobs already collected this run, and
 * applies the city filter before any detail request is made.
 */
export function createDetailCandidates<T>(context: TermSearchContext): {
  readonly candidates: DetailCandidate<T>[];
  consume: (job: CreateJobInput, item: unknown) => AcceptResult;
} {
  const candidates: DetailCandidate<T>[] = [];
  const urls = new Set<string>();
  return {
    candidates,
    consume: (job, item) => {
      if (context.isCollected(job.jobUrl) || urls.has(job.jobUrl)) {
        return "duplicate";
      }
      if (!context.matchesCities(job)) return "filtered";
      urls.add(job.jobUrl);
      candidates.push({ job, item: item as T });
      return "added";
    },
  };
}

/**
 * Requests details for candidates whose URL is not already in job-ops and
 * accepts the detailed jobs; known URLs are accepted from their list data
 * without a request. `fetchDetail` returns the detailed job, `null` to drop
 * the job (for example a closed posting), or throws when the detail could not
 * be read. A job whose detail failed is not imported, so the next run fetches
 * it again; failures are reported as one source error for the term.
 */
export async function acceptWithDetails<T>(
  context: TermSearchContext,
  candidates: readonly DetailCandidate<T>[],
  args: {
    label: string;
    knownUrls: () => Promise<Set<string>>;
    fetchDetail: (
      candidate: DetailCandidate<T>,
    ) => Promise<CreateJobInput | null>;
  },
): Promise<void> {
  if (candidates.length === 0) return;
  const knownUrls = await args.knownUrls();
  let detailsFetched = 0;
  let detailsSkipped = 0;
  let failures = 0;
  for (const candidate of candidates) {
    if (context.shouldStop()) break;
    if (knownUrls.has(candidate.job.jobUrl)) {
      detailsSkipped += 1;
      context.accept(candidate.job);
    } else {
      try {
        const detailed = await args.fetchDetail(candidate);
        if (detailed) context.accept(detailed);
      } catch (error) {
        if (error instanceof TimeBudgetExceededError) throw error;
        failures += 1;
      }
      detailsFetched += 1;
    }
    context.reportDetails({
      detailsTotal: candidates.length,
      detailsFetched,
      detailsSkipped,
    });
  }

  if (failures > 0) {
    context.reportError(
      `${args.label}: ${failures} job detail request(s) failed; those jobs were not imported and will be retried on the next run`,
    );
  }
}
