import type { LocationWorkplaceType } from "../location-domain";
import type {
  ExtractorProgressEvent,
  ExtractorRunResult,
} from "../types/extractors";
import type { CreateJobInput } from "../types/jobs";

/**
 * Helpers shared by the Indonesian job-board extractors (Tech in Asia, Kalibrr,
 * Dealls, ...): a polite JSON client, Indonesian location evidence, and salary
 * normalisation. Extractor-specific mapping stays in each extractor.
 */

export const INDONESIA_COUNTRY_KEY = "indonesia";
export const INDONESIA_COUNTRY_NAME = "Indonesia";
export const INDONESIA_SUPPORTED_COUNTRY_KEYS = [INDONESIA_COUNTRY_KEY];

export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export const DEFAULT_POLITE_DELAY_MS = 1_500;
const DEFAULT_TIMEOUT_MS = 20_000;

export interface PoliteJsonClientOptions {
  /** Human-readable source name used in sanitised error messages. */
  label: string;
  fetchImpl?: typeof fetch;
  /** Pause before every request except the first one. */
  delayMs?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  sleep?: (ms: number) => Promise<void>;
}

export interface PoliteJsonClient {
  getJson(url: URL | string): Promise<unknown>;
  /** Number of requests sent so far. */
  readonly requestCount: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sequential JSON GET client with a browser-like user agent and a fixed pause
 * between requests. Errors never include upstream response bodies.
 */
export function createPoliteJsonClient(
  options: PoliteJsonClientOptions,
): PoliteJsonClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const delayMs = Math.max(0, options.delayMs ?? DEFAULT_POLITE_DELAY_MS);
  let requestCount = 0;

  return {
    get requestCount() {
      return requestCount;
    },
    async getJson(url) {
      if (requestCount > 0 && delayMs > 0) await sleep(delayMs);
      requestCount += 1;

      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers: {
            Accept: "application/json",
            "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
            "User-Agent": BROWSER_USER_AGENT,
            ...options.headers,
          },
          signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch (error) {
        const timedOut =
          error instanceof Error &&
          (error.name === "TimeoutError" || error.name === "AbortError");
        throw new Error(
          `${options.label} request ${timedOut ? "timed out" : "failed (network error)"}`,
        );
      }

      if (!response.ok) {
        throw new Error(
          `${options.label} request failed with status ${response.status}`,
        );
      }

      try {
        return (await response.json()) as unknown;
      } catch {
        throw new Error(`${options.label} returned an invalid JSON response`);
      }
    },
  };
}

export type SalaryInterval =
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly";

const SALARY_INTERVAL_ALIASES: Record<string, SalaryInterval> = {
  hour: "hourly",
  hourly: "hourly",
  jam: "hourly",
  day: "daily",
  daily: "daily",
  hari: "daily",
  week: "weekly",
  weekly: "weekly",
  minggu: "weekly",
  month: "monthly",
  monthly: "monthly",
  bulan: "monthly",
  year: "yearly",
  yearly: "yearly",
  annual: "yearly",
  annually: "yearly",
  tahun: "yearly",
};

/** Maps source period labels ("MONTHLY", "Per Month", "bulan") to the app's interval values. */
export function normalizeSalaryInterval(
  value: string | null | undefined,
): SalaryInterval | undefined {
  const key = value
    ?.trim()
    .toLowerCase()
    .replace(/^(per|a|an|\/)\s*/, "");
  return key ? SALARY_INTERVAL_ALIASES[key] : undefined;
}

const SALARY_INTERVAL_UNITS: Record<SalaryInterval, string> = {
  hourly: "hour",
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
};

export interface NormalizedSalary {
  salary?: string;
  salaryMinAmount?: number;
  salaryMaxAmount?: number;
  salaryCurrency?: string;
  salaryInterval?: SalaryInterval;
}

function positiveAmount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/**
 * Builds the job salary fields from a numeric range. Zero or missing amounts
 * mean "not published" on Indonesian boards, so they produce no salary.
 */
export function buildSalaryFields(input: {
  min?: unknown;
  max?: unknown;
  currency?: string | null;
  interval?: string | null;
}): NormalizedSalary {
  let min = positiveAmount(input.min);
  let max = positiveAmount(input.max);
  if (min === undefined && max === undefined) return {};
  if (min !== undefined && max !== undefined && max < min) {
    [min, max] = [max, min];
  }

  const currency = input.currency?.trim().toUpperCase() || undefined;
  const interval = normalizeSalaryInterval(input.interval);
  const format = (value: number) =>
    new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(value);
  const amount =
    min !== undefined && max !== undefined
      ? min === max
        ? format(min)
        : `${format(min)}–${format(max)}`
      : min !== undefined
        ? `from ${format(min)}`
        : `up to ${format(max as number)}`;

  return {
    salary: `${currency ? `${currency} ` : ""}${amount}${
      interval ? ` / ${SALARY_INTERVAL_UNITS[interval]}` : ""
    }`,
    salaryMinAmount: min,
    salaryMaxAmount: max,
    salaryCurrency: currency,
    salaryInterval: interval,
  };
}

function cleanPart(value: string | null | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed : undefined;
}

export interface IndonesianLocationInput {
  /** Source city as published, e.g. "Jakarta Selatan" or "Central Jakarta". */
  city?: string | null;
  /** Province or region, e.g. "DKI Jakarta". */
  region?: string | null;
  /** Country name from the source; defaults to Indonesia. */
  country?: string | null;
  workplaceType?: LocationWorkplaceType | null;
  source: string;
}

export interface IndonesianLocation {
  location: string;
  locationEvidence: NonNullable<CreateJobInput["locationEvidence"]>;
}

/**
 * Builds a display location that always names the country ("Jakarta Selatan,
 * Indonesia") plus structured evidence, so jobs from city-only source
 * locations survive the shared country/city location filter.
 */
export function buildIndonesianLocation(
  input: IndonesianLocationInput,
): IndonesianLocation {
  const country = cleanPart(input.country) ?? INDONESIA_COUNTRY_NAME;
  const city = cleanPart(input.city);
  const region = cleanPart(input.region);
  const parts: string[] = [];
  for (const part of [city, region, country]) {
    if (!part) continue;
    if (parts.some((existing) => existing.toLowerCase() === part.toLowerCase()))
      continue;
    parts.push(part);
  }
  const workplaceType = input.workplaceType ?? null;
  const location = parts.join(", ");

  return {
    location,
    locationEvidence: {
      location,
      country,
      countryKey: country.toLowerCase(),
      city: city ?? null,
      regionHints: region ? [region] : null,
      workplaceType,
      isRemote: workplaceType === "remote",
      isHybrid: workplaceType === "hybrid",
      evidenceQuality: city ? "exact" : "approximate",
      source: input.source,
    },
  };
}

const DEFAULT_MAX_JOBS_PER_TERM = 50;
const MAX_JOBS_PER_TERM_LIMIT = 200;

/** Per-term cap from the shared results-wanted setting (`jobspyResultsWanted`). */
export function resolveMaxJobsPerTerm(
  settings: Record<string, string | undefined>,
  fallback = DEFAULT_MAX_JOBS_PER_TERM,
): number {
  const parsed = Number.parseInt(settings.jobspyResultsWanted ?? "", 10);
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  return Math.min(MAX_JOBS_PER_TERM_LIMIT, value);
}

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

export interface TermSearchContext {
  searchTerm: string;
  termIndex: number;
  termTotal: number;
  /** Adds a job unless its URL was already collected; returns whether it was added. */
  accept: (job: CreateJobInput) => boolean;
  /** Records a non-fatal problem (e.g. one failed detail request) as a source error. */
  reportError: (message: string) => void;
}

/**
 * Runs one search per term in order, de-duplicating jobs by `jobUrl` across
 * terms. A failing term is recorded and the remaining terms still run; the
 * run only fails when no term produced jobs. Cancellation returns the jobs
 * collected so far.
 */
export async function runTermSearches(args: {
  searchTerms: string[];
  shouldCancel?: () => boolean;
  onProgress?: (event: JobBoardProgressEvent) => void;
  searchTerm: (context: TermSearchContext) => Promise<void>;
}): Promise<ExtractorRunResult> {
  const jobs: CreateJobInput[] = [];
  const seenUrls = new Set<string>();
  const errors: string[] = [];
  const termTotal = args.searchTerms.length;

  for (const [index, searchTerm] of args.searchTerms.entries()) {
    if (args.shouldCancel?.()) break;
    const termIndex = index + 1;
    args.onProgress?.({ type: "term_start", termIndex, termTotal, searchTerm });

    let jobsFoundTerm = 0;
    try {
      await args.searchTerm({
        searchTerm,
        termIndex,
        termTotal,
        accept: (job) => {
          if (seenUrls.has(job.jobUrl)) return false;
          seenUrls.add(job.jobUrl);
          jobs.push(job);
          jobsFoundTerm += 1;
          return true;
        },
        reportError: (message) => {
          errors.push(`${message} (term: ${searchTerm})`);
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unexpected extractor error";
      errors.push(`${message} (term: ${searchTerm})`);
    }

    args.onProgress?.({
      type: "term_complete",
      termIndex,
      termTotal,
      searchTerm,
      jobsFoundTerm,
    });
  }

  if (errors.length > 0 && jobs.length === 0) {
    return { success: false, jobs: [], error: errors.join("; ") };
  }
  return errors.length > 0
    ? { success: true, jobs, sourceErrors: errors }
    : { success: true, jobs };
}
