import {
  asHttpUrl,
  asIdentifier,
  asNumber,
  asRecord,
  asString,
  buildIndonesianLocation,
  buildSalaryFields,
  collectPages,
  INDONESIA_COUNTRY_NAME,
  indonesianSearchCity,
  isRelevantJobTitle,
  type JobBoardRunOptions,
  joinList,
  namesOf,
  runJobBoard,
  type UnknownRecord,
} from "@shared/extractors/indonesia/index.js";
import type { LocationWorkplaceType } from "@shared/location-domain.js";
import type { ExtractorRunResult } from "@shared/types/extractors";
import type { CreateJobInput } from "@shared/types/jobs";
import { stripHtmlTags } from "@shared/utils/string.js";

export const KALIBRR_SOURCE = "kalibrr";
export const KALIBRR_LABEL = "Kalibrr";
const KALIBRR_ORIGIN = "https://www.kalibrr.com";
const KALIBRR_SEARCH_URL = `${KALIBRR_ORIGIN}/kjs/job_board/search`;
const MAX_PAGE_SIZE = 20;

export type RunKalibrrOptions = JobBoardRunOptions;

function toWorkplaceType(row: UnknownRecord): LocationWorkplaceType {
  if (row.is_work_from_home === true) return "remote";
  if (row.is_hybrid === true) return "hybrid";
  return "onsite";
}

/**
 * Kalibrr serves `/c/<company>/jobs/<id>` without the title slug, so the URL
 * stays stable when an employer edits the title.
 */
export function buildKalibrrJobUrl(args: {
  companyCode: string;
  id: string;
}): string {
  return `${KALIBRR_ORIGIN}/c/${encodeURIComponent(args.companyCode)}/jobs/${encodeURIComponent(args.id)}`;
}

function buildDescription(
  description: string | undefined,
  qualifications: string | undefined,
): string | undefined {
  if (!qualifications) return description;
  const hasHeading = /^qualifications?\b/i.test(stripHtmlTags(qualifications));
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

  const jobUrl = buildKalibrrJobUrl({ companyCode, id });
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
    ? namesOf(row.job_sds_skills.map((item) => asRecord(item)?.sds_skill))
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
    skills: joinList(skills),
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
  /** City for Kalibrr's `location` filter (it matches both "South Jakarta" and "Jakarta Selatan" for "Jakarta"). */
  location?: string;
}): URL {
  const url = new URL(KALIBRR_SEARCH_URL);
  url.searchParams.set(
    "limit",
    String(Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(args.limit)))),
  );
  url.searchParams.set("offset", String(Math.max(0, Math.floor(args.offset))));
  url.searchParams.set("text", args.searchTerm);
  url.searchParams.set("country", INDONESIA_COUNTRY_NAME);
  if (args.location) url.searchParams.set("location", args.location);
  return url;
}

/**
 * Requested cities go to Kalibrr's `location` filter as their base city
 * ("Jakarta Selatan" -> "Jakarta", because Kalibrr labels districts in both
 * languages); the shared runner then keeps only jobs in the requested
 * district. Kalibrr's keyword search is loose, so titles must match the term.
 */
export async function runKalibrr(
  options: RunKalibrrOptions = {},
): Promise<ExtractorRunResult> {
  return runJobBoard({
    label: KALIBRR_LABEL,
    options,
    maxPageSize: MAX_PAGE_SIZE,
    runTerm: async (context) => {
      const locations = context.cities.length
        ? [...new Set(context.cities.map(indonesianSearchCity))]
        : [undefined];
      let added = 0;
      for (const location of locations) {
        if (added >= context.maxJobs || context.shouldStop()) return;
        added += await collectPages(
          { ...context, maxJobs: context.maxJobs - added },
          {
            toJob: mapKalibrrJob,
            consume: (job) =>
              isRelevantJobTitle(job.title, context.searchTerm)
                ? context.accept(job)
                : "filtered",
            fetchPage: async ({ offset, limit }) => {
              const payload = asRecord(
                await context.client.getJson(
                  buildKalibrrSearchUrl({
                    searchTerm: context.searchTerm,
                    offset,
                    limit,
                    location,
                  }),
                ),
              );
              if (!Array.isArray(payload?.jobs)) {
                throw new Error(
                  `${KALIBRR_LABEL} returned an invalid jobs response`,
                );
              }
              const total = asNumber(payload.count);
              return {
                items: payload.jobs,
                hasMore:
                  total === undefined || offset + payload.jobs.length < total,
              };
            },
          },
        );
      }
    },
  });
}
