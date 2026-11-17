---
id: glints
title: Glints Extractor
description: Indonesia-only job discovery from Glints through its public job search and job detail calls.
sidebar_position: 17
---

## What it is

Original website: [Glints](https://glints.com/id/opportunities/jobs/explore)

This extractor searches Glints the way its own website does (`POST https://glints.com/api/v2/graphql?op=searchJobsV3`), newest jobs first, and then requests each new job's description (`op=getJobById`). No account or API key is required.

## Why it exists

Glints lists many Indonesian tech and startup roles, including internships, usually with a structured salary range and work arrangement.

## How to use it

1. Open **Run jobs** and choose **Automatic**.
2. Set the country to **Indonesia**. Glints only appears under **Sources** when Indonesia is selected.
3. Enable **Glints**.
4. Set search terms, optional cities, workplace types, and the usual result limit.
5. Start the run.

Defaults and constraints:

- **Results are limited to the first page per search term.** Without a login, Glints only serves page 1 of a search (later pages answer "please login"). job-ops always asks for the whole first page (50 jobs), whatever the result limit: the page costs one request either way, and the limit only caps how many jobs are imported. When the page is full, the run lists a source note saying that term was limited to the first page. A search term never returns more than 50 Glints jobs; use more specific terms to reach more jobs.
- Glints ignores the search term unless the request carries a `deviceid` cookie. job-ops sends a fresh random id for each run; no account is involved.
- Results are sorted newest first.
- Glints' search also returns jobs that do not match the term (for example `Mekanik Electrical Engineer` for `software engineer`). job-ops keeps only jobs whose title matches the search term, using the same title check as Kalibrr. A posting whose Glints job type is `Internship` counts as an internship even when its title does not say so.
- Search results do not include the job text, so job-ops makes one detail request per new job. Jobs whose link is already in job-ops skip the detail request. A job whose detail request fails is not imported; the next run requests it again.
- Glints stores descriptions as rich text (Draft.js). job-ops converts them to simple HTML: paragraphs, headings, bullet and numbered lists, bold, italic and links. Unknown formatting becomes plain text. Very long descriptions (over 1,000 blocks or 50,000 characters) are cut off and end with `…`. If a description cannot be read at all, the job is imported without a description and the run lists a Glints source error.
- Requests are sent one at a time with a pause of about 1.5 seconds between them and a browser-like user agent.
- The result limit (`jobspyResultsWanted`) caps jobs per search term.
- Cities: Glints' search has no city filter that job-ops can use, so job-ops filters by city itself before a job counts toward the limit and before its detail is requested. Glints gives a full place hierarchy (district, city, province), so a job in `Kebayoran Baru` is kept for `Jakarta Selatan`, `South Jakarta` or `Jakarta`. When Glints gives only a place name without its city, the job is shown with that name (for example `Sumbersari, Indonesia`) and kept by any city filter, because its city is unknown. Because only one page is served, a city filter can leave few results.
- Workplace types: when you choose fewer than all three (remote, hybrid, on-site), the choice is sent to Glints' work-arrangement filter. With all three selected no filter is sent. If Glints rejects the filter, job-ops repeats the search without it, filters workplace types itself for the rest of the run and lists a source note.
- Salaries come from Glints' structured salary (amount range, currency and period), for example `IDR 800,000–1,000,000 / month`. Jobs where the employer hides the salary have none.
- Closed jobs and jobs outside Indonesia are skipped.
- Job links point to `https://glints.com/id/opportunities/jobs/<id>`. Glints redirects that link to the page with the job title in it; the link without the title stays the same if the employer edits the title, so de-duplication keeps working.
- Locations name the district, city, province and country, for example `Pagedangan, Tangerang, Banten, Indonesia`, so the shared country and city filter keeps the job.
- A run stops starting new requests after 8 minutes and keeps the jobs collected so far. The 8 minutes are shared fairly between search terms: each term may use at most the time left divided by the terms left, so every term gets a turn. A term that uses up its share stops with a source note and the next term starts; time a quick term leaves unused goes to the later ones.

## Common problems

### Glints does not appear under Sources

- Select **Indonesia** as the country first.
- Check `GET /api/glints/health` for runtime discovery or upstream errors.

### Glints returns few jobs

- Only the first page (up to 50 jobs) is served per term, and jobs whose title does not match the term or that are outside the selected cities are dropped. Add more specific search terms (for example `backend intern` and `frontend intern` instead of `intern`).

### Glints reports a GraphQL error

- The run lists `Glints search returned GraphQL error <code>`. `NO_PERMISSION` means Glints now asks for a login for this search; other codes usually mean Glints changed its API. Other sources in the same run continue.

### Glints reports failed detail requests or unreadable descriptions

- A failed detail request means the job is not imported; the next run requests it again.
- An unreadable description means the job was imported without one. Open the job link to read it on Glints.

## Related pages

- [Extractors Overview](/docs/next/extractors/overview)
- [JobStreet](/docs/next/extractors/jobstreet)
- [Dealls](/docs/next/extractors/dealls)
- [Kalibrr](/docs/next/extractors/kalibrr)
- [Pipeline Run](/docs/next/features/pipeline-run)
