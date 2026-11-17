import {
  acceptWithDetails,
  asHttpUrl,
  asNumber,
  asRecord,
  asString,
  asStringList,
  buildIndonesianLocation,
  buildSalaryFields,
  collectPages,
  createDetailCandidates,
  createKnownJobUrls,
  formatRange,
  INDONESIA_COUNTRY_NAME,
  type JobBoardRunOptions,
  joinList,
  namesOf,
  runJobBoard,
  toWorkplaceType,
  type UnknownRecord,
} from "@shared/extractors/indonesia/index.js";
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

export interface RunDeallsOptions extends JobBoardRunOptions {
  /** Already-imported job URLs; their detail requests are skipped. */
  getExistingJobUrls?: () => Promise<string[]>;
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
      ...namesOf(list?.skills),
      ...namesOf(asRecord(detail?.candidatePreference)?.skills),
    ]),
  ];
  const applyUrl = asHttpUrl(pick("externalPlatformApplyUrl"));
  const companySize = asRecord(company?.size);

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
    jobType: joinList(employmentTypes),
    jobFunction:
      asString(asRecord(detail?.jobRoleSubCategory)?.name) ??
      asString(asRecord(detail?.jobRoleCategory)?.name),
    isRemote: workplaceType === "remote",
    workFromHomeType: workplaceType ?? undefined,
    skills: joinList(skills),
    companyLogo: asHttpUrl(company?.logoUrl),
    companyUrlDirect: asHttpUrl(company?.website),
    companyIndustry: asString(company?.sector),
    companyDescription: cleanHtml(company?.description),
    companyNumEmployees: formatRange(
      asNumber(companySize?.start),
      asNumber(companySize?.end),
      "employees",
    ),
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

/**
 * Dealls has no verified city filter, so requested cities are applied
 * client-side before a job counts toward the cap. Detail requests are skipped
 * for job URLs already in job-ops; a job whose detail request fails is not
 * imported, so the next run fetches it again.
 */
export async function runDealls(
  options: RunDeallsOptions = {},
): Promise<ExtractorRunResult> {
  const knownUrls = createKnownJobUrls(options.getExistingJobUrls);

  return runJobBoard({
    label: DEALLS_LABEL,
    options,
    maxPageSize: MAX_PAGE_SIZE,
    runTerm: async (context) => {
      // 1. Collect list items for this term, up to the per-term cap.
      const { candidates, consume } =
        createDetailCandidates<UnknownRecord>(context);
      await collectPages(context, {
        toJob: (item) => mapDeallsJob(item),
        consume: (job, item) => consume(job, asRecord(item) ?? {}),
        fetchPage: async ({ number, limit }) => {
          const payload = asRecord(
            asRecord(
              await context.client.getJson(
                buildDeallsSearchUrl({
                  searchTerm: context.searchTerm,
                  page: number,
                  limit,
                }),
              ),
            )?.data,
          );
          if (!Array.isArray(payload?.docs)) {
            throw new Error(
              `${DEALLS_LABEL} returned an invalid jobs response`,
            );
          }
          return {
            items: payload.docs,
            hasMore: number < (asNumber(payload.totalPages) ?? number),
          };
        },
      });

      // 2. Fetch details for jobs that are not already imported.
      await acceptWithDetails(context, candidates, {
        label: DEALLS_LABEL,
        knownUrls,
        fetchDetail: async ({ item }) => {
          const detail = asRecord(
            asRecord(
              asRecord(
                await context.client.getJson(
                  buildDeallsDetailUrl(asString(item.slug) ?? ""),
                ),
              )?.data,
            )?.result,
          );
          if (!detail) {
            throw new Error(`${DEALLS_LABEL} returned an invalid job detail`);
          }
          return isClosed(detail) ? null : mapDeallsJob(item, detail);
        },
      });
    },
  });
}
