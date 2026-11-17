import {
  asHttpUrl,
  asIdentifier,
  asRecord,
  asString,
  namesOf,
} from "@shared/extractors/indonesia/index.js";
import { unescapeHtmlDescription } from "../html";
import { companyLocation, isIndonesia, parsePlaceText } from "../location";
import { type CompanyFetcher, ID_BIG_TECH_SOURCE } from "../types";

const LABEL = "Xendit";
const BOARD_URL =
  "https://boards-api.greenhouse.io/v1/boards/xendit/jobs?content=true";
const JOB_URL = "https://job-boards.greenhouse.io/xendit/jobs/";

/**
 * "Bali, Indonesia; Bangkok, Thailand; Jakarta, Indonesia" -> the Indonesian
 * cities, whether any part is in Indonesia, and whether it is remote there.
 */
export function parseXenditLocation(value: string | undefined): {
  inIndonesia: boolean;
  cities: string[];
  remote: boolean;
} {
  const indonesian = (value ?? "")
    .split(";")
    .map((part) => ({ part, place: parsePlaceText(part) }))
    .filter(({ place }) => isIndonesia(place.country));
  return {
    inIndonesia: indonesian.length > 0,
    cities: indonesian
      .map(({ place }) => place.city?.replace(/^remote\s*[-–]?\s*/i, ""))
      .filter((city): city is string => Boolean(city)),
    remote: indonesian.some(({ part }) => /\bremote\b/i.test(part)),
  };
}

/**
 * Xendit's Greenhouse board returns every opening with its description in one
 * request, so it is listed once per run and filtered by title and location.
 */
export const xenditFetcher: CompanyFetcher = {
  id: "xendit",
  label: LABEL,
  listing: "board",
  pageSize: 500,
  maxPages: 1,
  async fetchPage({ client }) {
    const payload = asRecord(await client.getJson(BOARD_URL));
    if (!Array.isArray(payload?.jobs)) {
      throw new Error(`${LABEL} returned an invalid jobs response`);
    }
    return { items: payload.jobs, hasMore: false };
  },
  toPosting(value, { cities }) {
    const item = asRecord(value);
    const id = asIdentifier(item?.id);
    const title = asString(item?.title);
    if (!item || !id || !title) return null;
    let location = parseXenditLocation(asString(asRecord(item.location)?.name));
    if (!location.inIndonesia) {
      // Fall back to the posting's offices when its location text says nothing.
      if (namesOf(item.offices).some((name) => /\bindonesia\b/i.test(name))) {
        location = { inIndonesia: true, cities: [], remote: false };
      } else {
        return null;
      }
    }

    const content = asString(item.content);
    const absoluteUrl = asHttpUrl(item.absolute_url);
    const jobUrl = absoluteUrl?.startsWith(JOB_URL)
      ? absoluteUrl
      : `${JOB_URL}${encodeURIComponent(id)}`;
    return {
      item,
      job: {
        source: ID_BIG_TECH_SOURCE,
        sourceJobId: id,
        title,
        employer: LABEL,
        jobUrl,
        applicationLink: jobUrl,
        ...companyLocation({
          cities: location.cities,
          requestedCities: cities,
          workplaceType: location.remote ? "remote" : null,
        }),
        jobDescription: content ? unescapeHtmlDescription(content) : undefined,
        datePosted: asString(item.first_published) ?? asString(item.updated_at),
        jobFunction: namesOf(item.departments)[0],
      },
    };
  },
};
