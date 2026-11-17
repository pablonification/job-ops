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

/**
 * Blibli's careers API returns every opening of the Blibli group in one
 * response and ignores filters, so the board is listed once per run and
 * filtered by title here. Jobs from group companies other than Blibli keep
 * their legal company name as the employer.
 */
export const blibliFetcher: CompanyFetcher = {
  id: "blibli",
  label: LABEL,
  listing: "board",
  pageSize: 200,
  maxPages: 1,
  async fetchPage({ client }) {
    const payload = asRecord(await client.postJson(SEARCH_URL, {}));
    const status = asRecord(payload?.status);
    if (
      !Array.isArray(payload?.responseObject) ||
      (status && status.code !== SUCCESS_CODE)
    ) {
      throw new Error(`${LABEL} returned an invalid jobs response`);
    }
    return { items: payload.responseObject, hasMore: false };
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
