---
id: kalibrr
title: Kalibrr Extractor
description: Indonesia-only job discovery from Kalibrr through its public job board search API, with stricter keyword matching.
sidebar_position: 13
---

## What it is

Original website: [Kalibrr](https://www.kalibrr.com/)

This extractor searches Kalibrr's public job board search (`GET /kjs/job_board/search`) for jobs in Indonesia and maps them into job-ops with the full description and qualifications, salary when published, and Indonesian location evidence. No account or API key is required.

## Why it exists

Kalibrr is a large Indonesian job board with many tech and graduate roles. The search results already contain the full job text, so no extra request per job is needed.

## How to use it

1. Open **Run jobs** and choose **Automatic**.
2. Set the country to **Indonesia**. Kalibrr only appears under **Sources** when Indonesia is selected.
3. Enable **Kalibrr**.
4. Set search terms, optional cities, and the usual result limit.
5. Start the run.

Defaults and constraints:

- Each search term is sent separately with the country filter `Indonesia`.
- Kalibrr's own keyword matching is loose (a "Tax & Audit Staff" job can rank first for "software engineer"). job-ops therefore keeps a job only when its **title** contains every significant word of the search term; the description is not used. Separators are ignored (`back-end` = `backend` = `back end`) and common tech-role words count as the same word: engineer/developer/programmer, go/golang, SRE/site reliability, QA/quality assurance/test, frontend/FE, backend/BE, fullstack, DevOps, ML/machine learning, PM/product manager. In a search term, `software engineer` (or developer/programmer) means any software engineering title, but not engineers from other fields (Project, Civil, Mechanical, Electrical, Maintenance, Sales and similar) or management titles. Levels match by family: `intern` also matches Internship, Magang and Trainee; `new grad` also matches Fresh Graduate and Entry Level; `junior` also matches Associate. `mobile` also matches Android, iOS and Flutter titles. The full rules are on the [Indonesia Big Tech](/docs/next/extractors/idbigtech) page.
- Results are fetched 20 per page, with a pause of about 1.5 seconds between requests and a browser-like user agent.
- The result limit (`jobspyResultsWanted`) caps kept jobs per search term, up to 200. Because some results are dropped, at most three times that many results are scanned per term.
- Cities: each selected city is sent to Kalibrr's `location` filter. Jakarta districts and South Tangerang are sent as their city (`Jakarta`, `Tangerang`), because Kalibrr labels districts both in English and in Indonesian; job-ops then keeps only jobs in the selected district.
- City names are matched across English and Indonesian forms for the Jakarta districts (`South Jakarta` = `Jakarta Selatan` = `Jaksel`, and so on), South Tangerang, Yogyakarta (`Jogja`) and Surakarta (`Solo`). A city filter keeps jobs in that city or inside it: `Jakarta` keeps every Jakarta district, but `Jakarta Selatan` does not keep a job listed only as `Jakarta`.
- Paging stops early when a page holds only jobs that an earlier search term already returned.
- A run stops starting new requests after 8 minutes (the pipeline allows 10 per source) and keeps the jobs collected so far; the run then lists a source error saying it was cut short.
- Salary is imported only when Kalibrr shows it.
- Job links point to `https://www.kalibrr.com/c/<company>/jobs/<id>` (without the title slug, so the link stays the same when the employer edits the title). When the employer redirects applications elsewhere, the apply link points there.
- Every job carries the country Indonesia in its location (for example `Central Jakarta, DKI Jakarta, Indonesia`).

## Common problems

### Kalibrr does not appear under Sources

- Select **Indonesia** as the country first.
- Check `GET /api/kalibrr/health` for runtime discovery or upstream errors.

### A run returns fewer jobs than Kalibrr shows on its website

- The title check drops results whose title does not contain every word of the search term. Use shorter terms (for example `backend` instead of `backend engineer golang`), or add several terms.

### A city filter drops jobs

- Jobs listed only as `Jakarta` (without a district) are dropped by a district filter such as `Jakarta Selatan`. Use `Jakarta` to keep all of them.

### Kalibrr temporarily fails

- A failed request is reported as a source error with its HTTP status only. Other sources in the same run continue.

## Related pages

- [Extractors Overview](/docs/next/extractors/overview)
- [Tech in Asia Jobs](/docs/next/extractors/techinasia)
- [Dealls](/docs/next/extractors/dealls)
- [Pipeline Run](/docs/next/features/pipeline-run)
