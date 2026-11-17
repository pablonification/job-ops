import { asRecord, asString } from "@shared/extractors/indonesia/index.js";
import { unescapeHtmlDescription } from "../html";
import { companyLocation } from "../location";
import { type CompanyFetcher, ID_BIG_TECH_SOURCE } from "../types";

const LABEL = "Blibli";
const SEARCH_URL = "https://careers.blibli.com/ext/api/job/search";
const JOB_URL = "https://careers.blibli.com/job-detail/";
const SUCCESS_CODE = 1000;
/** PT Global Digital Niaga Tbk is Blibli itself; other entities are group companies. */
const BLIBLI_COMPANY = /global digital niaga/i;

/** The careers site's own link: `/job-detail/<title-with-dashes>?job=<jobCode>`. */
export function buildBlibliJobUrl(title: string, jobCode: string): string {
  const slug = title.split(" ").join("-").toLowerCase();
  return `${JOB_URL}${encodeURIComponent(slug)}?job=${encodeURIComponent(jobCode)}`;
}

/** The search body the careers site sends, with its paging token. */
export function buildBlibliSearchBody(args: {
  limit: number;
  cursor?: string;
}) {
  return {
    experiences: [],
    employmentTypes: [],
    locations: [],
    departments: [],
    companies: [],
    companyCodes: [],
    jobName: "",
    itemPerPage: args.limit,
    ...(args.cursor ? { paginationToken: args.cursor } : {}),
  };
}

/**
 * Blibli's careers API lists every opening of the Blibli group, 200 per page,
 * with a token for the next page (none on the last). The board is listed
 * once per run and filtered by title here. Jobs from group companies other
 * than Blibli keep their legal company name as the employer.
 */
export const blibliFetcher: CompanyFetcher = {
  id: "blibli",
  label: LABEL,
  listing: "board",
  pageSize: 200,
  maxPages: 10,
  async fetchPage({ client }, { limit, cursor }) {
    const payload = asRecord(
      await client.postJson(
        SEARCH_URL,
        buildBlibliSearchBody({ limit, cursor }),
      ),
    );
    const status = asRecord(payload?.status);
    if (
      !Array.isArray(payload?.responseObject) ||
      (status && status.code !== SUCCESS_CODE)
    ) {
      throw new Error(`${LABEL} returned an invalid jobs response`);
    }
    const next = asString(payload.paginationToken);
    return {
      items: payload.responseObject,
      hasMore: Boolean(next) && next !== cursor,
      cursor: next,
    };
  },
  toPosting(value, { cities }) {
    const item = asRecord(value);
    const jobCode = asString(item?.jobCode);
    const title = asString(item?.jobName);
    if (!item || !jobCode || !title) return null;
    if (item.active === false || item.postingStatus === false) return null;
    const recruitment = asString(item.recruitmentStatus);
    if (recruitment && recruitment.toLowerCase() !== "open") return null;

    const companyName = asString(item.companyName);
    const employer =
      !companyName || BLIBLI_COMPANY.test(companyName) ? LABEL : companyName;
    const summary = asString(item.jobSummary);
    const jobUrl = buildBlibliJobUrl(title, jobCode);
    return {
      item,
      job: {
        source: ID_BIG_TECH_SOURCE,
        sourceJobId: jobCode,
        title,
        employer,
        jobUrl,
        applicationLink: jobUrl,
        // "Kota Bekasi,Kota Jakarta Pusat" lists every city of the posting.
        ...companyLocation({
          cities: (asString(item.location) ?? "").split(","),
          requestedCities: cities,
        }),
        jobDescription: summary ? unescapeHtmlDescription(summary) : undefined,
        jobType: asString(item.employmentType),
        jobLevel: asString(item.experience),
        jobFunction: asString(item.department),
      },
    };
  },
};
