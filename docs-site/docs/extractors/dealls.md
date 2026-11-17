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
- Salaries are imported as monthly rupiah amounts (for example `IDR 3,000,000–4,000,000 / month`), matching how Dealls displays them.
- Jobs whose detail says they are closed are skipped.
- Job links point to `https://dealls.com/loker/<job>~<company>`. When the employer uses an external application page, the apply link points there.
- Dealls often gives only a city, such as `Jakarta Selatan`. job-ops adds the country (`Jakarta Selatan, Indonesia`), so the shared country and city filter keeps the job.

## Common problems

### Dealls does not appear under Sources

- Select **Indonesia** as the country first.
- Check `GET /api/dealls/health` for runtime discovery or upstream errors.

### Some Dealls jobs have no description

- When a detail request fails, the job is still imported from the search result without a description, and the run lists a Dealls source error. Later runs do not fetch it again because the job link is already known; open the job link to read the full posting.

### Dealls temporarily fails

- A failed search request is reported as a source error with its HTTP status only. Other sources in the same run continue.

## Related pages

- [Extractors Overview](/docs/next/extractors/overview)
- [Tech in Asia Jobs](/docs/next/extractors/techinasia)
- [Kalibrr](/docs/next/extractors/kalibrr)
- [Pipeline Run](/docs/next/features/pipeline-run)
