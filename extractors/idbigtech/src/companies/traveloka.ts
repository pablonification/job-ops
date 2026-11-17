import {
  asHttpUrl,
  asNumber,
  asRecord,
  asString,
} from "@shared/extractors/indonesia/index.js";
import { hrefOfLinkContaining, innerHtmlOfNext } from "../html";
import {
  companyLocation,
  epochMsToIso,
  isIndonesia,
  parsePlaceText,
} from "../location";
import { type CompanyFetcher, ID_BIG_TECH_SOURCE } from "../types";

const LABEL = "Traveloka";
const ORIGIN = "https://careers.traveloka.com";
const SEARCH_URL = `${ORIGIN}/api/career/jobs/search`;
const DESCRIPTION_HEADING = /<h1\b[^<>]*>\s*Job Description\s*<\/h1>/i;

export function buildTravelokaSearchUrl(page: number): URL {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("intf", "desktop");
  url.searchParams.set("keyword", "");
  url.searchParams.set("page", String(page));
  url.searchParams.set("department", "");
  url.searchParams.set("type", "");
  return url;
}

/** Description HTML and apply link from a Traveloka job page. */
export function parseTravelokaJobPage(html: string): {
  description?: string;
  applyUrl?: string;
} {
  const heading = DESCRIPTION_HEADING.exec(html);
  const description = heading
    ? asString(innerHtmlOfNext(html, "span", heading.index + heading[0].length))
    : undefined;
  return {
    description,
    applyUrl: asHttpUrl(hrefOfLinkContaining(html, "Apply Now")),
  };
}

function jobUrlOf(item: Record<string, unknown>, id: string): string {
  const link = asString(item.link);
  return link?.startsWith("/jobs/")
    ? `${ORIGIN}${link}`
    : `${ORIGIN}/jobs/${encodeURIComponent(id)}`;
}

/**
 * Traveloka's careers API has a keyword parameter of unknown behaviour and no
 * working location filter, so the whole board is listed once per run and
 * filtered by title and country here. The description is only on the job's
 * HTML page.
 */
export const travelokaFetcher: CompanyFetcher = {
  id: "traveloka",
  label: LABEL,
  listing: "board",
  pageSize: 30,
  maxPages: 8,
  async fetchPage({ client }, { number }) {
    const data = asRecord(
      asRecord(await client.getJson(buildTravelokaSearchUrl(number)))?.data,
    );
    if (!Array.isArray(data?.jobs)) {
      throw new Error(`${LABEL} returned an invalid jobs response`);
    }
    const lastPage = asNumber(data.lastPage) ?? number;
    return { items: data.jobs, hasMore: number < lastPage };
  },
  toPosting(value, { cities }) {
    const item = asRecord(value);
    const id = asString(item?.requisitionId);
    const title = asString(item?.title);
    if (!item || !id || !title) return null;
    // "BSD City, Indonesia": city first, country last.
    const place = parsePlaceText(asString(item.location));
    if (!isIndonesia(place.country)) return null;

    const jobUrl = jobUrlOf(item, id);
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
          cities: [place.city],
          requestedCities: cities,
        }),
        datePosted: epochMsToIso(item.createdAt),
        jobType: asString(item.employmentType),
        jobFunction: asString(item.department),
      },
    };
  },
  async fetchDetail({ client }, { job }) {
    const page = parseTravelokaJobPage(await client.getText(job.jobUrl));
    if (!page.description) {
      throw new Error(`${LABEL} job page had no description`);
    }
    return {
      ...job,
      jobDescription: page.description,
      applicationLink: page.applyUrl ?? job.applicationLink,
    };
  },
};
