import { randomUUID } from "node:crypto";
import {
  acceptWithDetails,
  asNumber,
  asRecord,
  asString,
  buildIndonesianLocation,
  buildSalaryFields,
  collectPages,
  createDetailCandidates,
  createKnownJobUrls,
  formatRange,
  INDONESIA_COUNTRY_NAME,
  isRelevantJobTitle,
  type JobBoardRunOptions,
  runJobBoard,
  toWorkplaceType,
  type UnknownRecord,
} from "@shared/extractors/indonesia/index.js";
import type { LocationWorkplaceType } from "@shared/location-domain.js";
import type { ExtractorRunResult } from "@shared/types/extractors";
import type { CreateJobInput } from "@shared/types/jobs";
import { DraftJsParseError, draftJsToHtml } from "./draft";

export const GLINTS_SOURCE = "glints";
export const GLINTS_LABEL = "Glints";
const GLINTS_ORIGIN = "https://glints.com";
const GLINTS_GRAPHQL_URL = `${GLINTS_ORIGIN}/api/v2/graphql`;
const GLINTS_JOB_URL = `${GLINTS_ORIGIN}/id/opportunities/jobs/`;
/** Largest page Glints serves; without login only page 1 is served. */
const MAX_PAGE_SIZE = 50;
/** The title and city filters run after the request, so ask for more than the cap. */
const PAGE_SIZE_PER_WANTED_JOB = 3;

const WORK_ARRANGEMENTS: Record<LocationWorkplaceType, string> = {
  remote: "REMOTE",
  hybrid: "HYBRID",
  onsite: "ONSITE",
};

const JOB_TYPE_LABELS: Record<string, string> = {
  FULL_TIME: "Full-time",
  PART_TIME: "Part-time",
  CONTRACT: "Contract",
  INTERNSHIP: "Internship",
  FREELANCE: "Freelance",
  PROJECT_BASED: "Project-based",
  DAILY: "Daily",
};

// Fields shared by the search and detail queries. `location` is the place
// hierarchy (district -> city -> province -> country).
const JOB_FIELDS =
  "id title type workArrangementOption status createdAt updatedAt minYearsOfExperience maxYearsOfExperience shouldShowSalary salaries { salaryType salaryMode maxAmount minAmount CurrencyCode } company { id name brandName } city { name } country { code name } location { name formattedName administrativeLevelName level parents { name formattedName administrativeLevelName level } }";
const SEARCH_QUERY = `query searchJobsV3($data: JobSearchConditionInput!) { searchJobsV3(data: $data) { hasMore jobsInPage { ${JOB_FIELDS} } } }`;
const DETAIL_QUERY = `query getJobById($id: String!) { getJobById(id: $id) { ${JOB_FIELDS} descriptionJsonString } }`;

export interface RunGlintsOptions extends JobBoardRunOptions {
  /** Already-imported job URLs; their detail requests are skipped. */
  getExistingJobUrls?: () => Promise<string[]>;
  /** Narrower than "any" workplace choice, sent as Glints' work-arrangement filter. */
  workplaceTypes?: readonly LocationWorkplaceType[];
  /** Value of the `deviceid` cookie; a fresh random id per run by default. */
  deviceId?: string;
}

/** Glints redirects `/id/opportunities/jobs/<id>` to the page with the title slug. */
export function buildGlintsJobUrl(id: string): string {
  return `${GLINTS_JOB_URL}${encodeURIComponent(id)}`;
}

export function buildGlintsSearchRequest(args: {
  searchTerm: string;
  pageSize: number;
  workplaceTypes?: readonly LocationWorkplaceType[];
}) {
  const arrangements = [...new Set(args.workplaceTypes ?? [])].map(
    (type) => WORK_ARRANGEMENTS[type],
  );
  return {
    operationName: "searchJobsV3",
    variables: {
      data: {
        CountryCode: "ID",
        SearchTerm: args.searchTerm,
        page: 1,
        pageSize: Math.min(
          MAX_PAGE_SIZE,
          Math.max(1, Math.floor(args.pageSize)),
        ),
        sortBy: "LATEST",
        ...(arrangements.length > 0 && arrangements.length < 3
          ? { workArrangementOptions: arrangements }
          : {}),
      },
    },
    query: SEARCH_QUERY,
  };
}

export function buildGlintsDetailRequest(id: string) {
  return {
    operationName: "getJobById",
    variables: { id },
    query: DETAIL_QUERY,
  };
}

function graphqlUrl(operation: string): URL {
  const url = new URL(GLINTS_GRAPHQL_URL);
  url.searchParams.set("op", operation);
  return url;
}

/** A GraphQL error code such as `NO_PERMISSION`, never the upstream message. */
function graphqlErrorCode(payload: UnknownRecord | null): string | undefined {
  if (!Array.isArray(payload?.errors) || payload.errors.length === 0) {
    return undefined;
  }
  const code = asString(
    asRecord(asRecord(payload.errors[0])?.extensions)?.code,
  );
  return code && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "unknown";
}

function placeAtLevel(location: UnknownRecord | null, level: number) {
  if (!location) return undefined;
  if (asNumber(location.level) === level) return asString(location.name);
  const parents = Array.isArray(location.parents) ? location.parents : [];
  for (const parent of parents) {
    const record = asRecord(parent);
    if (asNumber(record?.level) === level) return asString(record?.name);
  }
  return undefined;
}

function buildLocation(
  row: UnknownRecord,
  workplaceType: LocationWorkplaceType | null,
) {
  const place = asRecord(row.location);
  // Levels: 1 country, 2 province, 3 city or regency, 4 district.
  const district =
    (asNumber(place?.level) ?? 0) >= 4 ? asString(place?.name) : undefined;
  const built = buildIndonesianLocation({
    city: placeAtLevel(place, 3) ?? asString(asRecord(row.city)?.name),
    region: placeAtLevel(place, 2),
    country: INDONESIA_COUNTRY_NAME,
    workplaceType,
    source: GLINTS_SOURCE,
  });
  if (!district) return built;
  return {
    location: `${district}, ${built.location}`,
    locationEvidence: {
      ...built.locationEvidence,
      location: `${district}, ${built.locationEvidence.location}`,
    },
  };
}

function buildSalary(row: UnknownRecord) {
  if (row.shouldShowSalary === false || !Array.isArray(row.salaries)) {
    return {};
  }
  const salaries = row.salaries.map(asRecord);
  const salary =
    salaries.find((entry) => asString(entry?.salaryType) === "BASIC") ??
    salaries[0];
  return buildSalaryFields({
    min: salary?.minAmount,
    max: salary?.maxAmount,
    currency: asString(salary?.CurrencyCode),
    interval: asString(salary?.salaryMode),
  });
}

/**
 * Maps a Glints job (a search result, optionally enriched by its detail
 * record) with an already converted description. Closed jobs and jobs
 * outside Indonesia are skipped.
 */
export function mapGlintsJob(
  listValue: unknown,
  detailValue?: unknown,
  jobDescription?: string,
): CreateJobInput | null {
  const list = asRecord(listValue);
  const detail = asRecord(detailValue);
  if (!list && !detail) return null;
  const row: UnknownRecord = { ...list };
  for (const [key, value] of Object.entries(detail ?? {})) {
    if (value !== null && value !== undefined) row[key] = value;
  }

  const id = asString(row.id);
  const title = asString(row.title);
  const company = asRecord(row.company);
  const employer = asString(company?.brandName) ?? asString(company?.name);
  if (!id || !title || !employer) return null;
  const status = asString(row.status);
  if (status && status !== "OPEN") return null;
  const countryCode = asString(asRecord(row.country)?.code);
  if (countryCode && countryCode.toUpperCase() !== "ID") return null;

  const workplaceType = toWorkplaceType(row.workArrangementOption);
  const { location, locationEvidence } = buildLocation(row, workplaceType);
  const type = asString(row.type);
  const jobUrl = buildGlintsJobUrl(id);

  return {
    source: GLINTS_SOURCE,
    sourceJobId: id,
    title,
    employer,
    jobUrl,
    applicationLink: jobUrl,
    location,
    locationEvidence,
    jobDescription,
    datePosted: asString(row.createdAt) ?? asString(row.updatedAt),
    ...buildSalary(row),
    jobType: type ? (JOB_TYPE_LABELS[type] ?? type) : undefined,
    experienceRange: formatRange(
      asNumber(row.minYearsOfExperience),
      asNumber(row.maxYearsOfExperience),
      "years",
    ),
    isRemote: workplaceType === "remote",
    workFromHomeType: workplaceType ?? undefined,
  };
}

/**
 * Searches Glints newest first with a per-run `deviceid` cookie (without it
 * Glints ignores the search term). Only the first page is served without
 * login, so each term makes one search request for up to 50 jobs. Glints'
 * search also returns unrelated titles, so titles must match the term;
 * cities are filtered here. Each new job gets one detail request for its
 * Draft.js description; a job whose detail request fails is not imported,
 * and one whose description cannot be read is imported without it and
 * reported as a source error.
 */
export async function runGlints(
  options: RunGlintsOptions = {},
): Promise<ExtractorRunResult> {
  const knownUrls = createKnownJobUrls(options.getExistingJobUrls);
  const requestOptions = {
    headers: { Cookie: `deviceid=${options.deviceId ?? randomUUID()}` },
  };
  const wanted = Math.max(1, Math.floor(options.maxJobsPerTerm ?? 50));

  return runJobBoard({
    label: GLINTS_LABEL,
    options: {
      ...options,
      pageSize: options.pageSize ?? wanted * PAGE_SIZE_PER_WANTED_JOB,
    },
    maxPageSize: MAX_PAGE_SIZE,
    runTerm: async (context) => {
      const { candidates, consume } =
        createDetailCandidates<UnknownRecord>(context);
      await collectPages(context, {
        toJob: (item) => mapGlintsJob(item),
        consume: (job, item) =>
          isRelevantJobTitle(job.title, context.searchTerm)
            ? consume(job, item)
            : "filtered",
        fetchPage: async ({ limit }) => {
          const payload = asRecord(
            await context.client.postJson(
              graphqlUrl("searchJobsV3"),
              buildGlintsSearchRequest({
                searchTerm: context.searchTerm,
                pageSize: limit,
                workplaceTypes: options.workplaceTypes,
              }),
              requestOptions,
            ),
          );
          const items = asRecord(
            asRecord(payload?.data)?.searchJobsV3,
          )?.jobsInPage;
          if (!Array.isArray(items)) {
            const code = graphqlErrorCode(payload);
            throw new Error(
              code
                ? `${GLINTS_LABEL} search returned GraphQL error ${code}`
                : `${GLINTS_LABEL} returned an invalid jobs response`,
            );
          }
          // Later pages need a login, so the first page is the last.
          return { items, hasMore: false };
        },
      });

      let unreadableDescriptions = 0;
      await acceptWithDetails(context, candidates, {
        label: GLINTS_LABEL,
        knownUrls,
        fetchDetail: async ({ job, item }) => {
          const payload = asRecord(
            await context.client.postJson(
              graphqlUrl("getJobById"),
              buildGlintsDetailRequest(job.sourceJobId ?? ""),
              requestOptions,
            ),
          );
          const detail = asRecord(asRecord(payload?.data)?.getJobById);
          if (!detail) {
            throw new Error(`${GLINTS_LABEL} returned an invalid job detail`);
          }
          let description: string | undefined;
          try {
            description =
              draftJsToHtml(asString(detail.descriptionJsonString) ?? "") ||
              undefined;
          } catch (error) {
            if (!(error instanceof DraftJsParseError)) throw error;
            unreadableDescriptions += 1;
          }
          return mapGlintsJob(item, detail, description);
        },
      });

      if (unreadableDescriptions > 0) {
        context.reportError(
          `${GLINTS_LABEL}: ${unreadableDescriptions} job description(s) could not be read; those jobs were imported without a description`,
        );
      }
    },
  });
}
