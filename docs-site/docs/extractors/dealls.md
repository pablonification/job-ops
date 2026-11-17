---
id: dealls
title: Dealls Extractor
description: Indonesia-only job discovery from Dealls through its public job list and job detail APIs.
sidebar_position: 14
---

## What it is

Original website: [Dealls](https://dealls.com/loker)

This extractor searches Dealls' public job list API (`GET https://api.sejutacita.id/v1/explore-job/job`) and then requests each job's detail (`GET /v1/job-portal/job/slug/<slug>`) to import the description, responsibilities, and requirements. No account or API key is required.

## Why it exists

Dealls lists startup and tech roles in Indonesia, including internships, often with a monthly rupiah salary range.

## How to use it

1. Open **Run jobs** and choose **Automatic**.
2. Set the country to **Indonesia**. Dealls only appears under **Sources** when Indonesia is selected.
3. Enable **Dealls**.
4. Set search terms, optional cities, and the usual result limit.
5. Start the run.

Defaults and constraints:

- Each search term is sent separately. Dealls only lists Indonesian jobs.
- The search results do not include the job text, so job-ops makes one detail request per new job. Jobs whose link is already in job-ops skip the detail request.
- Requests are sent one at a time with a pause of about 1.5 seconds between them and a browser-like user agent. Results are fetched 20 per page.
- The result limit (`jobspyResultsWanted`) caps jobs per search term, up to 200. With a high limit a run can take several minutes because of the detail requests.
- Cities: Dealls has no city filter in its API, so job-ops filters by city itself before a job counts toward the limit and before its detail is requested. With cities selected, at most three times the limit is scanned per term.
- City names are matched across English and Indonesian forms for the Jakarta districts (`South Jakarta` = `Jakarta Selatan` = `Jaksel`, and so on), South Tangerang, Yogyakarta (`Jogja`) and Surakarta (`Solo`). A city filter keeps jobs in that city or inside it: `Jakarta` keeps every Jakarta district, but `Jakarta Selatan` does not keep a job listed only as `Jakarta`.
- Paging stops early when a page holds only jobs that an earlier search term already returned.
- A run stops starting new requests after 8 minutes (the pipeline allows 10 per source) and keeps the jobs collected so far; the run then lists a source error saying it was cut short.
- Salaries are imported as monthly rupiah amounts (for example `IDR 3,000,000–4,000,000 / month`), matching how Dealls displays them.
- Jobs whose detail says they are closed are skipped.
- Job links point to `https://dealls.com/loker/<job>~<company>`. When the employer uses an external application page, the apply link points there.
- Dealls often gives only a city, such as `Jakarta Selatan`. job-ops adds the country (`Jakarta Selatan, Indonesia`), so the shared country and city filter keeps the job.

## Common problems

### Dealls does not appear under Sources

- Select **Indonesia** as the country first.
- Check `GET /api/dealls/health` for runtime discovery or upstream errors.

### Dealls reports failed detail requests

- When a detail request fails, that job is not imported and the run lists a Dealls source error. The next run requests it again.

### A Dealls run stops early

- With many search terms and a high result limit, the detail requests can approach the pipeline's 10-minute limit per source. job-ops stops starting requests after 8 minutes, keeps the jobs collected so far and lists a source error. Lower the result limit or use fewer terms.

### Dealls temporarily fails

- A failed search request is reported as a source error with its HTTP status only. Other sources in the same run continue.

## Related pages

- [Extractors Overview](/docs/next/extractors/overview)
- [Tech in Asia Jobs](/docs/next/extractors/techinasia)
- [Kalibrr](/docs/next/extractors/kalibrr)
- [Pipeline Run](/docs/next/features/pipeline-run)
