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
- Salary is imported only when Tech in Asia shows it and the amount is above zero (for example `IDR 7,000,000–10,000,000 / month`).
- Job links point to `https://www.techinasia.com/jobs/<id>`. When the employer uses an external application page, the apply link points there.
- Every job carries the country Indonesia in its location (for example `Jakarta, Jakarta Raya, Indonesia`), so the shared country and city filter keeps it.

## Common problems

### Tech in Asia Jobs does not appear under Sources

- Select **Indonesia** as the country first. The source is hidden for other countries.
- Check `GET /api/techinasia/health` for runtime discovery or upstream errors.

### A city filter drops jobs

- Cities are matched by name. Tech in Asia usually gives the city as `Jakarta`, so a filter for `Jakarta` keeps those jobs, but a narrower filter such as `Jakarta Selatan` does not.

### Tech in Asia temporarily fails

- A failed request is reported as a source error with its HTTP status only. Other sources in the same run continue.
- If one search term fails, jobs from the other terms are still imported.

## Related pages

- [Extractors Overview](/docs/next/extractors/overview)
- [Kalibrr](/docs/next/extractors/kalibrr)
- [Dealls](/docs/next/extractors/dealls)
- [Pipeline Run](/docs/next/features/pipeline-run)
