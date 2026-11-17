import type { LocationWorkplaceType } from "../../location-domain";
import {
  resolveSearchCities,
  shouldApplyStrictCityFilter,
} from "../../search-cities";
import type {
  ExtractorProgressEvent,
  ExtractorRunResult,
  ExtractorRuntimeContext,
} from "../../types/extractors";
import type { CreateJobInput } from "../../types/jobs";
import {
  createPoliteJsonClient,
  type PoliteJsonClient,
  TimeBudgetExceededError,
} from "./client";
import { INDONESIA_COUNTRY_KEY, jobMatchesIndonesianCities } from "./places";

const DEFAULT_MAX_JOBS_PER_TERM = 50;
const MAX_JOBS_PER_TERM_LIMIT = 200;
/** Client-side filters drop results, so scan at most this many results per wanted job. */
const SCAN_FACTOR = 3;
/** Comfortably under the pipeline's 10-minute per-source timeout. */
export const DEFAULT_TIME_BUDGET_MS = 8 * 60 * 1000;

export type JobBoardProgressEvent =
  | {
      type: "term_start";
      termIndex: number;
      termTotal: number;
      searchTerm: string;
    }
  | {
      type: "term_complete";
      termIndex: number;
      termTotal: number;
      searchTerm: string;
      jobsFoundTerm: number;
    }
  | {
      type: "details";
      termIndex: number;
      termTotal: number;
      searchTerm: string;
      detailsTotal: number;
      detailsFetched: number;
      detailsSkipped: number;
    }
  | {
      /** Free-form progress within a term, e.g. one employer of a multi-employer source. */
      type: "note";
      termIndex: number;
      termTotal: number;
      searchTerm: string;
      detail: string;
    };

/** Converts a per-term event into the pipeline's progress shape (`currentUrl` is the term). */
export function toExtractorProgress(
  label: string,
  event: JobBoardProgressEvent,
): ExtractorProgressEvent {
  const position = `${event.termIndex}/${event.termTotal} (${event.searchTerm})`;
  if (event.type === "term_complete") {
    return {
      phase: "list",
      termsProcessed: event.termIndex,
      termsTotal: event.termTotal,
      currentUrl: event.searchTerm,
      jobPagesEnqueued: event.jobsFoundTerm,
      jobPagesProcessed: event.jobsFoundTerm,
      detail: `${label}: completed ${position} with ${event.jobsFoundTerm} jobs`,
    };
  }
  if (event.type === "note") {
    return {
      phase: "list",
      termsProcessed: event.termIndex - 1,
      termsTotal: event.termTotal,
      currentUrl: event.searchTerm,
      detail: `${label}: term ${position}, ${event.detail}`,
    };
  }
  if (event.type === "details") {
    return {
      phase: "job",
      termsProcessed: event.termIndex - 1,
      termsTotal: event.termTotal,
      currentUrl: event.searchTerm,
      jobPagesEnqueued: event.detailsTotal,
      jobPagesProcessed: event.detailsFetched,
      jobPagesSkipped: event.detailsSkipped,
      detail: `${label}: term ${position} details ${event.detailsFetched + event.detailsSkipped}/${event.detailsTotal}${
        event.detailsSkipped > 0
          ? ` (${event.detailsSkipped} already known)`
          : ""
      }`,
    };
  }
  return {
    phase: "list",
    termsProcessed: event.termIndex - 1,
    termsTotal: event.termTotal,
    currentUrl: event.searchTerm,
    detail: `${label}: term ${position}`,
  };
}

/** Per-term cap from the shared results-wanted setting (`jobspyResultsWanted`). */
export function resolveMaxJobsPerTerm(
  settings: Record<string, string | undefined>,
  fallback = DEFAULT_MAX_JOBS_PER_TERM,
): number {
  const parsed = Number.parseInt(settings.jobspyResultsWanted ?? "", 10);
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.min(MAX_JOBS_PER_TERM_LIMIT, value);
}

/**
 * Cities the run asks for, resolved like FreeHire's manifest. Flexible city
 * matching (the shared filter keeps any city in the country) and a "city"
 * that is just the country mean no city filter.
 */
export function resolveRequestedCities(
  context: Pick<
    ExtractorRuntimeContext,
    "settings" | "sourceLocationPlan" | "locationIntent"
  >,
): string[] {
  if (context.locationIntent?.matchStrictness === "flexible") return [];
  return resolveSearchCities({
    list: context.sourceLocationPlan?.requestedCities,
    single: context.settings.searchCities ?? context.settings.jobspyLocation,
  }).filter((city) => shouldApplyStrictCityFilter(city, INDONESIA_COUNTRY_KEY));
}

const WORKPLACE_TYPES: readonly LocationWorkplaceType[] = [
  "remote",
  "hybrid",
  "onsite",
];

/**
 * Workplace types the run asks for, from the location intent or the saved
 * `workplaceTypes` setting. Empty, or all three, means "any": a board should
 * only send its own work-arrangement filter for a narrower choice.
 */
export function resolveWorkplaceTypes(
  context: Pick<ExtractorRuntimeContext, "settings" | "locationIntent">,
): LocationWorkplaceType[] {
  let values: unknown = context.locationIntent?.workplaceTypes;
  if (!Array.isArray(values) && context.settings.workplaceTypes) {
    try {
      values = JSON.parse(context.settings.workplaceTypes);
    } catch {
      values = [];
    }
  }
  if (!Array.isArray(values)) return [];
  const wanted = WORKPLACE_TYPES.filter((type) => values.includes(type));
  return wanted.length === WORKPLACE_TYPES.length ? [] : wanted;
}

export interface JobBoardRunOptions {
  searchTerms?: string[];
  /** Requested cities; jobs elsewhere are skipped before they count toward the cap. */
  cities?: string[];
  maxJobsPerTerm?: number;
  pageSize?: number;
  delayMs?: number;
  /** Stop starting requests after this long and return what was collected. */
  timeBudgetMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  shouldCancel?: () => boolean;
  onProgress?: (event: JobBoardProgressEvent) => void;
}

/** Shared run options for a job-board manifest's `run(context)`. */
export function jobBoardOptionsFromContext(
  context: ExtractorRuntimeContext,
  label: string,
): JobBoardRunOptions {
  return {
    searchTerms: context.searchTerms,
    cities: resolveRequestedCities(context),
    maxJobsPerTerm: resolveMaxJobsPerTerm(context.settings),
    shouldCancel: context.shouldCancel,
    onProgress: (event) => {
      if (!context.shouldCancel?.()) {
        context.onProgress?.(toExtractorProgress(label, event));
      }
    },
  };
}

export type AcceptResult = "added" | "duplicate" | "filtered";

export interface TermSearchContext {
  searchTerm: string;
  termIndex: number;
  termTotal: number;
  client: PoliteJsonClient;
  /** Per-term cap on collected jobs. */
  maxJobs: number;
  /** Per-term cap on scanned list results. */
  maxScanned: number;
  pageSize: number;
  cities: readonly string[];
  /** True once the run is cancelled or this term's share of the time budget is spent. */
  shouldStop: () => boolean;
  /** Whether a job URL was already collected earlier in this run. */
  isCollected: (jobUrl: string) => boolean;
  matchesCities: (job: CreateJobInput) => boolean;
  /** Collects a job in a requested city unless its URL was already collected. */
  accept: (job: CreateJobInput) => AcceptResult;
  /** Records a problem as a source error (it can fail a run without jobs). */
  reportError: (message: string) => void;
  /**
   * Records something the owner should know (results cut short, a filter
   * not applied) as a source message that never fails the run.
   */
  reportNote: (message: string) => void;
  reportDetails: (progress: {
    detailsTotal: number;
    detailsFetched: number;
    detailsSkipped: number;
  }) => void;
  /** Emits a free-form progress line for this term. */
  reportProgress: (detail: string) => void;
}

/**
 * Runs one search per term in order with a polite client, de-duplicating jobs
 * by `jobUrl` across terms. A failing term becomes a source error and the
 * remaining terms still run; the run only fails when no term produced jobs.
 * Cancellation returns the jobs collected so far, and so does running out of
 * the time budget (with a source error saying the run was cut short).
 *
 * The time budget is shared fairly: each term may use at most the remaining
 * budget divided by the remaining terms, so a slow early term cannot starve
 * the later ones, and time an early term leaves unused goes to the rest. A
 * term that uses up its share stops with a source note and the next term
 * starts. With one term, the term has the whole budget.
 */
export async function runJobBoard(args: {
  label: string;
  options: JobBoardRunOptions;
  maxPageSize: number;
  defaultSearchTerm?: string;
  /**
   * Decides whether a run that recorded errors failed. Defaults to "no jobs
   * were collected"; a multi-employer source can instead fail only when every
   * employer failed.
   */
  shouldFail?: (outcome: {
    jobs: readonly CreateJobInput[];
    errors: readonly string[];
  }) => boolean;
  runTerm: (context: TermSearchContext) => Promise<void>;
}): Promise<ExtractorRunResult> {
  const { label, options } = args;
  const searchTerms = options.searchTerms?.length
    ? options.searchTerms
    : [args.defaultSearchTerm ?? "software engineer"];
  const maxJobs = Math.max(
    1,
    Math.floor(options.maxJobsPerTerm ?? DEFAULT_MAX_JOBS_PER_TERM),
  );
  const pageSize = Math.min(
    args.maxPageSize,
    Math.max(1, Math.floor(options.pageSize ?? args.maxPageSize)),
  );
  const cities = options.cities ?? [];
  const now = options.now ?? Date.now;
  const budgetMs = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const deadline = now() + budgetMs;
  let termDeadline = deadline;
  const client = createPoliteJsonClient({
    label,
    fetchImpl: options.fetchImpl,
    delayMs: options.delayMs,
    sleep: options.sleep,
    deadline: () => termDeadline,
    now,
  });

  const jobs: CreateJobInput[] = [];
  const seenUrls = new Set<string>();
  // Source messages in the order they happened; only errors can fail the run.
  const messages: Array<{ text: string; isError: boolean }> = [];
  let outOfTime = false;
  let termOutOfTime = false;
  const shouldStop = () => {
    if (options.shouldCancel?.()) return true;
    if (now() >= termDeadline) termOutOfTime = true;
    return termOutOfTime;
  };
  const matchesCities = (job: CreateJobInput) =>
    jobMatchesIndonesianCities(job, cities);

  for (const [index, searchTerm] of searchTerms.entries()) {
    if (options.shouldCancel?.() || now() >= deadline) {
      outOfTime ||= now() >= deadline;
      break;
    }
    const termIndex = index + 1;
    const termTotal = searchTerms.length;
    const termsLeft = termTotal - index;
    const termStart = now();
    termDeadline =
      termsLeft > 1
        ? termStart + Math.floor((deadline - termStart) / termsLeft)
        : deadline;
    termOutOfTime = false;
    options.onProgress?.({
      type: "term_start",
      termIndex,
      termTotal,
      searchTerm,
    });

    let jobsFoundTerm = 0;
    try {
      await args.runTerm({
        searchTerm,
        termIndex,
        termTotal,
        client,
        maxJobs,
        maxScanned: Math.max(pageSize, maxJobs * SCAN_FACTOR),
        pageSize,
        cities,
        shouldStop,
        isCollected: (jobUrl) => seenUrls.has(jobUrl),
        matchesCities,
        accept: (job) => {
          if (seenUrls.has(job.jobUrl)) return "duplicate";
          if (!matchesCities(job)) return "filtered";
          seenUrls.add(job.jobUrl);
          jobs.push(job);
          jobsFoundTerm += 1;
          return "added";
        },
        reportError: (message) => {
          messages.push({
            text: `${message} (term: ${searchTerm})`,
            isError: true,
          });
        },
        reportNote: (message) => {
          messages.push({
            text: `${message} (term: ${searchTerm})`,
            isError: false,
          });
        },
        reportDetails: (progress) => {
          options.onProgress?.({
            type: "details",
            termIndex,
            termTotal,
            searchTerm,
            ...progress,
          });
        },
        reportProgress: (detail) => {
          options.onProgress?.({
            type: "note",
            termIndex,
            termTotal,
            searchTerm,
            detail,
          });
        },
      });
    } catch (error) {
      if (error instanceof TimeBudgetExceededError) {
        termOutOfTime = true;
      } else {
        const message =
          error instanceof Error ? error.message : "unexpected extractor error";
        messages.push({
          text: `${message} (term: ${searchTerm})`,
          isError: true,
        });
      }
    }

    if (termOutOfTime && !options.shouldCancel?.()) {
      if (termDeadline >= deadline) {
        outOfTime = true;
      } else {
        messages.push({
          text: `${label}: used this term's share of the time limit (about ${Math.max(1, Math.round((termDeadline - termStart) / 1000))} seconds) and moved on so later search terms get their turn; kept ${jobsFoundTerm} jobs for it (term: ${searchTerm})`,
          isError: false,
        });
      }
    }

    options.onProgress?.({
      type: "term_complete",
      termIndex,
      termTotal,
      searchTerm,
      jobsFoundTerm,
    });
  }

  if (outOfTime) {
    messages.push({
      text: `${label}: stopped after ${Math.round(budgetMs / 60_000)} minutes to stay within the source time limit; kept the ${jobs.length} jobs collected so far`,
      isError: true,
    });
  }
  const errors = messages
    .filter((message) => message.isError)
    .map((message) => message.text);
  const texts = messages.map((message) => message.text);
  const failed =
    errors.length > 0 &&
    (args.shouldFail ? args.shouldFail({ jobs, errors }) : jobs.length === 0);
  if (failed) {
    return { success: false, jobs: [], error: texts.join("; ") };
  }
  return texts.length > 0
    ? { success: true, jobs, sourceErrors: texts }
    : { success: true, jobs };
}

/**
 * Pages through one term's list results until the per-term cap or scan limit
 * is reached, the source has no more pages, or a page holds nothing new to
 * this run (its jobs were all taken by earlier terms). Returns the number of
 * jobs `consume` added (default: `context.accept`).
 */
export async function collectPages(
  context: TermSearchContext,
  args: {
    fetchPage: (page: {
      /** 1-based page number. */
      number: number;
      offset: number;
      limit: number;
    }) => Promise<{ items: readonly unknown[]; hasMore: boolean }>;
    toJob: (item: unknown) => CreateJobInput | null;
    consume?: (job: CreateJobInput, item: unknown) => AcceptResult;
  },
): Promise<number> {
  const consume = args.consume ?? ((job) => context.accept(job));
  let added = 0;
  let scanned = 0;
  let offset = 0;
  for (let number = 1; added < context.maxJobs; number += 1) {
    if (scanned >= context.maxScanned || context.shouldStop()) break;
    const { items, hasMore } = await args.fetchPage({
      number,
      offset,
      limit: context.pageSize,
    });

    let newToRun = 0;
    for (const item of items) {
      scanned += 1;
      const job = args.toJob(item);
      const result = job ? consume(job, item) : "filtered";
      if (result !== "duplicate") newToRun += 1;
      if (result === "added") added += 1;
      if (added >= context.maxJobs) break;
    }

    offset += items.length;
    if (!hasMore || items.length === 0 || newToRun === 0) break;
  }
  return added;
}
