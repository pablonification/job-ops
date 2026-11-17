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
  PoliteRequestError,
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
/**
 * Largest page Glints serves; without login only page 1 is served. The page
 * costs one request whatever its size, so every term asks for all of it: the
 * cap limits what is imported, not what is scanned.
 */
const MAX_PAGE_SIZE = 50;

const WORK_ARRANGEMENTS: Record<LocationWorkplaceType, string> = {
  remote: "REMOTE",
  hybrid: "HYBRID",
  onsite: "ONSITE",
};

// A Map, so an upstream value such as "constructor" never hits a prototype key.
const JOB_TYPE_LABELS = new Map<string, string>([
  ["FULL_TIME", "Full-time"],
  ["PART_TIME", "Part-time"],
  ["CONTRACT", "Contract"],
  ["INTERNSHIP", "Internship"],
  ["FREELANCE", "Freelance"],
  ["PROJECT_BASED", "Project-based"],
  ["DAILY", "Daily"],
]);

/** Error codes Glints' GraphQL server uses for a rejected variable. */
const REJECTED_INPUT_CODES = new Set([
  "GRAPHQL_VALIDATION_FAILED",
  "BAD_USER_INPUT",
]);

// Fields shared by the search and detail queries. The recorded research
// samples only asked for `location { formattedName }` (a district such as
// "Pagedangan", with `city: null`). The place hierarchy below (`name`,
// `level`, `parents`: district -> city or regency -> province -> country)
// and `status` were confirmed by live searchJobsV3 and getJobById requests
// on 2026-11-17; the test fixtures are trimmed copies of those responses.
// A job whose hierarchy is missing still maps, marked city-unknown.
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

/**
 * Display location and evidence from Glints' place hierarchy. Without a
 * city (no hierarchy, as in the recorded samples, or one that stops above
 * city level) the place is shown as Glints names it and the evidence is
 * marked city-unknown, so a city filter keeps the job instead of dropping it.
 */
function buildLocation(
  row: UnknownRecord,
  workplaceType: LocationWorkplaceType | null,
) {
  const place = asRecord(row.location);
  // Levels: 1 country, 2 province, 3 city or regency, 4 district.
  const level = asNumber(place?.level);
  const district =
    level !== undefined && level >= 4 ? asString(place?.name) : undefined;
  const city = placeAtLevel(place, 3) ?? asString(asRecord(row.city)?.name);
  const built = buildIndonesianLocation({
    city,
    region: placeAtLevel(place, 2),
    country: INDONESIA_COUNTRY_NAME,
    workplaceType,
    source: GLINTS_SOURCE,
  });
  const named = city
    ? district
    : (district ?? asString(place?.formattedName) ?? asString(place?.name));
  const shown = built.location.toLowerCase().split(", ");
  const prefix =
    named && !shown.includes(named.toLowerCase()) ? `${named}, ` : "";
  return {
    location: `${prefix}${built.location}`,
    locationEvidence: {
      ...built.locationEvidence,
      location: `${prefix}${built.locationEvidence.location}`,
      ...(city ? {} : { cityUnknown: true }),
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
    jobType: type ? (JOB_TYPE_LABELS.get(type) ?? type) : undefined,
    experienceRange: formatRange(
      asNumber(row.minYearsOfExperience),
      asNumber(row.maxYearsOfExperience),
      "years",
    ),
    isRemote: workplaceType === "remote",
    workFromHomeType: workplaceType ?? undefined,
  };
}

/** True when Glints refused the search because of one of its variables. */
function isRejectedInput(error: unknown, payload: UnknownRecord | null) {
  if (error instanceof PoliteRequestError) {
    return error.kind === "status" && error.status === 400;
  }
  if (!Array.isArray(payload?.errors)) return false;
  return payload.errors.some((entry) => {
    const record = asRecord(entry);
    const code = asString(asRecord(record?.extensions)?.code);
    // The message is only inspected here, never reported.
    return (
      (code !== undefined && REJECTED_INPUT_CODES.has(code)) ||
      /workArrangement/i.test(asString(record?.message) ?? "")
    );
  });
}

/**
 * Searches Glints newest first with a per-run `deviceid` cookie (without it
 * Glints ignores the search term). Only the first page is served without
 * login, so each term makes one search request for the whole first page (50
 * jobs) and reports a note when that page was full. Glints' search also
 * returns unrelated titles, so titles must match the term (the posting's job
 * type counts as a level); cities are filtered here. A narrower workplace
 * choice goes to Glints' filter; if Glints rejects it, the term is retried
 * once without it and the choice is applied here for the rest of the run.
 * Each new job gets one detail request for its Draft.js description; a job
 * whose detail request fails is not imported, and one whose description
 * cannot be read is imported without it and reported as a source error.
 */
export async function runGlints(
  options: RunGlintsOptions = {},
): Promise<ExtractorRunResult> {
  const knownUrls = createKnownJobUrls(options.getExistingJobUrls);
  const requestOptions = {
    headers: { Cookie: `deviceid=${options.deviceId ?? randomUUID()}` },
  };
  const workplaceTypes = [...new Set(options.workplaceTypes ?? [])];
  const narrowWorkplace =
    workplaceTypes.length > 0 && workplaceTypes.length < 3;
  let sendWorkplaceFilter = narrowWorkplace;

  return runJobBoard({
    label: GLINTS_LABEL,
    options,
    maxPageSize: MAX_PAGE_SIZE,
    runTerm: async (context) => {
      const { candidates, consume } =
        createDetailCandidates<UnknownRecord>(context);

      const search = async (limit: number) => {
        const withFilter = sendWorkplaceFilter;
        let payload: UnknownRecord | null = null;
        let failure: unknown;
        try {
          payload = asRecord(
            await context.client.postJson(
              graphqlUrl("searchJobsV3"),
              buildGlintsSearchRequest({
                searchTerm: context.searchTerm,
                pageSize: limit,
                workplaceTypes: withFilter ? workplaceTypes : [],
              }),
              requestOptions,
            ),
          );
        } catch (error) {
          failure = error;
        }
        const result = asRecord(asRecord(payload?.data)?.searchJobsV3);
        if (Array.isArray(result?.jobsInPage)) return result;
        if (withFilter && isRejectedInput(failure, payload)) {
          sendWorkplaceFilter = false;
          context.reportNote(
            `${GLINTS_LABEL}: Glints rejected its work-arrangement filter, so job-ops now filters workplace types itself`,
          );
          return search(limit);
        }
        if (failure) throw failure;
        const code = graphqlErrorCode(payload);
        throw new Error(
          code
            ? `${GLINTS_LABEL} search returned GraphQL error ${code}`
            : `${GLINTS_LABEL} returned an invalid jobs response`,
        );
      };

      await collectPages(context, {
        toJob: (item) => mapGlintsJob(item),
        consume: (job, item) => {
          if (
            !isRelevantJobTitle(job.title, context.searchTerm, {
              levelHint: job.jobType,
            })
          ) {
            return "filtered";
          }
          if (
            narrowWorkplace &&
            !sendWorkplaceFilter &&
            job.workFromHomeType &&
            !(workplaceTypes as string[]).includes(job.workFromHomeType)
          ) {
            return "filtered";
          }
          return consume(job, item);
        },
        fetchPage: async ({ limit }) => {
          const result = await search(limit);
          const items = (result?.jobsInPage ?? []) as unknown[];
          if (items.length >= limit && result?.hasMore !== false) {
            context.reportNote(
              `${GLINTS_LABEL}: results were limited to the first page (${items.length} jobs), the most Glints serves without login`,
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
          // A closed job is dropped before its description is looked at.
          const mapped = mapGlintsJob(item, detail);
          if (!mapped) return null;
          let description: string | undefined;
          try {
            description =
              draftJsToHtml(asString(detail.descriptionJsonString) ?? "") ||
              undefined;
          } catch (error) {
            if (!(error instanceof DraftJsParseError)) throw error;
            unreadableDescriptions += 1;
          }
          return { ...mapped, jobDescription: description };
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
