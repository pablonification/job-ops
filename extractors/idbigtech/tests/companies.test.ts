import { matchJobLocationIntent } from "@shared/job-matching";
import { normalizeLocationIntent } from "@shared/location-domain";
import { describe, expect, it } from "vitest";
import { buildBlibliJobUrl } from "../src/companies/blibli";
import { shopeeCityIds, shopeeEmployer } from "../src/companies/shopee";
import { tiktokEmployer } from "../src/companies/tiktok";
import { parseTravelokaJobPage } from "../src/companies/traveloka";
import { parseXenditLocation } from "../src/companies/xendit";
import { runIdBigTech } from "../src/run";
import blibliSearch from "./fixtures/blibli_search.json";
import blibliSearchPage2 from "./fixtures/blibli_search_page2.json";
import gotoLever from "./fixtures/goto_lever.json";
import grabDetail from "./fixtures/grab_detail.json";
import grabSearch from "./fixtures/grab_search.json";
import shopeeSearch from "./fixtures/shopee_search.json";
import tiketDetail from "./fixtures/tiket_detail.json";
import tiketSearch from "./fixtures/tiket_search.json";
import tiktokSearch from "./fixtures/tiktok_search.json";
import travelokaJobPage from "./fixtures/traveloka_job.html?raw";
import travelokaSearch from "./fixtures/traveloka_search.json";
import xenditBoard from "./fixtures/xendit_greenhouse.json";
import {
  htmlResponse,
  jsonResponse,
  routedFetch,
  testOptions,
} from "./helpers";

function byTitle(jobs: { title: string }[], title: string) {
  const job = jobs.find((item) => item.title === title);
  if (!job) throw new Error(`missing job ${title}`);
  return job as (typeof jobs)[number] & Record<string, unknown>;
}

describe("Grab fetcher (SmartRecruiters)", () => {
  const GRAB_URL = "https://jobs.smartrecruiters.com/Grab/744000161430409";
  // The recorded page is the whole result set for these tests.
  const searchPage = (content: unknown[]) =>
    jsonResponse({ ...grabSearch, content, totalFound: content.length });
  const routes = () =>
    routedFetch({
      "api.smartrecruiters.com/v1/companies/grab/postings/744000161430409":
        () => jsonResponse(grabDetail),
      "api.smartrecruiters.com/v1/companies/grab/postings": () =>
        searchPage(grabSearch.content),
    });

  it("searches Indonesia by keyword, keeps relevant titles and adds the detail", async () => {
    const { fetchImpl, requests } = routes();
    const result = await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["grab"],
      searchTerms: ["software engineer"],
    });

    const search = requests[0].url;
    expect(search.searchParams.get("country")).toBe("id");
    expect(search.searchParams.get("q")).toBe("software engineer");
    expect(search.searchParams.get("offset")).toBe("0");
    // "Merchant Business Growth" came back from the loose search but is dropped.
    expect(requests).toHaveLength(2);
    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    const job = result.jobs[0];
    expect(job).toMatchObject({
      source: "idbigtech",
      sourceJobId: "744000161430409",
      title: "Senior Software Engineer, Flutter - Merchant Experience",
      employer: "Grab",
      jobUrl: GRAB_URL,
      applicationLink:
        "https://jobs.smartrecruiters.com/Grab/744000161430409-senior-software-engineer-flutter-merchant-experience?oga=true",
      location: "Jakarta, Indonesia",
      datePosted: "2026-11-13T06:29:28.110Z",
      jobType: "Full-time",
      jobLevel: "Associate",
      jobFunction: "Software Engineering",
    });
    expect(job.locationEvidence).toMatchObject({
      country: "Indonesia",
      city: "Jakarta",
      source: "idbigtech",
    });
    expect(job.jobDescription).toContain("<h3>Job Description</h3>");
    expect(job.jobDescription).toContain("<h3>Qualifications</h3>");
  });

  it("skips the detail request for a job already in job-ops", async () => {
    const { fetchImpl, requests } = routes();
    const result = await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["grab"],
      searchTerms: ["software engineer"],
      getExistingJobUrls: async () => [GRAB_URL],
    });
    expect(requests).toHaveLength(1);
    expect(result.jobs.map((job) => job.jobUrl)).toEqual([GRAB_URL]);
  });

  it("drops postings outside Indonesia and does not import a failed detail", async () => {
    const [first] = grabSearch.content;
    const { fetchImpl } = routedFetch({
      "api.smartrecruiters.com/v1/companies/grab/postings/744000161430409":
        () => jsonResponse({}, 500),
      "api.smartrecruiters.com/v1/companies/grab/postings": () =>
        searchPage([
          first,
          { ...first, id: "1", location: { ...first.location, country: "sg" } },
        ]),
    });
    const result = await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["grab"],
      searchTerms: ["software engineer"],
    });
    expect(result).toEqual({
      success: true,
      jobs: [],
      sourceErrors: [
        "Grab: 1 job detail request(s) failed; those jobs were not imported and will be retried on the next run (term: software engineer)",
      ],
    });
  });
});

describe("GoTo fetcher (Lever)", () => {
  it("lists the board once per run and filters titles per term in Indonesia", async () => {
    const { fetchImpl, requests } = routedFetch({
      "api.lever.co/v0/postings/GoToGroup": () => jsonResponse(gotoLever),
    });
    const result = await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["goto"],
      searchTerms: ["data scientist", "associate", "crm"],
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].url.searchParams.get("mode")).toBe("json");
    // "CRM Executive" is in Singapore.
    expect(result.jobs.map((job) => job.title)).toEqual([
      "Data Scientist Intern",
      "Facilities and Maintenance Associate",
    ]);
    const intern = byTitle(result.jobs, "Data Scientist Intern");
    expect(intern).toMatchObject({
      employer: "GoTo",
      jobUrl:
        "https://jobs.lever.co/GoToGroup/816f2d4c-5ff6-4e83-8697-9c25df599409",
      applicationLink:
        "https://jobs.lever.co/GoToGroup/816f2d4c-5ff6-4e83-8697-9c25df599409/apply",
      location: "Jakarta, Indonesia",
      datePosted: new Date(1719909376581).toISOString(),
      jobType: "Internship",
      jobFunction: "FinTech - Data",
      workFromHomeType: "onsite",
    });
    expect(intern.jobDescription).toContain("<h3>What You Will Do</h3>");
  });
});

describe("TikTok fetcher (TikTok careers API)", () => {
  it("searches Jakarta by keyword and tells Tokopedia from TikTok", async () => {
    const { fetchImpl, requests } = routedFetch({
      "api.lifeattiktok.com/api/v1/public/supplier/search/job/posts": () =>
        jsonResponse(tiktokSearch),
    });
    const result = await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["tiktok"],
      searchTerms: ["engineer"],
    });

    expect(requests[0].method).toBe("POST");
    expect(requests[0].headers["website-path"]).toBe("tiktok");
    expect(requests[0].body).toMatchObject({
      keyword: "engineer",
      location_code_list: ["CT_169"],
      offset: 0,
    });
    expect(result.jobs.map((job) => [job.employer, job.title])).toEqual([
      ["TikTok", "TikTok Shop - GTL Logistics - Project Engineer- Indonesia"],
      [
        "Tokopedia",
        "Frontend Engineer Intern (TikTok Shop by Tokopedia) - 2027 Start",
      ],
    ]);
    expect(result.jobs[1]).toMatchObject({
      jobUrl: "https://lifeattiktok.com/search/7675224627606784309",
      location: "Jakarta, Jakarta Raya, Indonesia",
      jobType: "Intern",
      jobFunction: "Frontend",
    });
    expect(result.jobs[1].jobDescription).toContain("Minimum Qualifications");
    expect(result.jobs[1].salary).toBeUndefined();
  });

  it("names Tokopedia from the team introduction when the title does not", () => {
    expect(
      tiktokEmployer(
        "Backend Engineer",
        "About the team\nTokopedia is an e-Commerce platform",
      ),
    ).toBe("Tokopedia");
    expect(
      tiktokEmployer(
        "Backend Engineer",
        "About the team\nTikTok Shop and Tokopedia",
      ),
    ).toBe("TikTok");
    expect(tiktokEmployer("Backend Engineer")).toBe("TikTok");
  });

  it("sends no request when the requested cities exclude Jakarta", async () => {
    const { fetchImpl, requests } = routedFetch({});
    const result = await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["tiktok"],
      searchTerms: ["engineer"],
      cities: ["Surabaya"],
    });
    expect(requests).toHaveLength(0);
    expect(result).toEqual({ success: true, jobs: [] });
  });
});

describe("Shopee fetcher (Sea ATS)", () => {
  it("searches Shopee's Indonesian cities and keeps relevant titles", async () => {
    const { fetchImpl, requests } = routedFetch({
      "ats.workatsea.com/ats/api/v1/user/job/list/": () =>
        jsonResponse(shopeeSearch),
    });
    const result = await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["shopee"],
      searchTerms: ["engineer", "content"],
    });

    const search = requests[0].url;
    expect(search.searchParams.get("search_content")).toBe("engineer");
    expect(search.searchParams.getAll("city_ids")).toEqual([
      "8",
      "9",
      "10",
      "11",
      "12",
      "13",
    ]);
    // Neither result is an engineering title, so only "content" keeps one.
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({
      title: "Regional Content & Creator Experience",
      employer: "Shopee",
      sourceJobId: "J02163314",
      jobUrl: "https://careers.shopee.co.id/job-detail/J02163314/1",
      location: "Jakarta, Indonesia",
    });
    expect(result.jobs[0].jobDescription).toContain("<h3>Requirements</h3>");
    expect(result.jobs[0].jobDescription).not.toContain("About the team");
  });

  it("names SPX Express and Monee postings after their own business", async () => {
    const { fetchImpl } = routedFetch({
      "ats.workatsea.com/ats/api/v1/user/job/list/": () =>
        jsonResponse(shopeeSearch),
    });
    const result = await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["shopee"],
      searchTerms: ["business operations"],
    });
    expect(result.jobs.map((job) => [job.employer, job.title])).toEqual([
      ["SPX Express", "Business Operations Project, SPX Express"],
    ]);
    expect(shopeeEmployer("Risk Analyst", 2)).toBe("Monee");
    expect(shopeeEmployer("Hub Lead, SPX Express")).toBe("SPX Express");
    expect(shopeeEmployer("Backend Engineer", 1)).toBe("Shopee");
  });

  it("narrows city ids to the requested cities", () => {
    expect(shopeeCityIds(["Bandung"])).toEqual([8]);
    expect(shopeeCityIds(["Solo"])).toEqual([12]);
    expect(shopeeCityIds(["Jakarta Selatan"])).toEqual([]);
  });
});

describe("Traveloka fetcher (list API and HTML detail page)", () => {
  const routes = (page = travelokaJobPage) =>
    routedFetch({
      "careers.traveloka.com/api/career/jobs/search": () =>
        jsonResponse(travelokaSearch),
      "careers.traveloka.com/jobs/": () => htmlResponse(page),
    });

  it("lists the board once, filters by title and country and reads the job page", async () => {
    const { fetchImpl, requests } = routes();
    const result = await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["traveloka"],
      searchTerms: ["software engineer", "android"],
    });

    // One list request, one detail page; the Shenzhen Android role is dropped.
    expect(requests.map((request) => request.url.pathname)).toEqual([
      "/api/career/jobs/search",
      "/jobs/mj000453-software-development-engineer-in",
    ]);
    expect(requests[0].url.searchParams.get("page")).toBe("1");
    expect(result.jobs).toHaveLength(1);
    const job = result.jobs[0];
    expect(job).toMatchObject({
      title: "Software Development Engineer In Test",
      employer: "Traveloka",
      jobUrl:
        "https://careers.traveloka.com/jobs/mj000453-software-development-engineer-in",
      applicationLink:
        "https://hire-r1.mokahr.com/social-recruitment/traveloka/100008526#/job/e5fc2d5f-616e-4367-9e11-38fd2353ec3f/apply",
      location: "BSD City, Indonesia",
      datePosted: new Date(1794541975000).toISOString(),
      jobFunction: "Engineering & IT",
    });
    expect(job.locationEvidence).toMatchObject({
      country: "Indonesia",
      city: "Tangerang Selatan",
    });
    expect(job.jobDescription).toContain("<p>Key Responsibilities</p>");
    expect(job.jobDescription).not.toContain("Apply Now");
  });

  it("parses the description and apply link from a job page", () => {
    const page = parseTravelokaJobPage(travelokaJobPage);
    expect(page.description).toMatch(/^<p><i>Job ID: MJ000249<\/i><\/p>/);
    expect(page.description).toMatch(/<\/p>$/);
    expect(page.applyUrl).toContain("mokahr.com");
    expect(parseTravelokaJobPage("<html></html>")).toEqual({
      description: undefined,
      applyUrl: undefined,
    });
  });

  it("does not import a job whose page has no description", async () => {
    const { fetchImpl } = routes("<html><body>Maintenance</body></html>");
    const result = await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["traveloka"],
      searchTerms: ["software engineer"],
    });
    expect(result.jobs).toEqual([]);
    expect(result.sourceErrors?.[0]).toMatch(
      /^Traveloka: 1 job detail request\(s\) failed/,
    );
  });

  it("keeps BSD City jobs through the shared location filter", async () => {
    const { fetchImpl } = routes();
    const result = await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["traveloka"],
      searchTerms: ["software engineer"],
    });
    const intent = (cityLocations: string[]) =>
      normalizeLocationIntent({ selectedCountry: "indonesia", cityLocations });
    expect(matchJobLocationIntent(result.jobs[0], intent([])).matched).toBe(
      true,
    );
    expect(
      matchJobLocationIntent(result.jobs[0], intent(["Tangerang Selatan"]))
        .matched,
    ).toBe(true);
  });
});

describe("tiket.com fetcher (Workday)", () => {
  const KNOWN =
    "https://tiketdotcom.wd3.myworkdayjobs.com/Tiket_Careers/job/Jakarta-Indonesia/Machine-Learning-Engineer-Intern_R-3229";

  it("searches with the Indonesia facet and completes new jobs from the detail", async () => {
    const { fetchImpl, requests } = routedFetch({
      "tiketdotcom.wd3.myworkdayjobs.com/wday/cxs/tiketdotcom/Tiket_Careers/jobs":
        () => jsonResponse(tiketSearch),
      "tiketdotcom.wd3.myworkdayjobs.com/wday/cxs/tiketdotcom/Tiket_Careers/job/":
        () => jsonResponse(tiketDetail),
    });
    const result = await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["tiket"],
      searchTerms: ["software engineer"],
      getExistingJobUrls: async () => [KNOWN],
    });

    expect(requests[0].method).toBe("POST");
    expect(requests[0].body).toEqual({
      appliedFacets: { locationCountry: ["b31234dbcdda4da9ba8fa073c5944e36"] },
      limit: 20,
      offset: 0,
      searchText: "software engineer",
    });
    // The known intern posting is kept without a detail request.
    expect(requests).toHaveLength(2);
    expect(result.jobs.map((job) => job.jobUrl)).toEqual([
      KNOWN,
      "https://tiketdotcom.wd3.myworkdayjobs.com/Tiket_Careers/job/Jakarta-Indonesia/Software-Engineer-II---GRAND--_R-3375",
    ]);
    expect(result.jobs[1]).toMatchObject({
      title: "Software Engineer II (Growth, Analytics & Discovery)",
      employer: "tiket.com",
      sourceJobId: "R-3375",
      location: "Jakarta, Indonesia",
      datePosted: "2026-10-21",
      jobType: "Full time",
    });
    expect(result.jobs[1].jobDescription).toContain("travel app");
  });

  it("resolves rows without a city from the detail before filtering by city", async () => {
    const [intern, engineer] = tiketSearch.jobPostings;
    // Workday lists multi-location postings as "2 Locations" and some as the
    // site name ("Headquarters"); the recorded rows are reused with those texts.
    const headquarters = {
      ...engineer,
      title: "Data Engineer",
      externalPath: "/job/Headquarters/Data-Engineer_R-4000",
      locationsText: "Headquarters",
      bulletFields: ["R-4000"],
    };
    const { fetchImpl, requests } = routedFetch({
      "tiketdotcom.wd3.myworkdayjobs.com/wday/cxs/tiketdotcom/Tiket_Careers/jobs":
        () =>
          jsonResponse({
            total: 3,
            jobPostings: [
              intern,
              { ...engineer, locationsText: "2 Locations" },
              headquarters,
            ],
          }),
      "tiketdotcom.wd3.myworkdayjobs.com/wday/cxs/tiketdotcom/Tiket_Careers/job/Jakarta-Indonesia/":
        () =>
          jsonResponse({
            ...tiketDetail,
            jobPostingInfo: {
              ...tiketDetail.jobPostingInfo,
              additionalLocations: ["Bali, Indonesia"],
            },
          }),
      "tiketdotcom.wd3.myworkdayjobs.com/wday/cxs/tiketdotcom/Tiket_Careers/job/Headquarters/":
        () =>
          jsonResponse({
            ...tiketDetail,
            jobPostingInfo: {
              ...tiketDetail.jobPostingInfo,
              title: "Data Engineer",
              location: "Headquarters",
              jobReqId: "R-4000",
            },
          }),
    });
    const result = await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["tiket"],
      searchTerms: ["software engineer"],
      cities: ["Bali"],
    });

    // The Jakarta intern row is filtered by city without a detail request.
    expect(requests).toHaveLength(3);
    expect(
      result.jobs.map((job) => [job.title, job.location, job.sourceJobId]),
    ).toEqual([
      [
        "Software Engineer II (Growth, Analytics & Discovery)",
        "Bali, Indonesia",
        "R-3375",
      ],
      ["Data Engineer", "Indonesia", "R-4000"],
    ]);
    expect(result.jobs[1].locationEvidence?.cityUnknown).toBe(true);
  });

  it("drops list results located outside Indonesia", async () => {
    const [first] = tiketSearch.jobPostings;
    const { fetchImpl, requests } = routedFetch({
      "tiketdotcom.wd3.myworkdayjobs.com/wday/cxs/tiketdotcom/Tiket_Careers/jobs":
        () =>
          jsonResponse({
            total: 1,
            jobPostings: [{ ...first, locationsText: "Noida, India" }],
          }),
    });
    const result = await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["tiket"],
      searchTerms: ["engineer"],
    });
    expect(requests).toHaveLength(1);
    expect(result).toEqual({ success: true, jobs: [] });
  });
});

describe("Blibli fetcher (careers API with embedded summary)", () => {
  // Page 1 is 200 jobs plus a paging token; page 2 is the rest, without one.
  const routes = () =>
    routedFetch({
      "careers.blibli.com/ext/api/job/search": (request) =>
        jsonResponse(
          (request.body as { paginationToken?: string }).paginationToken ===
            blibliSearch.paginationToken
            ? blibliSearchPage2
            : blibliSearch,
        ),
    });

  it("follows the paging token through the whole board once per run", async () => {
    const { fetchImpl, requests } = routes();
    const result = await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["blibli"],
      searchTerms: ["engineer", "it support", "audit", "business commercial"],
    });

    expect(requests.map((request) => request.body)).toEqual([
      expect.objectContaining({ jobName: "", itemPerPage: 200 }),
      expect.objectContaining({
        itemPerPage: 200,
        paginationToken: blibliSearch.paginationToken,
      }),
    ]);
    expect(requests[0].body).not.toHaveProperty("paginationToken");
    // The "Hold" posting is not open; the audit role is on page 2.
    expect(result.jobs.map((job) => [job.employer, job.title])).toEqual([
      ["Blibli", "Cybersecurity Engineer (Redteam)"],
      ["Blibli", "Property Operations - ME Engineer"],
      // "developer" counts as "engineer".
      ["Blibli", "Developer Intern"],
      ["PT Global Teknologi Niaga", "Junior IT Support Staff"],
      ["PT Global Teknologi Niaga", "Junior Internal Audit Staff"],
    ]);
    const job = result.jobs[0];
    expect(job).toMatchObject({
      sourceJobId: "a69f9d65733f03",
      jobUrl:
        "https://careers.blibli.com/job-detail/cybersecurity-engineer-(redteam)?job=a69f9d65733f03",
      location: "Jakarta Pusat, Indonesia",
      jobType: "Permanent",
      jobFunction: "IT, Telecom & Internet",
    });
    expect(job.jobDescription).toContain(
      "<p>Blibli is on a journey to become Indonesia’s #1 e-commerce platform",
    );
    expect(job.jobDescription).not.toContain("&lt;");
    expect(job.jobDescription).not.toContain("ExternalClass");
  });

  it("keeps a posting without a location under a city filter", async () => {
    const { fetchImpl } = routes();
    const result = await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["blibli"],
      searchTerms: ["software engineer intern"],
      cities: ["Bandung"],
    });

    // "Developer Intern" has an empty location on Blibli's board.
    expect(result.jobs.map((job) => job.title)).toEqual(["Developer Intern"]);
    expect(result.jobs[0].location).toBe("Indonesia");
    expect(result.jobs[0].locationEvidence).toMatchObject({
      country: "Indonesia",
      city: null,
      cityUnknown: true,
    });
    const intent = normalizeLocationIntent({
      selectedCountry: "indonesia",
      cityLocations: ["Bandung"],
    });
    expect(matchJobLocationIntent(result.jobs[0], intent).matched).toBe(true);
  });

  it("shows a multi-city posting under the requested city", async () => {
    const { fetchImpl } = routes();
    const result = await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["blibli"],
      searchTerms: ["sales supervisor"],
      cities: ["Bandung"],
    });
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].location).toBe("Bandung, Indonesia");
  });

  it("builds the careers site's own job link", () => {
    expect(buildBlibliJobUrl("Junior IT Support Staff", "abc")).toBe(
      "https://careers.blibli.com/job-detail/junior-it-support-staff?job=abc",
    );
  });
});

describe("Xendit fetcher (Greenhouse with content)", () => {
  const routes = () =>
    routedFetch({
      "boards-api.greenhouse.io/v1/boards/xendit/jobs": () =>
        jsonResponse(xenditBoard),
    });

  it("lists the board once and keeps Indonesian postings matching the term", async () => {
    const { fetchImpl, requests } = routes();
    const result = await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["xendit"],
      searchTerms: ["customer success manager", "product manager"],
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].url.searchParams.get("content")).toBe("true");
    expect(result.jobs.map((job) => job.title)).toEqual([
      "Customer Success Manager (ID/MY)",
      "Product Manager - Developer Experience",
    ]);
    const job = result.jobs[0];
    expect(job).toMatchObject({
      employer: "Xendit",
      jobUrl: "https://job-boards.greenhouse.io/xendit/jobs/8201138003",
      location: "Jakarta, Indonesia",
      datePosted: "2026-11-12T04:29:34-05:00",
      jobFunction: "Customer Success Management",
    });
    expect(job.jobDescription).toContain("<h3>About the Job</h3>");
    expect(job.jobDescription).not.toContain("&lt;");
    // Bali is listed first for this posting.
    expect(result.jobs[1].location).toBe("Bali, Indonesia");
  });

  it("prefers a requested Indonesian city on multi-country postings", async () => {
    const { fetchImpl } = routes();
    const result = await runIdBigTech({
      ...testOptions(fetchImpl),
      companies: ["xendit"],
      searchTerms: ["product manager"],
      cities: ["Jakarta"],
    });
    expect(result.jobs.map((job) => job.location)).toEqual([
      "Jakarta, Indonesia",
    ]);
  });

  it("reads Indonesian cities and remote work from the location text", () => {
    expect(parseXenditLocation("Bangkok, Thailand")).toEqual({
      inIndonesia: false,
      cities: [],
      remote: false,
    });
    expect(
      parseXenditLocation("Remote - Indonesia; Jakarta, Indonesia"),
    ).toEqual({ inIndonesia: true, cities: ["Jakarta"], remote: true });
    expect(
      parseXenditLocation("Jakarta, Indonesia (Hybrid); Singapore, Singapore"),
    ).toEqual({ inIndonesia: true, cities: ["Jakarta"], remote: false });
  });
});
