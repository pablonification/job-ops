---
id: jobstreet
title: JobStreet Extractor
description: Indonesia-only job discovery from JobStreet Indonesia through the site's job search API and job detail call.
sidebar_position: 16
---

## What it is

Original website: [JobStreet Indonesia](https://id.jobstreet.com)

This extractor searches JobStreet Indonesia the way its own website does (`GET https://id.jobstreet.com/api/jobsearch/v5/search`), newest jobs first, and then requests each new job's full description through the site's job detail call (`POST https://id.jobstreet.com/graphql`). No account or API key is required. Only the Indonesian site (`id.jobstreet.com`) is supported.

:::caution Personal, low-volume use only

JobStreet's `robots.txt` disallows both paths this extractor uses (`/api/jobsearch/` and `/graphql`). The source is meant for personal, low-volume use: a few search terms and a modest result limit, run once or twice a day. It sends one request at a time with a pause between requests. Do not use it for bulk collection.

:::

## Why it exists

JobStreet is one of the largest job boards in Indonesia, with thousands of software roles, many of them with a published rupiah salary range.

## How to use it

1. Open **Run jobs** and choose **Automatic**.
2. Set the country to **Indonesia**. JobStreet only appears under **Sources** when Indonesia is selected.
3. Enable **JobStreet**.
4. Set search terms, optional cities, workplace types, and the usual result limit.
5. Start the run.

Defaults and constraints:

- Each search term is sent separately, sorted by listing date (newest first).
- Sorting by date makes JobStreet's keyword match loose: a search for `software engineer` also returns jobs such as `Drafter` or `Project Test Manager`. job-ops keeps only jobs whose title matches the search term, using the same title check as Kalibrr (levels such as intern, graduate or junior must appear in the title, and `developer`, `programmer` and `engineer` count as the same role). A posting whose JobStreet work type says internship counts as an internship even when its title does not.
- Search results only include a short teaser, so job-ops makes one detail request per new job to import the full description. Jobs whose link is already in job-ops skip the detail request. A job whose detail request fails is not imported; the next run requests it again.
- Requests are sent one at a time with a pause of about 1.5 seconds between them and a browser-like user agent. Results are fetched 20 per page.
- The result limit (`jobspyResultsWanted`) caps jobs per search term, up to 200. With a high limit a run can take several minutes because of the detail requests. At most three times the limit is scanned per term, across all selected cities together.
- Cities: each selected city is sent to JobStreet's location filter as its base city (`Jakarta Selatan` and `South Jakarta` are sent as `Jakarta`, `Tangerang Selatan` as `Tangerang`), then job-ops keeps only jobs in the city you asked for before they count toward the limit. City names are matched across English and Indonesian forms (`South Jakarta` = `Jakarta Selatan`).
- With several cities, the limit and the scan bound are split evenly between them, so the first city cannot fill the limit before the others are searched. A city that runs out of matching jobs hands its unused share to the others.
- JobStreet searches around a city (about 50 km), so a `Tangerang` search also returns many Jakarta jobs; job-ops drops those when you only asked for Tangerang.
- If JobStreet does not recognise a city name, it returns no jobs for it. job-ops then lists a source note naming the city instead of reporting the term as empty. Try the city's usual English or Indonesian name.
- Workplace types: when you choose fewer than all three (remote, hybrid, on-site), the choice is sent to JobStreet's work-arrangement filter. With all three selected no filter is sent.
- JobStreet has no "posted within" setting in job-ops today, so no date filter is sent; newest-first sorting and the result limit keep runs to recent jobs.
- Salaries: labels in the usual `Rp 20.000.000 – Rp 30.000.000 per month` form (dots or commas as thousands separators, with or without an upper bound) are imported as rupiah amounts with an interval, shown as `IDR 20,000,000–30,000,000 / month`. Any other label is kept as text.
- Expired jobs are skipped, and so are results located outside Indonesia.
- Job links point to `https://id.jobstreet.com/job/<id>`, without tracking parameters, so the same job keeps the same link across runs.
- JobStreet often gives only a city and province, such as `South Jakarta, Jakarta`. job-ops adds the country (`South Jakarta, Jakarta, Indonesia`), so the shared country and city filter keeps the job.
- A run stops starting new requests after 8 minutes (the pipeline allows 10 per source) and keeps the jobs collected so far; the run then lists a source error saying it was cut short. The 8 minutes are shared fairly between search terms: each term may use at most the time left divided by the terms left, so every term gets a turn. A term that uses up its share stops with a source note and the next term starts; time a quick term leaves unused goes to the later ones.

## Common problems

### JobStreet does not appear under Sources

- Select **Indonesia** as the country first.
- Check `GET /api/jobstreet/health` for runtime discovery or upstream errors.

### JobStreet reports failed detail requests

- When a detail request fails, that job is not imported and the run lists a JobStreet source error. The next run requests it again.

### JobStreet returns fewer jobs than the result limit

- Jobs whose title does not match the search term, and jobs outside the selected cities, are dropped. Scanning stops at three times the limit per term. Use more specific search terms, or add cities to the location filter.

### JobStreet temporarily fails

- A failed search request is reported as a source error with its HTTP status only. Other search terms and other sources in the same run continue.
- JobStreet does not publish this API. If the site changes it, the source fails with an invalid-response error until the extractor is updated.

## Related pages

- [Extractors Overview](/docs/next/extractors/overview)
- [Glints](/docs/next/extractors/glints)
- [Kalibrr](/docs/next/extractors/kalibrr)
- [Dealls](/docs/next/extractors/dealls)
- [Pipeline Run](/docs/next/features/pipeline-run)
