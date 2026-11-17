import {
  asIdentifier,
  asNumber,
  asRecord,
  asString,
  buildSalaryFields,
  type UnknownRecord,
} from "@shared/extractors/indonesia/index.js";
import { companyLocation, servesRequestedCities } from "../location";
import { type CompanyFetcher, ID_BIG_TECH_SOURCE } from "../types";

const LABEL = "TikTok";
const SEARCH_URL =
  "https://api.lifeattiktok.com/api/v1/public/supplier/search/job/posts";
const JOB_URL = "https://lifeattiktok.com/search/";
/** TikTok's location code for Jakarta, its only Indonesian office in the API. */
const JAKARTA_LOCATION_CODE = "CT_169";
const INDONESIA_LOCATION_CODE = "CN_26";
const SERVICE_CITIES = ["Jakarta"];
/** The opening paragraph that says which business a role belongs to. */
const TEAM_INTRO_LENGTH = 400;

function nameOf(value: UnknownRecord | null): string | undefined {
  return asString(value?.en_name) ?? asString(value?.i18n_name);
}

/** Walks `city_info -> parent -> parent` and returns each level by type. */
function locationLevels(cityInfo: UnknownRecord | null) {
  const levels: { country?: UnknownRecord; region?: UnknownRecord } = {};
  let node = asRecord(cityInfo?.parent);
  for (let depth = 0; node && depth < 5; depth += 1) {
    const type = asNumber(node.location_type);
    if (type === 1) levels.country = node;
    if (type === 2) levels.region = node;
    node = asRecord(node.parent);
  }
  return levels;
}

/**
 * TikTok's careers API also lists Tokopedia (TikTok Shop by Tokopedia) roles.
 * The title names Tokopedia for most of them; otherwise the team introduction
 * at the top of the description does.
 */
export function tiktokEmployer(title: string, description?: string): string {
  if (/tokopedia/i.test(title)) return "Tokopedia";
  const intro = description?.slice(0, TEAM_INTRO_LENGTH) ?? "";
  return /tokopedia/i.test(intro) && !/tiktok/i.test(intro)
    ? "Tokopedia"
    : "TikTok";
}

export function buildTikTokSearchBody(args: {
  searchTerm: string;
  offset: number;
  limit: number;
}) {
  return {
    keyword: args.searchTerm,
    location_code_list: [JAKARTA_LOCATION_CODE],
    limit: args.limit,
    offset: args.offset,
    recruitment_id_list: [],
    job_category_id_list: [],
    subject_id_list: [],
  };
}

/**
 * TikTok and Tokopedia jobs from TikTok's careers API, searched by keyword in
 * Jakarta. Descriptions come with the list; the API gives no posting date.
 */
export const tiktokFetcher: CompanyFetcher = {
  id: "tiktok",
  label: LABEL,
  listing: "search",
  pageSize: 20,
  maxPages: 5,
  async fetchPage({ client, cities }, { searchTerm, offset, limit }) {
    if (!servesRequestedCities(SERVICE_CITIES, cities)) {
      return { items: [], hasMore: false };
    }
    const payload = asRecord(
      await client.postJson(
        SEARCH_URL,
        buildTikTokSearchBody({ searchTerm, offset, limit }),
        { headers: { "website-path": "tiktok" } },
      ),
    );
    const data = asRecord(payload?.data);
    if (asNumber(payload?.code) !== 0 || !Array.isArray(data?.job_post_list)) {
      throw new Error(`${LABEL} returned an invalid jobs response`);
    }
    const total = asNumber(data.count) ?? 0;
    return {
      items: data.job_post_list,
      hasMore: offset + data.job_post_list.length < total,
    };
  },
  toPosting(value, { cities }) {
    const item = asRecord(value);
    const id = asIdentifier(item?.id);
    const title = asString(item?.title);
    if (!item || !id || !title) return null;

    const cityInfo = asRecord(item.city_info);
    const { country, region } = locationLevels(cityInfo);
    const countryName = nameOf(country ?? null);
    if (
      asString(country?.code) !== INDONESIA_LOCATION_CODE &&
      countryName?.toLowerCase() !== "indonesia"
    ) {
      return null;
    }

    const description = asString(item.description);
    const requirement = asString(item.requirement);
    const postInfo = asRecord(item.job_post_info);
    const category = asRecord(item.job_category);
    const jobUrl = `${JOB_URL}${encodeURIComponent(id)}`;
    return {
      item,
      job: {
        source: ID_BIG_TECH_SOURCE,
        sourceJobId: id,
        title,
        employer: tiktokEmployer(title, description),
        jobUrl,
        applicationLink: jobUrl,
        ...companyLocation({
          cities: [nameOf(cityInfo)],
          requestedCities: cities,
          region: nameOf(region ?? null),
        }),
        jobDescription:
          [description, requirement].filter(Boolean).join("\n\n") || undefined,
        jobType: nameOf(asRecord(item.recruit_type)),
        jobFunction: nameOf(category),
        ...buildSalaryFields({
          min: postInfo?.min_salary,
          max: postInfo?.max_salary,
          currency: asString(postInfo?.currency),
        }),
      },
    };
  },
};
