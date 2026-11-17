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

export const TECHINASIA_SOURCE = "techinasia";
export const TECHINASIA_LABEL = "Tech in Asia";
const TECHINASIA_SEARCH_URL = "https://www.techinasia.com/api/2.0/job-postings";
const TECHINASIA_JOB_URL = "https://www.techinasia.com/jobs/";
const MAX_PAGE_SIZE = 20;

export interface RunTechInAsiaOptions {
  searchTerms?: string[];
  maxJobsPerTerm?: number;
  pageSize?: number;
  delayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
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

function names(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => asString(asRecord(item)?.name))
        .filter((item): item is string => Boolean(item))
    : [];
}

/** Tech in Asia timestamps are UTC without a zone ("2026-11-16 07:08:26"). */
export function toUtcIso(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(raw);
  return match ? `${match[1]}T${match[2]}Z` : raw;
}

function toWorkplaceType(row: UnknownRecord): LocationWorkplaceType | null {
  const arrangement = asString(row.work_arrangement)
    ?.toLowerCase()
    .replace(/[^a-z]/g, "");
  if (arrangement === "remote" || row.is_remote === true) return "remote";
  if (arrangement === "hybrid") return "hybrid";
  if (arrangement === "onsite") return "onsite";
  return null;
}

function formatRange(
  min: number | undefined,
  max: number | undefined,
  unit: string,
): string | undefined {
  if (min === undefined && max === undefined) return undefined;
  if (min !== undefined && max !== undefined && min !== max) {
    return `${min}–${max} ${unit}`;
  }
  return `${min ?? max} ${unit}`;
}

export function buildTechInAsiaJobUrl(id: string): string {
  return `${TECHINASIA_JOB_URL}${encodeURIComponent(id)}`;
}

export function mapTechInAsiaJob(value: unknown): CreateJobInput | null {
  const row = asRecord(value);
  if (!row) return null;
  const status = asString(row.status);
  if (status && status !== "published") return null;

  const id = asString(row.id);
  const title = asString(row.title);
  const company = asRecord(row.company);
  const employer = asString(company?.name);
  if (!id || !title || !employer) return null;

  const jobUrl = buildTechInAsiaJobUrl(id);
  const city = asRecord(row.city);
  const workplaceType = toWorkplaceType(row);
  const { location, locationEvidence } = buildIndonesianLocation({
    city: asString(city?.name),
    region: asString(asRecord(city?.state)?.name),
    country: asString(asRecord(city?.country)?.name) ?? INDONESIA_COUNTRY_NAME,
    workplaceType,
    source: TECHINASIA_SOURCE,
  });

  const salary =
    row.is_salary_visible === false
      ? {}
      : buildSalaryFields({
          min: row.salary_min,
          max: row.salary_max,
          currency: asString(asRecord(row.currency)?.currency_code),
          interval: asString(row.period),
        });

  const entity = asRecord(company?.entity);
  const images = Array.isArray(entity?.images) ? entity.images : [];
  const avatar = images
    .map(asRecord)
    .find((image) => asString(image?.type) === "avatar");
  const sites = Array.isArray(entity?.sites) ? entity.sites : [];
  const industries = names(entity?.industries);
  const skills = names(row.job_skills);
  const employeeMin = asNumber(company?.employee_min_count);
  const employeeMax = asNumber(company?.employee_max_count);

  return {
    source: TECHINASIA_SOURCE,
    sourceJobId: id,
    title,
    employer,
    jobUrl,
    applicationLink: asHttpUrl(row.external_link) ?? jobUrl,
    jobUrlDirect: asHttpUrl(row.external_link),
    location,
    locationEvidence,
    jobDescription: asString(row.description),
    datePosted: toUtcIso(row.published_at),
    deadline: toUtcIso(row.expires_at),
    ...salary,
    jobType: asString(asRecord(row.job_type)?.name),
    jobFunction: asString(asRecord(row.position)?.name),
    isRemote: workplaceType === "remote",
    workFromHomeType: workplaceType ?? undefined,
    skills: skills.length > 0 ? skills.join(", ") : undefined,
    experienceRange: formatRange(
      asNumber(row.experience_min),
      asNumber(row.experience_max),
      "years",
    ),
    vacancyCount: asNumber(row.vacancy_count),
    companyLogo: asHttpUrl(avatar?.url),
    companyUrlDirect: sites
      .map((site) => asHttpUrl(asRecord(site)?.url))
      .find(Boolean),
    companyIndustry: industries.length > 0 ? industries.join(", ") : undefined,
    companyNumEmployees: formatRange(employeeMin, employeeMax, "employees"),
    companyDescription: asString(company?.pitch),
  };
}

export function buildTechInAsiaSearchUrl(args: {
  searchTerm: string;
  page: number;
  pageSize: number;
}): URL {
  const url = new URL(TECHINASIA_SEARCH_URL);
  url.searchParams.set("query", args.searchTerm);
  url.searchParams.set("page", String(Math.max(1, Math.floor(args.page))));
  url.searchParams.set(
    "per_page",
    String(Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(args.pageSize)))),
  );
  url.searchParams.append("country_name[]", INDONESIA_COUNTRY_NAME);
  return url;
}

export async function runTechInAsia(
  options: RunTechInAsiaOptions = {},
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
    label: TECHINASIA_LABEL,
    fetchImpl: options.fetchImpl,
    delayMs: options.delayMs,
    sleep: options.sleep,
  });

  return runTermSearches({
    searchTerms,
    shouldCancel: options.shouldCancel,
    onProgress: options.onProgress,
    searchTerm: async ({ searchTerm, accept }) => {
      let added = 0;
      for (let page = 1; added < maxJobsPerTerm; page += 1) {
        if (options.shouldCancel?.()) return;
        const payload = asRecord(
          await client.getJson(
            buildTechInAsiaSearchUrl({ searchTerm, page, pageSize }),
          ),
        );
        if (!Array.isArray(payload?.data)) {
          throw new Error(
            `${TECHINASIA_LABEL} returned an invalid jobs response`,
          );
        }

        for (const value of payload.data) {
          const job = mapTechInAsiaJob(value);
          if (job && accept(job)) added += 1;
          if (added >= maxJobsPerTerm) break;
        }

        const lastPage = asNumber(payload.last_page) ?? page;
        if (payload.data.length === 0 || page >= lastPage) return;
      }
    },
  });
}
