import {
  asIdentifier,
  asNumber,
  asRecord,
  asString,
  matchesIndonesianPlace,
} from "@shared/extractors/indonesia/index.js";
import { htmlToPlainText } from "../html";
import { companyLocation } from "../location";
import { type CompanyFetcher, ID_BIG_TECH_SOURCE } from "../types";

const LABEL = "Shopee";
const SEARCH_URL = "https://ats.workatsea.com/ats/api/v1/user/job/list/";
// The careers site's job pages are /job-detail/<job_id>/1 (list results all
// come from source 1); search engines index them in this form.
const JOB_URL = "https://careers.shopee.co.id/job-detail/";
const INDONESIA_REGION_ID = 7;
/** Sea's city ids in its Indonesia region (from `/user/city/job_count/`). */
export const SHOPEE_INDONESIA_CITY_IDS: Readonly<Record<number, string>> = {
  8: "Bandung",
  9: "Bekasi",
  10: "Jakarta",
  11: "Medan",
  12: "Surakarta",
  13: "Yogyakarta",
};

/** Sea's careers site marks entity 2 as Monee (SeaMoney) in its own code. */
const MONEE_ENTITY_ID = 2;
/** Entity 5 postings are SPX Express (Shopee's logistics arm) roles. */
const SPX_ENTITY_ID = 5;

/**
 * The business a posting belongs to: Shopee, or the Sea businesses that hire
 * through the same system under their own names.
 */
export function shopeeEmployer(title: string, entityId?: number): string {
  if (entityId === MONEE_ENTITY_ID) return "Monee";
  if (entityId === SPX_ENTITY_ID || /\bspx\b/i.test(title)) {
    return "SPX Express";
  }
  return LABEL;
}

/** City ids to search: all Indonesian ones, or those inside requested cities. */
export function shopeeCityIds(cities: readonly string[]): number[] {
  return Object.entries(SHOPEE_INDONESIA_CITY_IDS)
    .filter(
      ([, name]) =>
        cities.length === 0 ||
        cities.some((requested) => matchesIndonesianPlace(name, requested)),
    )
    .map(([id]) => Number(id));
}

export function buildShopeeSearchUrl(args: {
  searchTerm: string;
  offset: number;
  limit: number;
  cityIds: readonly number[];
}): URL {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("limit", String(args.limit));
  url.searchParams.set("offset", String(args.offset));
  url.searchParams.set("search_content", args.searchTerm);
  for (const cityId of args.cityIds) {
    url.searchParams.append("city_ids", String(cityId));
  }
  return url;
}

function section(heading: string, value: unknown): string | undefined {
  const html = asString(value);
  if (!html) return undefined;
  const text = htmlToPlainText(html);
  if (!text || text === "-") return undefined;
  return `<h3>${heading}</h3>\n${html}`;
}

/**
 * Shopee jobs from Sea's shared ATS, searched by keyword in Shopee's
 * Indonesian cities. Descriptions come with the list; the API gives no
 * posting date.
 */
export const shopeeFetcher: CompanyFetcher = {
  id: "shopee",
  label: LABEL,
  listing: "search",
  pageSize: 20,
  maxPages: 5,
  async fetchPage({ client, cities }, { searchTerm, offset, limit }) {
    const cityIds = shopeeCityIds(cities);
    if (cityIds.length === 0) return { items: [], hasMore: false };
    const payload = asRecord(
      await client.getJson(
        buildShopeeSearchUrl({ searchTerm, offset, limit, cityIds }),
      ),
    );
    const data = asRecord(payload?.data);
    if (asNumber(payload?.code) !== 0 || !Array.isArray(data?.job_list)) {
      throw new Error(`${LABEL} returned an invalid jobs response`);
    }
    const total = asNumber(data.total_count) ?? 0;
    return {
      items: data.job_list,
      hasMore: offset + data.job_list.length < total,
    };
  },
  toPosting(value, { cities }) {
    const item = asRecord(value);
    const jobId = asIdentifier(item?.job_id);
    const title = asString(item?.job_name);
    if (!item || !jobId || !title) return null;
    const cityName = SHOPEE_INDONESIA_CITY_IDS[asNumber(item.city_id) ?? -1];
    if (asNumber(item.region_id) !== INDONESIA_REGION_ID && !cityName) {
      return null;
    }

    const description = [
      asString(item.job_description),
      section("Requirements", item.requirements),
      section("About the team", item.sub_team_description),
    ].filter((part): part is string => Boolean(part));
    const jobUrl = `${JOB_URL}${encodeURIComponent(jobId)}/1`;
    return {
      item,
      job: {
        source: ID_BIG_TECH_SOURCE,
        sourceJobId: jobId,
        title,
        employer: shopeeEmployer(title, asNumber(item.external_entity_id)),
        jobUrl,
        applicationLink: jobUrl,
        ...companyLocation({ cities: [cityName], requestedCities: cities }),
        jobDescription:
          description.length > 0 ? description.join("\n") : undefined,
      },
    };
  },
};
