import {
  asRecord,
  asString,
  asStringList,
} from "@shared/extractors/indonesia/index.js";
import { companyLocation, isIndonesia, parsePlaceText } from "../location";
import { type CompanyFetcher, ID_BIG_TECH_SOURCE } from "../types";

const LABEL = "tiket.com";
const SITE_URL = "https://tiketdotcom.wd3.myworkdayjobs.com/Tiket_Careers";
const API_URL =
  "https://tiketdotcom.wd3.myworkdayjobs.com/wday/cxs/tiketdotcom/Tiket_Careers";
/** Workday facet id for "Location Country: Indonesia" on tiket.com's site. */
const INDONESIA_FACET_ID = "b31234dbcdda4da9ba8fa073c5944e36";

export function buildTiketSearchBody(args: {
  searchTerm: string;
  offset: number;
  limit: number;
}) {
  return {
    appliedFacets: { locationCountry: [INDONESIA_FACET_ID] },
    limit: args.limit,
    offset: args.offset,
    searchText: args.searchTerm,
  };
}

/**
 * "Jakarta, Indonesia" -> Jakarta. "2 Locations" or "Headquarters" name no
 * country; the search is restricted to Indonesia, so those stay in with an
 * unknown city until the detail says where.
 */
function parseLocationsText(value: string | undefined): {
  inIndonesia: boolean;
  city?: string;
} {
  const place = parsePlaceText(value);
  if (!place.country) return { inIndonesia: true };
  return isIndonesia(place.country)
    ? { inIndonesia: true, city: place.city }
    : { inIndonesia: false };
}

/**
 * tiket.com's Workday site, searched by keyword with Workday's country facet
 * set to Indonesia. The list shows only a relative date ("Posted 3 Days
 * Ago"); the detail request adds the description and start date.
 */
export const tiketFetcher: CompanyFetcher = {
  id: "tiket",
  label: LABEL,
  listing: "search",
  // Workday serves at most 20 results per request.
  pageSize: 20,
  maxPages: 5,
  async fetchPage({ client }, { searchTerm, offset, limit }) {
    const payload = asRecord(
      await client.postJson(
        `${API_URL}/jobs`,
        buildTiketSearchBody({ searchTerm, offset, limit }),
      ),
    );
    if (!Array.isArray(payload?.jobPostings)) {
      throw new Error(`${LABEL} returned an invalid jobs response`);
    }
    // Workday only reports `total` on the first page, so page until a short one.
    return {
      items: payload.jobPostings,
      hasMore: payload.jobPostings.length >= limit,
    };
  },
  toPosting(value, { cities }) {
    const item = asRecord(value);
    const path = asString(item?.externalPath);
    const title = asString(item?.title);
    if (!item || !path?.startsWith("/job/") || !title) return null;
    const location = parseLocationsText(asString(item.locationsText));
    if (!location.inIndonesia) return null;

    const jobUrl = `${SITE_URL}${path}`;
    return {
      item,
      job: {
        source: ID_BIG_TECH_SOURCE,
        sourceJobId: asStringList(item.bulletFields)[0] ?? path,
        title,
        employer: LABEL,
        jobUrl,
        applicationLink: jobUrl,
        ...companyLocation({
          cities: [location.city],
          requestedCities: cities,
        }),
      },
    };
  },
  async fetchDetail({ client, cities }, { job, item }) {
    const path = asString(asRecord(item)?.externalPath);
    if (!path) return null;
    const payload = asRecord(await client.getJson(`${API_URL}${path}`));
    const info = asRecord(payload?.jobPostingInfo);
    if (!info) throw new Error(`${LABEL} returned an invalid job detail`);
    if (info.posted === false || info.canApply === false) return null;
    const country = asRecord(info.country);
    const countryName = asString(country?.descriptor);
    if (countryName && countryName.toLowerCase() !== "indonesia") return null;

    // The detail names the primary location and any others.
    const detailCities = [
      asString(info.location),
      ...asStringList(info.additionalLocations),
    ]
      .map(parseLocationsText)
      .filter((place) => place.inIndonesia && place.city)
      .map((place) => place.city);
    return {
      ...job,
      ...(detailCities.length > 0
        ? companyLocation({ cities: detailCities, requestedCities: cities })
        : {}),
      jobDescription: asString(info.jobDescription),
      datePosted: asString(info.startDate),
      jobType: asString(info.timeType),
      sourceJobId: asString(info.jobReqId) ?? job.sourceJobId,
    };
  },
};
