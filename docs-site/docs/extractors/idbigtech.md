---
id: idbigtech
title: Indonesia Big Tech Extractor
description: Indonesia-only job discovery straight from the career sites of Grab, GoTo, TikTok/Tokopedia, Shopee, Traveloka, tiket.com, Blibli and Xendit.
sidebar_position: 15
---

## What it is

This source reads the public career sites of eight tech companies in one run and keeps the jobs that are in Indonesia (or remote from Indonesia) and match your search terms. No account or API key is needed.

| Company | Where jobs come from | How your search terms are used | Where | Extra request per new job |
| --- | --- | --- | --- | --- |
| Grab | SmartRecruiters (`api.smartrecruiters.com/v1/companies/grab/postings`) | Sent as the keyword, then checked against the title | Country filter `id` | Yes, for the description and apply link |
| GoTo | Lever board `GoToGroup` | Checked against the title (Lever has no search) | Jobs marked as Indonesia | No |
| TikTok & Tokopedia | TikTok careers API (`api.lifeattiktok.com`) | Sent as the keyword, then checked against the title | Jakarta | No |
| Shopee | Sea's job system (`ats.workatsea.com`) | Sent as the keyword, then checked against the title | Shopee's Indonesian cities (Jakarta, Bandung, Bekasi, Medan, Solo, Yogyakarta) | No |
| Traveloka | Traveloka careers API plus the job's web page | Checked against the title | Jobs whose location ends in Indonesia | Yes, the job page holds the description |
| tiket.com | Workday (`tiketdotcom.wd3.myworkdayjobs.com`) | Sent as the keyword, then checked against the title | Workday's Indonesia filter | Yes, for the description and date |
| Blibli | Blibli careers API, read page by page (200 jobs a page) | Checked against the title | All Blibli jobs are in Indonesia | No |
| Xendit | Greenhouse board `xendit` | Checked against the title | Postings that list an Indonesian location | No |

## Why it exists

These companies post many roles only on their own career sites. Reading the sites directly means openings at the companies you care about show up in job-ops without waiting for a job board to pick them up.

## How to use it

1. Open **Run jobs** and choose **Automatic**.
2. Set the country to **Indonesia**. **Indonesia Big Tech** only appears under **Sources** when Indonesia is selected.
3. Enable **Indonesia Big Tech**.
4. Set search terms, optional cities, and the usual result limit.
5. Start the run.

To choose which companies are checked:

1. Open **Settings** → **Workspace Access**.
2. Under **Job Sources** → **Indonesia Big Tech**, turn off the companies you don't want. All eight are on by default, and at least one must stay on.
3. Click **Save**. The next run uses the new list.

Defaults and constraints:

- **Search terms are matched against job titles.** Descriptions are not searched, because nearly every tech job description mentions "engineer". Where a site has its own search (Grab, TikTok, Shopee, tiket.com), the term is also sent there to cut down the results first. A term has up to two parts, a level and a role, and a title must carry both:
  - **Levels** match the whole family: `intern` also matches Internship, Interns, Magang, Trainee and Apprentice; `new grad` or `graduate` also matches Fresh Graduate, Graduates, Campus, Early Career and Entry Level; `junior` also matches Jr and Associate. A term that is only a level (`intern`) keeps every title at that level.
  - **Roles** match common forms and synonyms: `engineer` = Engineering, Developer, Programmer, SDE, SWE; `backend` = Back End = BE; `golang` = `go`; `mobile` also matches Android, iOS, Flutter, React Native, Kotlin and Swift.
  - `software engineer` and `developer` keep any software engineering title (Backend, Data, ML, SRE, QA, Security, Mobile, plain "Engineer"), but not engineers from other fields (Project, Civil, Mechanical, Electrical, Maintenance, Property, Sales, Process, SAP and similar) and not management titles (Engineering Manager). A plain `engineer` keeps every engineer title.
  - Examples: `software engineer intern` keeps "SDE Intern" and "Software Engineering Internship"; `mobile engineer` keeps "Android Developer"; `software engineer` drops "Project Engineer".
- **Employer names are the real company**: `Grab`, `GoTo`, `TikTok`, `Tokopedia`, `Shopee`, `Traveloka`, `tiket.com`, `Blibli`, `Xendit`. Shopee's job system also lists SPX Express (Shopee's delivery arm) and Monee (SeaMoney) roles; those carry their own name. TikTok's site also lists Tokopedia jobs; job-ops names them `Tokopedia` when the title or the team introduction says Tokopedia. On Grab's site the brand field is used, so a Grab-group brand such as OVO keeps its own name. Blibli's site also lists other Blibli-group companies; those keep their legal company name (for example `PT Global Teknologi Niaga`).
- **The result limit** (`jobspyResultsWanted`, up to 200) applies per company and per search term.
- **Politeness:** requests go one at a time, with about 1.5 seconds between them and a browser-like user agent. Sites without a search (GoTo, Traveloka, Blibli, Xendit) are read once per run, not once per term. Each site is read a few pages at most (for example 4 pages of 50 on Grab, 5 pages of 20 on TikTok, Shopee and tiket.com, 10 pages of 200 on Blibli). Responses larger than 8 MB are refused.
- **Detail requests** (Grab, Traveloka, tiket.com) are skipped for job links already in job-ops. If a detail request fails, that job is not imported this time, the run lists a source error, and the next run tries again.
- **Search terms run in order.** If a run is cut short by the time limit, the last terms are the ones lost, so put your most important terms first.
- **A company that is down is skipped.** When a company's site fails (blocked, changed format, timed out), the run reports it once as a source error and skips that company for the remaining search terms. The other companies keep running.
- **Cities:** jobs outside your selected cities are dropped before they count toward the limit. A posting that does not say its city (Blibli rows with no location, tiket.com rows listed as "2 Locations" or "Headquarters") is kept with the location `Indonesia`, because these sites only list Indonesian jobs; for tiket.com the city is first looked up in the job's detail. TikTok's site only covers Jakarta, so with only other cities selected job-ops does not call it. Shopee's search is limited to the selected cities it has. Traveloka's office in BSD City is matched as `Tangerang Selatan` (so `Tangerang` and `Tangerang Selatan` keep it, `Jakarta` does not). When a posting lists several Indonesian cities (Blibli, Xendit), it is shown under the city you selected, otherwise under the first one listed.
- **Location:** every job carries the country Indonesia, so the shared country filter keeps it.
- **Dates:** posted dates come from Grab, GoTo, Traveloka, tiket.com (from the job detail) and Xendit. TikTok, Shopee and Blibli don't publish one.
- **Time limit:** a run stops starting new requests after 8 minutes (the pipeline allows 10 per source) and keeps the jobs collected so far, with a source error saying it was cut short.
- **Job links:**
  - Grab: `https://jobs.smartrecruiters.com/Grab/<id>` (the apply link opens the application form).
  - GoTo: `https://jobs.lever.co/GoToGroup/<id>`.
  - TikTok & Tokopedia: `https://lifeattiktok.com/search/<id>`.
  - Shopee: `https://careers.shopee.co.id/job-detail/<job id>/1`.
  - Traveloka: `https://careers.traveloka.com/jobs/<id>` (the apply link opens Traveloka's application form).
  - tiket.com: the Workday job page.
  - Blibli: `https://careers.blibli.com/job-detail/<title>?job=<code>`.
  - Xendit: `https://job-boards.greenhouse.io/xendit/jobs/<id>`.

## Common problems

### Indonesia Big Tech does not appear under Sources

- Select **Indonesia** as the country first.
- Check `GET /api/idbigtech/health`. The health check only asks Grab, so a healthy result says the source runs, not that every company works.

### One company shows an error but the run finished

- That is expected when one site is down, blocks the request, or changes its format. The error names the company (for example `Grab request failed with status 403; skipped for the rest of this run`), that company is skipped for the remaining search terms, and the other companies still run. The source only fails when every enabled company fails.
- If the same company fails on every run, turn it off in Settings until it is fixed.

### A company returns no jobs

- Titles must contain every main word of your term. Try a broader term such as `engineer` or `backend`.
- Check your cities: TikTok only covers Jakarta, and a district such as `Jakarta Selatan` does not keep jobs that only say `Jakarta`.
- GoTo's public board is small and mostly data and corporate roles. Gojek's own careers site is not covered.

### A run stops early

- With all eight companies, many search terms and a high result limit, the first run can approach the 8-minute budget because of detail requests. Later runs are faster because known jobs skip their detail request. Lower the result limit, use fewer terms, or turn off companies you don't need.

## Related pages

- [Extractors Overview](/docs/next/extractors/overview)
- [Tech in Asia Jobs](/docs/next/extractors/techinasia)
- [Kalibrr](/docs/next/extractors/kalibrr)
- [Dealls](/docs/next/extractors/dealls)
- [Pipeline Run](/docs/next/features/pipeline-run)
