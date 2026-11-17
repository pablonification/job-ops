import {
  acceptWithDetails,
  asHttpUrl,
  asIdentifier,
  asNumber,
  asRecord,
  asString,
  asStringList,
  buildIndonesianLocation,
  createDetailCandidates,
  createKnownJobUrls,
  INDONESIA_COUNTRY_NAME,
  indonesianSearchCity,
  isRelevantJobTitle,
  type JobBoardRunOptions,
  joinList,
  runJobBoard,
  type UnknownRecord,
} from "@shared/extractors/indonesia/index.js";
import type { LocationWorkplaceType } from "@shared/location-domain.js";
import type { ExtractorRunResult } from "@shared/types/extractors";
import type { CreateJobInput } from "@shared/types/jobs";
import { parseJobStreetSalary } from "./salary";

export const JOBSTREET_SOURCE = "jobstreet";
export const JOBSTREET_LABEL = "JobStreet";
const JOBSTREET_ORIGIN = "https://id.jobstreet.com";
const JOBSTREET_SEARCH_URL = `${JOBSTREET_ORIGIN}/api/jobsearch/v5/search`;
const JOBSTREET_GRAPHQL_URL = `${JOBSTREET_ORIGIN}/graphql`;
const MAX_PAGE_SIZE = 20;
/** Required by the detail GraphQL endpoint. */
const DETAIL_HEADERS = {
  "seek-request-brand": "jobstreet",
  "seek-request-country": "ID",
};

/** JobStreet's `workarrangement` codes (1 office, 2 hybrid, 3 remote). */
const WORK_ARRANGEMENT_CODES: Record<LocationWorkplaceType, string> = {
  onsite: "1",
  hybrid: "2",
  remote: "3",
};
const WORKPLACE_TYPE_BY_CODE = new Map<string, LocationWorkplaceType>(
  Object.entries(WORK_ARRANGEMENT_CODES).map(
    ([type, code]) => [code, type as LocationWorkplaceType] as const,
  ),
);

// The detail query as the site sends it. The server rejects variables the
// query does not use, so the two lists must stay in step.
const DETAIL_QUERY =
  'query jobDetails($jobId: ID!, $jobDetailsViewedCorrelationId: String!, $sessionId: String!, $zone: Zone!, $locale: Locale!, $languageCode: LanguageCodeIso!) { jobDetails(id: $jobId, tracking: {channel: "WEB", jobDetailsViewedCorrelationId: $jobDetailsViewedCorrelationId, sessionId: $sessionId}) { job { id title isExpired content(platform: WEB) abstract salary { label currencyLabel(zone: $zone) } workTypes { label(locale: $locale) } listedAt { dateTimeUtc } location { label(locale: $locale, type: LONG) } advertiser { id name(locale: $locale) } classifications { label(languageCode: $languageCode) } shareLink(platform: WEB, zone: $zone, locale: $locale) } } }';
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export interface RunJobStreetOptions extends JobBoardRunOptions {
  /** Already-imported job URLs; their detail requests are skipped. */
  getExistingJobUrls?: () => Promise<string[]>;
  /** Narrower than "any" workplace choice, sent as JobStreet's work-arrangement filter. */
  workplaceTypes?: readonly LocationWorkplaceType[];
}

/** JobStreet serves `/job/<id>` without a title slug or tracking parameters. */
export function buildJobStreetJobUrl(id: string): string {
  return `${JOBSTREET_ORIGIN}/job/${encodeURIComponent(id)}`;
}

export function buildJobStreetSearchUrl(args: {
  searchTerm: string;
  page: number;
  pageSize: number;
  /** City for JobStreet's location filter, e.g. "Jakarta". */
  where?: string;
  workplaceTypes?: readonly LocationWorkplaceType[];
}): URL {
  const url = new URL(JOBSTREET_SEARCH_URL);
  url.searchParams.set("siteKey", "ID-Main");
  url.searchParams.set("sourcesystem", "houston");
  url.searchParams.set("keywords", args.searchTerm);
  if (args.where) url.searchParams.set("where", args.where);
  url.searchParams.set("page", String(Math.max(1, Math.floor(args.page))));
  url.searchParams.set(
    "pageSize",
    String(Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(args.pageSize)))),
  );
  url.searchParams.set("sortmode", "ListedDate");
  const codes = [...new Set(args.workplaceTypes ?? [])]
    .map((type) => WORK_ARRANGEMENT_CODES[type])
    .filter(Boolean)
    .sort();
  if (codes.length > 0 && codes.length < 3) {
    url.searchParams.set("workarrangement", codes.join(","));
  }
  url.searchParams.set("locale", "en-ID");
  return url;
}

/** The `jobDetails` GraphQL request body for one job. */
export function buildJobStreetDetailRequest(jobId: string) {
  return {
    operationName: "jobDetails",
    variables: {
      jobId,
      jobDetailsViewedCorrelationId: NIL_UUID,
      sessionId: NIL_UUID,
      zone: "asia-4",
      locale: "id-ID",
      languageCode: "id",
    },
    query: DETAIL_QUERY,
  };
}

function toWorkplaceType(row: UnknownRecord): LocationWorkplaceType | null {
  const arrangements = asRecord(row.workArrangements)?.data;
  if (!Array.isArray(arrangements)) return null;
  for (const arrangement of arrangements) {
    const type = WORKPLACE_TYPE_BY_CODE.get(
      asIdentifier(asRecord(arrangement)?.id) ?? "",
    );
    if (type) return type;
  }
  return null;
}

/** Drops the empty paragraphs JobStreet leaves at the end of descriptions. */
function cleanContent(value: unknown): string | undefined {
  return asString(
    asString(value)?.replace(/(?:<p>\s*(?:<br\s*\/?>)?\s*<\/p>\s*)+$/i, ""),
  );
}

/**
 * Maps a JobStreet search result, optionally enriched by its `jobDetails`
 * record (which carries the full description). Results outside Indonesia
 * are skipped.
 */
export function mapJobStreetJob(
  listValue: unknown,
  detailValue?: unknown,
): CreateJobInput | null {
  const row = asRecord(listValue);
  if (!row) return null;
  const detail = asRecord(detailValue);
  const id = asIdentifier(row.id);
  const title = asString(row.title) ?? asString(detail?.title);
  const employer =
    asString(row.companyName) ??
    asString(asRecord(row.advertiser)?.description) ??
    asString(asRecord(row.employer)?.name) ??
    asString(asRecord(detail?.advertiser)?.name);
  if (!id || !title || !employer) return null;

  const place = Array.isArray(row.locations)
    ? asRecord(row.locations[0])
    : null;
  const countryCode = asString(place?.countryCode);
  if (countryCode && countryCode.toUpperCase() !== "ID") return null;
  const [city, region] = (asString(place?.label) ?? "")
    .split(",")
    .map((part) => part.trim());
  const workplaceType = toWorkplaceType(row);
  const { location, locationEvidence } = buildIndonesianLocation({
    city,
    region,
    country: INDONESIA_COUNTRY_NAME,
    workplaceType,
    source: JOBSTREET_SOURCE,
  });

  const classification = Array.isArray(row.classifications)
    ? asRecord(row.classifications[0])
    : null;
  const jobUrl = buildJobStreetJobUrl(id);

  return {
    source: JOBSTREET_SOURCE,
    sourceJobId: id,
    title,
    employer,
    jobUrl,
    applicationLink: jobUrl,
    location,
    locationEvidence,
    jobDescription: cleanContent(detail?.content),
    datePosted:
      asString(row.listingDate) ??
      asString(asRecord(detail?.listedAt)?.dateTimeUtc),
    ...parseJobStreetSalary(
      asString(row.salaryLabel) ?? asString(asRecord(detail?.salary)?.label),
    ),
    jobType: joinList(asStringList(row.workTypes)),
    jobFunction: asString(
      asRecord(classification?.subclassification)?.description,
    ),
    isRemote: workplaceType === "remote",
    workFromHomeType: workplaceType ?? undefined,
    companyLogo: asHttpUrl(asRecord(row.branding)?.serpLogoUrl),
  };
}

/** Search results not yet looked at for one `where` value. */
interface CityCursor {
  where: string | undefined;
  /** Last page fetched (1-based). */
  page: number;
  buffer: unknown[];
  /** Results of the current page that were new to this run. */
  newInPage: number;
  exhausted: boolean;
}

/**
 * Searches JobStreet Indonesia newest first. Requested cities go to its
 * location filter as their base city ("Jakarta Selatan" -> "Jakarta"); the
 * shared runner then keeps only jobs in the requested place. With several
 * cities the term's cap and scan bound are split between them, and a city
 * that runs out of results hands its unused share to the others. Sorting by
 * date makes the keyword match loose, so titles must match the term (the
 * posting's work type counts as a level). The search results only carry a
 * teaser, so each new job gets one detail request; job URLs already in
 * job-ops skip it, and a job whose detail request fails is not imported, so
 * the next run fetches it again.
 */
export async function runJobStreet(
  options: RunJobStreetOptions = {},
): Promise<ExtractorRunResult> {
  const knownUrls = createKnownJobUrls(options.getExistingJobUrls);

  return runJobBoard({
    label: JOBSTREET_LABEL,
    options,
    maxPageSize: MAX_PAGE_SIZE,
    runTerm: async (context) => {
      const { candidates, consume } =
        createDetailCandidates<UnknownRecord>(context);
      const cursors: CityCursor[] = (
        context.cities.length
          ? [...new Set(context.cities.map(indonesianSearchCity))]
          : [undefined]
      ).map((where) => ({
        where,
        page: 0,
        buffer: [],
        newInPage: 0,
        exhausted: false,
      }));
      let added = 0;
      let scanned = 0;

      const fetchNextPage = async (cursor: CityCursor) => {
        cursor.page += 1;
        const payload = asRecord(
          await context.client.getJson(
            buildJobStreetSearchUrl({
              searchTerm: context.searchTerm,
              page: cursor.page,
              pageSize: context.pageSize,
              where: cursor.where,
              workplaceTypes: options.workplaceTypes,
            }),
          ),
        );
        if (!Array.isArray(payload?.data)) {
          throw new Error(
            `${JOBSTREET_LABEL} returned an invalid jobs response`,
          );
        }
        // A recognised place comes back as `location`; an unknown one gets no
        // `location` and no jobs, which must not pass for "no jobs there".
        if (
          cursor.where &&
          payload.data.length === 0 &&
          !asRecord(payload.location)
        ) {
          context.reportNote(
            `${JOBSTREET_LABEL}: the location "${cursor.where}" was not recognised, so no jobs were searched there`,
          );
          cursor.exhausted = true;
          return;
        }
        const total = asNumber(payload.totalCount);
        cursor.buffer = [...payload.data];
        cursor.newInPage = 0;
        cursor.exhausted =
          payload.data.length === 0 ||
          (total !== undefined && cursor.page * context.pageSize >= total);
      };

      /** Scans one city until its shares, or the term's totals, are used. */
      const scanCity = async (
        cursor: CityCursor,
        jobShare: number,
        scanShare: number,
      ) => {
        let cityAdded = 0;
        let cityScanned = 0;
        while (
          cityAdded < jobShare &&
          cityScanned < scanShare &&
          added < context.maxJobs &&
          scanned < context.maxScanned &&
          !context.shouldStop()
        ) {
          if (cursor.buffer.length === 0) {
            if (cursor.exhausted) break;
            await fetchNextPage(cursor);
            continue;
          }
          const item = cursor.buffer.shift();
          cityScanned += 1;
          scanned += 1;
          const job = mapJobStreetJob(item);
          const result =
            job &&
            isRelevantJobTitle(job.title, context.searchTerm, {
              levelHint: job.jobType,
            })
              ? consume(job, item)
              : "filtered";
          if (result !== "duplicate") cursor.newInPage += 1;
          if (result === "added") {
            cityAdded += 1;
            added += 1;
          }
          // A page holding only jobs earlier terms took ends this city.
          if (cursor.buffer.length === 0 && cursor.newInPage === 0) {
            cursor.exhausted = true;
          }
        }
        return cityScanned;
      };

      let active = cursors;
      while (active.length > 0) {
        const jobsLeft = context.maxJobs - added;
        const scanLeft = context.maxScanned - scanned;
        if (jobsLeft <= 0 || scanLeft <= 0 || context.shouldStop()) break;
        const jobShare = Math.ceil(jobsLeft / active.length);
        const scanShare = Math.ceil(scanLeft / active.length);
        let progress = 0;
        for (const cursor of active) {
          progress += await scanCity(cursor, jobShare, scanShare);
        }
        // A city is done once it has no more pages and no results left over.
        active = active.filter(
          (cursor) => !cursor.exhausted || cursor.buffer.length > 0,
        );
        if (progress === 0) break;
      }

      await acceptWithDetails(context, candidates, {
        label: JOBSTREET_LABEL,
        knownUrls,
        fetchDetail: async ({ job, item }) => {
          const payload = asRecord(
            await context.client.postJson(
              JOBSTREET_GRAPHQL_URL,
              buildJobStreetDetailRequest(job.sourceJobId ?? ""),
              { headers: DETAIL_HEADERS },
            ),
          );
          const detail = asRecord(
            asRecord(asRecord(payload?.data)?.jobDetails)?.job,
          );
          if (!detail || !cleanContent(detail.content)) {
            throw new Error(
              `${JOBSTREET_LABEL} returned an invalid job detail`,
            );
          }
          if (detail.isExpired === true) return null;
          return mapJobStreetJob(item, detail);
        },
      });
    },
  });
}
