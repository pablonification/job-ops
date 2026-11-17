import {
  buildIndonesianLocation,
  buildSalaryFields,
  createPoliteJsonClient,
  INDONESIA_COUNTRY_NAME,
  type JobBoardProgressEvent,
  runTermSearches,
} from "@shared/extractors/indonesia.js";
import type { LocationWorkplaceType } from "@shared/location-domain.js";
import type { ExtractorRunResult } from "@shared/types/extractors";
import type { CreateJobInput } from "@shared/types/jobs";

export const DEALLS_SOURCE = "dealls";
export const DEALLS_LABEL = "Dealls";
const DEALLS_API_ORIGIN = "https://api.sejutacita.id";
const DEALLS_SEARCH_URL = `${DEALLS_API_ORIGIN}/v1/explore-job/job`;
const DEALLS_DETAIL_URL = `${DEALLS_API_ORIGIN}/v1/job-portal/job/slug/`;
const DEALLS_JOB_URL = "https://dealls.com/loker/";
const MAX_PAGE_SIZE = 20;
// Dealls only lists rupiah salaries and shows them per month.
const DEALLS_SALARY_CURRENCY = "IDR";
const DEALLS_SALARY_INTERVAL = "monthly";

const EMPLOYMENT_TYPE_LABELS: Record<string, string> = {
  fullTime: "Full-time",
  partTime: "Part-time",
  contract: "Contract",
  internship: "Internship",
  freelance: "Freelance",
};

export interface RunDeallsOptions {
  searchTerms?: string[];
  maxJobsPerTerm?: number;
  pageSize?: number;
  delayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Already-imported job URLs; their detail requests are skipped. */
  getExistingJobUrls?: () => Promise<string[]>;
  shouldCancel?: () => boolean;
  onProgress?: (event: JobBoardProgressEvent) => void;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asHttpUrl(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(asString).filter((item): item is string => Boolean(item))
    : [];
}

function skillNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => asString(asRecord(item)?.name))
        .filter((item): item is string => Boolean(item))
    : [];
}

function toWorkplaceType(value: unknown): LocationWorkplaceType | null {
  const normalized = asString(value)
    ?.toLowerCase()
    .replace(/[^a-z]/g, "");
  if (normalized === "remote") return "remote";
  if (normalized === "hybrid") return "hybrid";
  if (normalized === "onsite") return "onsite";
  return null;
}

function cleanHtml(value: unknown): string | undefined {
  return asString(asString(value)?.replace(/&nbsp;/gi, " "));
}

function buildDescription(detail: UnknownRecord | null): string | undefined {
  if (!detail) return undefined;
  const sections = [
    cleanHtml(detail.description),
    cleanHtml(detail.responsibilities)
      ? `<p><strong>Responsibilities</strong></p>\n${cleanHtml(detail.responsibilities)}`
      : undefined,
    cleanHtml(detail.requirements)
      ? `<p><strong>Requirements</strong></p>\n${cleanHtml(detail.requirements)}`
      : undefined,
  ].filter((section): section is string => Boolean(section));
  return sections.length > 0 ? sections.join("\n") : undefined;
}

export function buildDeallsJobUrl(
  jobSlug: string,
  companySlug?: string,
): string {
  const path = companySlug
    ? `${encodeURIComponent(jobSlug)}~${encodeURIComponent(companySlug)}`
    : encodeURIComponent(jobSlug);
  return `${DEALLS_JOB_URL}${path}`;
}

/**
 * Maps a Dealls list item, optionally enriched by its detail record (which
 * carries the description, responsibilities and requirements).
 */
export function mapDeallsJob(
  listValue: unknown,
  detailValue?: unknown,
): CreateJobInput | null {
  const list = asRecord(listValue);
  const detail = asRecord(detailValue);
  if (!list && !detail) return null;
  const pick = (key: string): unknown => detail?.[key] ?? list?.[key];

  const slug = asString(pick("slug"));
  const title = asString(pick("role"));
  const company = asRecord(detail?.company) ?? asRecord(list?.company);
  const employer = asString(company?.name);
  if (!slug || !title || !employer) return null;

  const jobUrl = buildDeallsJobUrl(slug, asString(company?.slug));
  const detailLocation = asRecord(detail?.location);
  const city = asRecord(detailLocation?.city) ?? asRecord(list?.city);
  const country = asRecord(detailLocation?.country) ?? asRecord(list?.country);
  const workplaceType = toWorkplaceType(pick("workplaceType"));
  const { location, locationEvidence } = buildIndonesianLocation({
    city: asString(city?.name),
    country: asString(country?.name) ?? INDONESIA_COUNTRY_NAME,
    workplaceType,
    source: DEALLS_SOURCE,
  });

  const salaryRange = asRecord(pick("salaryRange"));
  const salary =
    asString(pick("salaryType")) === "unpaid"
      ? {}
      : buildSalaryFields({
          min: salaryRange?.start,
          max: salaryRange?.end,
          currency: DEALLS_SALARY_CURRENCY,
          interval: DEALLS_SALARY_INTERVAL,
        });
  const employmentTypes = asStringList(pick("employmentTypes")).map(
    (type) => EMPLOYMENT_TYPE_LABELS[type] ?? type,
  );
  const skills = [
    ...new Set([
      ...skillNames(list?.skills),
      ...skillNames(asRecord(detail?.candidatePreference)?.skills),
    ]),
  ];
  const applyUrl = asHttpUrl(pick("externalPlatformApplyUrl"));
  const companySize = asRecord(company?.size);
  const sizeStart = asNumber(companySize?.start);
  const sizeEnd = asNumber(companySize?.end);

  return {
    source: DEALLS_SOURCE,
    sourceJobId: asString(pick("id")) ?? slug,
    title,
    employer,
    jobUrl,
    applicationLink: applyUrl ?? jobUrl,
    jobUrlDirect: applyUrl,
    location,
    locationEvidence,
    jobDescription: buildDescription(detail),
    datePosted: asString(pick("publishedAt")),
    ...salary,
    jobType:
      employmentTypes.length > 0 ? employmentTypes.join(", ") : undefined,
    jobFunction:
      asString(asRecord(detail?.jobRoleSubCategory)?.name) ??
      asString(asRecord(detail?.jobRoleCategory)?.name),
    isRemote: workplaceType === "remote",
    workFromHomeType: workplaceType ?? undefined,
    skills: skills.length > 0 ? skills.join(", ") : undefined,
    companyLogo: asHttpUrl(company?.logoUrl),
    companyUrlDirect: asHttpUrl(company?.website),
    companyIndustry: asString(company?.sector),
    companyDescription: cleanHtml(company?.description),
    companyNumEmployees:
      sizeStart === undefined
        ? undefined
        : sizeEnd === undefined
          ? `${sizeStart}+ employees`
          : `${sizeStart}–${sizeEnd} employees`,
  };
}

export function buildDeallsSearchUrl(args: {
  searchTerm: string;
  page: number;
  limit: number;
}): URL {
  const url = new URL(DEALLS_SEARCH_URL);
  url.searchParams.set("page", String(Math.max(1, Math.floor(args.page))));
  url.searchParams.set(
    "limit",
    String(Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(args.limit)))),
  );
  url.searchParams.set("search", args.searchTerm);
  return url;
}

export function buildDeallsDetailUrl(slug: string): URL {
  return new URL(`${DEALLS_DETAIL_URL}${encodeURIComponent(slug)}`);
}

function isClosed(detail: UnknownRecord | null): boolean {
  if (!detail) return false;
  const status = asString(detail.status);
  return (
    detail.closed === true || (status !== undefined && status !== "active")
  );
}

export async function runDealls(
  options: RunDeallsOptions = {},
): Promise<ExtractorRunResult> {
  const searchTerms = options.searchTerms?.length
    ? options.searchTerms
    : ["software engineer"];
  const maxJobsPerTerm = Math.max(1, Math.floor(options.maxJobsPerTerm ?? 50));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(options.pageSize ?? MAX_PAGE_SIZE)),
    maxJobsPerTerm,
  );
  const client = createPoliteJsonClient({
    label: DEALLS_LABEL,
    fetchImpl: options.fetchImpl,
    delayMs: options.delayMs,
    sleep: options.sleep,
  });
  const processedUrls = new Set<string>();
  let knownUrlsPromise: Promise<Set<string>> | null = null;
  const getKnownUrls = (): Promise<Set<string>> => {
    if (!knownUrlsPromise) {
      knownUrlsPromise = (
        options.getExistingJobUrls?.() ?? Promise.resolve([])
      ).then(
        (urls) => new Set(urls),
        () => new Set<string>(),
      );
    }
    return knownUrlsPromise;
  };

  return runTermSearches({
    searchTerms,
    shouldCancel: options.shouldCancel,
    onProgress: options.onProgress,
    searchTerm: async ({
      searchTerm,
      termIndex,
      termTotal,
      accept,
      reportError,
    }) => {
      // 1. Collect list items for this term, up to the per-term cap.
      const candidates: Array<{ row: UnknownRecord; job: CreateJobInput }> = [];
      for (let page = 1; candidates.length < maxJobsPerTerm; page += 1) {
        if (options.shouldCancel?.()) return;
        const payload = asRecord(
          asRecord(
            await client.getJson(
              buildDeallsSearchUrl({ searchTerm, page, limit: pageSize }),
            ),
          )?.data,
        );
        if (!Array.isArray(payload?.docs)) {
          throw new Error(`${DEALLS_LABEL} returned an invalid jobs response`);
        }

        for (const value of payload.docs) {
          const row = asRecord(value);
          const job = row ? mapDeallsJob(row) : null;
          if (!row || !job || processedUrls.has(job.jobUrl)) continue;
          processedUrls.add(job.jobUrl);
          candidates.push({ row, job });
          if (candidates.length >= maxJobsPerTerm) break;
        }

        const totalPages = asNumber(payload.totalPages) ?? page;
        if (payload.docs.length === 0 || page >= totalPages) break;
      }

      // 2. Fetch details for jobs that are not already imported.
      const knownUrls = candidates.length > 0 ? await getKnownUrls() : null;
      let detailsFetched = 0;
      let detailsSkipped = 0;
      let detailFailures = 0;
      for (const { row, job } of candidates) {
        if (options.shouldCancel?.()) return;
        if (knownUrls?.has(job.jobUrl)) {
          detailsSkipped += 1;
          accept(job);
        } else {
          const slug = asString(row.slug) as string;
          try {
            const detail = asRecord(
              asRecord(
                asRecord(await client.getJson(buildDeallsDetailUrl(slug)))
                  ?.data,
              )?.result,
            );
            if (!isClosed(detail)) accept(mapDeallsJob(row, detail) ?? job);
          } catch {
            detailFailures += 1;
            accept(job);
          }
          detailsFetched += 1;
        }
        options.onProgress?.({
          type: "details",
          termIndex,
          termTotal,
          searchTerm,
          detailsTotal: candidates.length,
          detailsFetched,
          detailsSkipped,
        });
      }

      if (detailFailures > 0) {
        reportError(
          `${DEALLS_LABEL}: ${detailFailures} job detail request(s) failed; imported without descriptions`,
        );
      }
    },
  });
}
