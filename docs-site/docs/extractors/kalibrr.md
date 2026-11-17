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
- Kalibrr's own keyword matching is loose (a "Tax & Audit Staff" job can rank first for "software engineer"). job-ops therefore keeps a job only when every significant word of the search term appears in its title, description, or qualifications. Words of three letters or fewer (such as `go` or `qa`) must match a whole word; longer words also match longer forms (`engineer` matches `engineering`).
- Results are fetched 20 per page, with a pause of about 1.5 seconds between requests and a browser-like user agent.
- The result limit (`jobspyResultsWanted`) caps kept jobs per search term, up to 200. Because some results are dropped, at most twice that many results are scanned per term.
- Salary is imported only when Kalibrr shows it.
- Job links point to `https://www.kalibrr.com/c/<company>/jobs/<id>/<slug>`. When the employer redirects applications elsewhere, the apply link points there.
- Every job carries the country Indonesia in its location (for example `Central Jakarta, DKI Jakarta, Indonesia`).

## Common problems

### Kalibrr does not appear under Sources

- Select **Indonesia** as the country first.
- Check `GET /api/kalibrr/health` for runtime discovery or upstream errors.

### A run returns fewer jobs than Kalibrr shows on its website

- The stricter keyword check drops results that do not mention every word of the search term. Use shorter or more common terms, or add several terms.

### A city filter drops jobs

- Kalibrr uses English district names such as `Central Jakarta` and `South Jakarta`. A filter for `Jakarta` keeps them; a filter for `Jakarta Selatan` does not match `South Jakarta`.

### Kalibrr temporarily fails

- A failed request is reported as a source error with its HTTP status only. Other sources in the same run continue.

## Related pages

- [Extractors Overview](/docs/next/extractors/overview)
- [Tech in Asia Jobs](/docs/next/extractors/techinasia)
- [Dealls](/docs/next/extractors/dealls)
- [Pipeline Run](/docs/next/features/pipeline-run)
