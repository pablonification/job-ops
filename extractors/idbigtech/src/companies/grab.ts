import {
  asHttpUrl,
  asIdentifier,
  asNumber,
  asRecord,
  asString,
  type UnknownRecord,
} from "@shared/extractors/indonesia/index.js";
import type { LocationWorkplaceType } from "@shared/location-domain";
import { companyLocation } from "../location";
import { type CompanyFetcher, ID_BIG_TECH_SOURCE } from "../types";

const LABEL = "Grab";
const POSTINGS_URL =
  "https://api.smartrecruiters.com/v1/companies/grab/postings";
// grab.careers job ids are SmartRecruiters posting ids; this URL needs no slug.
const JOB_URL = "https://jobs.smartrecruiters.com/Grab/";
const DETAIL_SECTIONS = [
  "jobDescription",
  "qualifications",
  "additionalInformation",
  "companyDescription",
] as const;

function customField(item: UnknownRecord, label: string): string | undefined {
  if (!Array.isArray(item.customField)) return undefined;
  for (const field of item.customField) {
    const record = asRecord(field);
    if (asString(record?.fieldLabel) === label) {
      return asString(record?.valueLabel);
    }
  }
  return undefined;
}

function workplaceTypeOf(
  location: UnknownRecord | null,
): LocationWorkplaceType | null {
  if (location?.remote === true) return "remote";
  if (location?.hybrid === true) return "hybrid";
  return null;
}

export function buildGrabSearchUrl(args: {
  searchTerm: string;
  offset: number;
  limit: number;
}): URL {
  const url = new URL(POSTINGS_URL);
  url.searchParams.set("country", "id");
  url.searchParams.set("q", args.searchTerm);
  url.searchParams.set("limit", String(args.limit));
  url.searchParams.set("offset", String(args.offset));
  return url;
}

function sectionsToHtml(detail: UnknownRecord): string | undefined {
  const sections = asRecord(asRecord(detail.jobAd)?.sections);
  const parts = DETAIL_SECTIONS.map((key) => {
    const section = asRecord(sections?.[key]);
    const text = asString(section?.text);
    if (!text) return undefined;
    const title = asString(section?.title);
    return title ? `<h3>${title}</h3>\n${text}` : text;
  }).filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Grab hires through SmartRecruiters. The search filters by country and
 * keyword; the detail request adds the description and apply link.
 */
export const grabFetcher: CompanyFetcher = {
  id: "grab",
  label: LABEL,
  listing: "search",
  pageSize: 50,
  maxPages: 4,
  async fetchPage({ client }, { searchTerm, offset, limit }) {
    const payload = asRecord(
      await client.getJson(buildGrabSearchUrl({ searchTerm, offset, limit })),
    );
    if (!Array.isArray(payload?.content)) {
      throw new Error(`${LABEL} returned an invalid jobs response`);
    }
    const total = asNumber(payload.totalFound) ?? 0;
    return {
      items: payload.content,
      hasMore: offset + payload.content.length < total,
    };
  },
  toPosting(value, { cities }) {
    const item = asRecord(value);
    const id = asIdentifier(item?.id);
    const title = asString(item?.name);
    if (!item || !id || !title) return null;
    const location = asRecord(item.location);
    if (asString(location?.country)?.toLowerCase() !== "id") return null;

    const workplaceType = workplaceTypeOf(location);
    const brand = customField(item, "Brands");
    const employer = brand ?? asString(asRecord(item.company)?.name) ?? LABEL;
    const jobUrl = `${JOB_URL}${encodeURIComponent(id)}`;
    return {
      item,
      job: {
        source: ID_BIG_TECH_SOURCE,
        sourceJobId: id,
        title,
        employer,
        jobUrl,
        applicationLink: jobUrl,
        ...companyLocation({
          cities: [asString(location?.city)],
          requestedCities: cities,
          workplaceType,
        }),
        datePosted: asString(item.releasedDate),
        jobType: asString(asRecord(item.typeOfEmployment)?.label),
        jobLevel: asString(asRecord(item.experienceLevel)?.label),
        jobFunction:
          customField(item, "Job Family") ??
          asString(asRecord(item.function)?.label),
        companyIndustry: asString(asRecord(item.industry)?.label),
      },
    };
  },
  async fetchDetail({ client }, { job, item }) {
    const id = asIdentifier(asRecord(item)?.id);
    if (!id) return null;
    const detail = asRecord(
      await client.getJson(`${POSTINGS_URL}/${encodeURIComponent(id)}`),
    );
    if (!detail) throw new Error(`${LABEL} returned an invalid job detail`);
    if (detail.active === false) return null;
    const location = asRecord(detail.location);
    if (location && asString(location.country)?.toLowerCase() !== "id") {
      return null;
    }
    const applyUrl = asHttpUrl(detail.applyUrl);
    return {
      ...job,
      jobDescription: sectionsToHtml(detail),
      applicationLink: applyUrl ?? job.applicationLink,
      jobUrlDirect: asHttpUrl(detail.postingUrl),
    };
  },
};
