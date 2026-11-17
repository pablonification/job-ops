---
id: techinasia
title: Tech in Asia Jobs Extractor
description: Indonesia-only job discovery from Tech in Asia Jobs through its public job-postings API.
sidebar_position: 12
---

## What it is

Original website: [Tech in Asia Jobs](https://www.techinasia.com/jobs)

This extractor searches Tech in Asia's public job-postings API (`GET /api/2.0/job-postings`) for jobs in Indonesia and maps them into job-ops with full descriptions, published salaries, skills, and Indonesian location evidence. No account or API key is required.

## Why it exists

Tech in Asia lists startup and tech roles across Indonesia, often with a published salary range. The API returns the full description in the search results, so no extra request per job is needed.

## How to use it

1. Open **Run jobs** and choose **Automatic**.
2. Set the country to **Indonesia**. Tech in Asia Jobs only appears under **Sources** when Indonesia is selected.
3. Enable **Tech in Asia Jobs**.
4. Set search terms, optional cities, and the usual result limit.
5. Start the run.

Defaults and constraints:

- Each search term is sent separately with the country filter `Indonesia`.
- Results are fetched 20 per page, with a pause of about 1.5 seconds between requests and a browser-like user agent.
- The result limit (`jobspyResultsWanted`) caps jobs per search term, up to 200.
- Cities: Tech in Asia has no city filter in its API, so job-ops filters by city itself before a job counts toward the limit. With cities selected, at most three times the limit is scanned per term.
- City names are matched across English and Indonesian forms for the Jakarta districts (`South Jakarta` = `Jakarta Selatan` = `Jaksel`, and so on), South Tangerang, Yogyakarta (`Jogja`) and Surakarta (`Solo`). A city filter keeps jobs in that city or inside it: `Jakarta` keeps every Jakarta district, but `Jakarta Selatan` does not keep a job listed only as `Jakarta`.
- Paging stops early when a page holds only jobs that an earlier search term already returned.
- A run stops starting new requests after 8 minutes (the pipeline allows 10 per source) and keeps the jobs collected so far; the run then lists a source error saying it was cut short. The 8 minutes are shared fairly between search terms: each term may use at most the time left divided by the terms left, so every term gets a turn. A term that uses up its share stops with a source note and the next term starts; time a quick term leaves unused goes to the later ones.
- Salary is imported only when Tech in Asia shows it and the amount is above zero (for example `IDR 7,000,000–10,000,000 / month`).
- Job links point to `https://www.techinasia.com/jobs/<id>`. When the employer uses an external application page, the apply link points there.
- Every job carries the country Indonesia in its location (for example `Jakarta, Jakarta Raya, Indonesia`), so the shared country and city filter keeps it.

## Common problems

### Tech in Asia Jobs does not appear under Sources

- Select **Indonesia** as the country first. The source is hidden for other countries.
- Check `GET /api/techinasia/health` for runtime discovery or upstream errors.

### A city filter drops jobs

- Tech in Asia usually gives the city as `Jakarta` without a district, so a filter for `Jakarta` keeps those jobs, but a district filter such as `Jakarta Selatan` does not.
- With a narrow city filter, the scan limit (three times the result limit) can be reached before enough matching jobs are found.

### Tech in Asia temporarily fails

- A failed request is reported as a source error with its HTTP status only. Other sources in the same run continue.
- If one search term fails, jobs from the other terms are still imported.

## Related pages

- [Extractors Overview](/docs/next/extractors/overview)
- [Kalibrr](/docs/next/extractors/kalibrr)
- [Dealls](/docs/next/extractors/dealls)
- [Pipeline Run](/docs/next/features/pipeline-run)
