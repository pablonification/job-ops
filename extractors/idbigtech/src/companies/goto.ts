import {
  asHttpUrl,
  asIdentifier,
  asRecord,
  asString,
  asStringList,
  toWorkplaceType,
  type UnknownRecord,
} from "@shared/extractors/indonesia/index.js";
import { companyLocation, epochMsToIso } from "../location";
import { type CompanyFetcher, ID_BIG_TECH_SOURCE } from "../types";

const LABEL = "GoTo";
// The Lever site name is case-sensitive.
const POSTINGS_URL = "https://api.lever.co/v0/postings/GoToGroup";
const JOB_URL = "https://jobs.lever.co/GoToGroup/";

function cleanHtml(value: unknown): string | undefined {
  return asString(asString(value)?.replace(/&nbsp;/gi, " "));
}

function descriptionOf(item: UnknownRecord): string | undefined {
  const lists = Array.isArray(item.lists)
    ? item.lists
        .map((entry) => {
          const list = asRecord(entry);
          const content = cleanHtml(list?.content);
          if (!content) return undefined;
          const heading = asString(list?.text);
          return `${heading ? `<h3>${heading}</h3>\n` : ""}<ul>${content}</ul>`;
        })
        .filter((part): part is string => Boolean(part))
    : [];
  const parts = [
    cleanHtml(item.description),
    ...lists,
    cleanHtml(item.additional),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join("\n") : undefined;
}

export function buildGoToPostingsUrl(args: {
  offset: number;
  limit: number;
}): URL {
  const url = new URL(POSTINGS_URL);
  url.searchParams.set("mode", "json");
  url.searchParams.set("skip", String(args.offset));
  url.searchParams.set("limit", String(args.limit));
  return url;
}

/**
 * GoTo's public Lever board (a part of GoTo's openings: Gojek tech roles on
 * gojek.io are not reachable). Lever has no keyword search, so the board is
 * listed once per run and filtered by title for each term. Descriptions come
 * with the list.
 */
export const gotoFetcher: CompanyFetcher = {
  id: "goto",
  label: LABEL,
  listing: "board",
  pageSize: 100,
  maxPages: 5,
  async fetchPage({ client }, { offset, limit }) {
    const items = await client.getJson(buildGoToPostingsUrl({ offset, limit }));
    if (!Array.isArray(items)) {
      throw new Error(`${LABEL} returned an invalid jobs response`);
    }
    return { items, hasMore: items.length >= limit };
  },
  toPosting(value, { cities }) {
    const item = asRecord(value);
    const id = asIdentifier(item?.id);
    const title = asString(item?.text);
    if (!item || !id || !title) return null;
    if (asString(item.country)?.toUpperCase() !== "ID") return null;

    const categories = asRecord(item.categories);
    const workplaceType = toWorkplaceType(item.workplaceType);
    const hostedUrl = asHttpUrl(item.hostedUrl);
    const jobUrl = hostedUrl?.startsWith(JOB_URL)
      ? hostedUrl
      : `${JOB_URL}${encodeURIComponent(id)}`;
    return {
      item,
      job: {
        source: ID_BIG_TECH_SOURCE,
        sourceJobId: id,
        title,
        employer: LABEL,
        jobUrl,
        applicationLink: asHttpUrl(item.applyUrl) ?? jobUrl,
        ...companyLocation({
          cities: [
            ...asStringList(categories?.allLocations),
            asString(categories?.location),
          ],
          requestedCities: cities,
          workplaceType,
        }),
        jobDescription: descriptionOf(item),
        datePosted: epochMsToIso(item.createdAt),
        jobType: asString(categories?.commitment),
        jobFunction: asString(categories?.department),
      },
    };
  },
};
