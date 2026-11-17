import {
  asHttpUrl,
  asNumber,
  asRecord,
  asString,
  buildIndonesianLocation,
  buildSalaryFields,
  collectPages,
  formatRange,
  INDONESIA_COUNTRY_NAME,
  type JobBoardRunOptions,
  joinList,
  namesOf,
  runJobBoard,
  toWorkplaceType,
} from "@shared/extractors/indonesia/index.js";
import type { ExtractorRunResult } from "@shared/types/extractors";
import type { CreateJobInput } from "@shared/types/jobs";

export const TECHINASIA_SOURCE = "techinasia";
export const TECHINASIA_LABEL = "Tech in Asia";
const TECHINASIA_SEARCH_URL = "https://www.techinasia.com/api/2.0/job-postings";
const TECHINASIA_JOB_URL = "https://www.techinasia.com/jobs/";
const MAX_PAGE_SIZE = 20;

export type RunTechInAsiaOptions = JobBoardRunOptions;

/** Tech in Asia timestamps are UTC without a zone ("2026-11-16 07:08:26"). */
export function toUtcIso(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(raw);
  return match ? `${match[1]}T${match[2]}Z` : raw;
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
  const workplaceType =
    row.is_remote === true ? "remote" : toWorkplaceType(row.work_arrangement);
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
    skills: joinList(namesOf(row.job_skills)),
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
    companyIndustry: joinList(namesOf(entity?.industries)),
    companyNumEmployees: formatRange(
      asNumber(company?.employee_min_count),
      asNumber(company?.employee_max_count),
      "employees",
    ),
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

/**
 * Tech in Asia has no verified city filter, so requested cities are applied
 * client-side (by the shared runner) before a job counts toward the cap.
 */
export async function runTechInAsia(
  options: RunTechInAsiaOptions = {},
): Promise<ExtractorRunResult> {
  return runJobBoard({
    label: TECHINASIA_LABEL,
    options,
    maxPageSize: MAX_PAGE_SIZE,
    runTerm: async (context) => {
      await collectPages(context, {
        toJob: mapTechInAsiaJob,
        fetchPage: async ({ number, limit }) => {
          const payload = asRecord(
            await context.client.getJson(
              buildTechInAsiaSearchUrl({
                searchTerm: context.searchTerm,
                page: number,
                pageSize: limit,
              }),
            ),
          );
          if (!Array.isArray(payload?.data)) {
            throw new Error(
              `${TECHINASIA_LABEL} returned an invalid jobs response`,
            );
          }
          return {
            items: payload.data,
            hasMore: number < (asNumber(payload.last_page) ?? number),
          };
        },
      });
    },
  });
}
