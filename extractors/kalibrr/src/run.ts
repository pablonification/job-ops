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
import { htmlToPlainText, isRelevantToSearchTerm } from "./relevance";

export const KALIBRR_SOURCE = "kalibrr";
export const KALIBRR_LABEL = "Kalibrr";
const KALIBRR_ORIGIN = "https://www.kalibrr.com";
const KALIBRR_SEARCH_URL = `${KALIBRR_ORIGIN}/kjs/job_board/search`;
const MAX_PAGE_SIZE = 20;
/** Loose upstream matching drops some results; scan at most this many results per wanted job (at least one page). */
const SCAN_FACTOR = 2;

export interface RunKalibrrOptions {
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

function asIdentifier(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return String(value);
  }
  return asString(value);
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

function toWorkplaceType(row: UnknownRecord): LocationWorkplaceType {
  if (row.is_work_from_home === true) return "remote";
  if (row.is_hybrid === true) return "hybrid";
  return "onsite";
}

export function buildKalibrrJobUrl(args: {
  companyCode: string;
  id: string;
  slug?: string;
}): string {
  const path = [
    "c",
    encodeURIComponent(args.companyCode),
    "jobs",
    encodeURIComponent(args.id),
    ...(args.slug ? [encodeURIComponent(args.slug)] : []),
  ].join("/");
  return `${KALIBRR_ORIGIN}/${path}`;
}

function buildDescription(
  description: string | undefined,
  qualifications: string | undefined,
): string | undefined {
  if (!qualifications) return description;
  const hasHeading = /^qualifications?\b/i.test(
    htmlToPlainText(qualifications),
  );
  const section = hasHeading
    ? qualifications
    : `<p><strong>Qualifications</strong></p>\n${qualifications}`;
  return description ? `${description}\n${section}` : section;
}

export function mapKalibrrJob(value: unknown): CreateJobInput | null {
  const row = asRecord(value);
  if (!row) return null;
  const company = asRecord(row.company);
  const companyInfo = asRecord(row.company_info);
  const id = asIdentifier(row.id);
  const title = asString(row.name);
  const employer =
    asString(row.company_name) ??
    asString(company?.name) ??
    asString(companyInfo?.name);
  const companyCode = asString(company?.code) ?? asString(companyInfo?.code);
  if (!id || !title || !employer || !companyCode) return null;

  const jobUrl = buildKalibrrJobUrl({
    companyCode,
    id,
    slug: asString(row.slug),
  });
  const address = asRecord(asRecord(row.google_location)?.address_components);
  const workplaceType = toWorkplaceType(row);
  const { location, locationEvidence } = buildIndonesianLocation({
    city: asString(address?.city),
    region: asString(address?.region),
    country: asString(address?.country) ?? INDONESIA_COUNTRY_NAME,
    workplaceType,
    source: KALIBRR_SOURCE,
  });
  const salary =
    row.salary_shown === false
      ? {}
      : buildSalaryFields({
          min: row.base_salary,
          max: row.maximum_salary,
          currency: asString(row.salary_currency),
          interval: asString(row.salary_interval),
        });
  const skills = Array.isArray(row.job_sds_skills)
    ? row.job_sds_skills
        .map((item) => asString(asRecord(asRecord(item)?.sds_skill)?.name))
        .filter((item): item is string => Boolean(item))
    : [];
  const applyUrl = asHttpUrl(row.apply_redirect_url);

  return {
    source: KALIBRR_SOURCE,
    sourceJobId: id,
    title,
    employer,
    jobUrl,
    applicationLink: applyUrl ?? jobUrl,
    jobUrlDirect: applyUrl,
    location,
    locationEvidence,
    jobDescription: buildDescription(
      asString(row.description),
      asString(row.qualifications),
    ),
    datePosted: asString(row.activation_date) ?? asString(row.created_at),
    deadline: asString(row.application_end_date),
    ...salary,
    jobType: asString(row.tenure),
    jobFunction: asString(row.function),
    isRemote: workplaceType === "remote",
    workFromHomeType: workplaceType,
    skills: skills.length > 0 ? skills.join(", ") : undefined,
    vacancyCount: asNumber(row.number_of_openings),
    companyLogo: asHttpUrl(companyInfo?.logo) ?? asHttpUrl(company?.logo_small),
    companyUrlDirect: asHttpUrl(companyInfo?.url),
    companyIndustry: asString(company?.industry),
    companyDescription: asString(company?.description),
  };
}

export function buildKalibrrSearchUrl(args: {
  searchTerm: string;
  offset: number;
  limit: number;
}): URL {
  const url = new URL(KALIBRR_SEARCH_URL);
  url.searchParams.set(
    "limit",
    String(Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(args.limit)))),
  );
  url.searchParams.set("offset", String(Math.max(0, Math.floor(args.offset))));
  url.searchParams.set("text", args.searchTerm);
  url.searchParams.set("country", INDONESIA_COUNTRY_NAME);
  return url;
}

export async function runKalibrr(
  options: RunKalibrrOptions = {},
): Promise<ExtractorRunResult> {
  const searchTerms = options.searchTerms?.length
    ? options.searchTerms
    : ["software engineer"];
  const maxJobsPerTerm = Math.max(1, Math.floor(options.maxJobsPerTerm ?? 50));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(options.pageSize ?? MAX_PAGE_SIZE)),
  );
  const maxScannedPerTerm = Math.max(maxJobsPerTerm * SCAN_FACTOR, pageSize);
  const client = createPoliteJsonClient({
    label: KALIBRR_LABEL,
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
      let offset = 0;
      while (added < maxJobsPerTerm && offset < maxScannedPerTerm) {
        if (options.shouldCancel?.()) return;
        const payload = asRecord(
          await client.getJson(
            buildKalibrrSearchUrl({
              searchTerm,
              offset,
              limit: Math.min(pageSize, maxScannedPerTerm - offset),
            }),
          ),
        );
        if (!Array.isArray(payload?.jobs)) {
          throw new Error(`${KALIBRR_LABEL} returned an invalid jobs response`);
        }

        for (const value of payload.jobs) {
          const row = asRecord(value);
          const job = mapKalibrrJob(row);
          if (
            !job ||
            !isRelevantToSearchTerm(
              {
                title: job.title,
                description: asString(row?.description),
                qualifications: asString(row?.qualifications),
              },
              searchTerm,
            )
          ) {
            continue;
          }
          if (accept(job)) added += 1;
          if (added >= maxJobsPerTerm) break;
        }

        offset += payload.jobs.length;
        const total = asNumber(payload.count);
        if (
          payload.jobs.length === 0 ||
          (total !== undefined && offset >= total)
        ) {
          return;
        }
      }
    },
  });
}
