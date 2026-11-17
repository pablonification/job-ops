---
id: target-companies
title: Target Companies and Dealbreakers
description: Flag jobs at the companies you most want to join, favour them in scoring, and score jobs that break your dealbreakers low.
sidebar_position: 6
---

## What it is

Two settings in **Settings → Scoring Settings**:

- **Target companies**: the employers you most want to join. Jobs at these companies get a **Target** badge in the jobs list, can be filtered with the **Target companies** filter, and get a small lift in scoring when the fit is otherwise close.
- **Dealbreakers**: things you will not accept, written in plain words. Scoring gives jobs that clearly break one a low score and names the dealbreaker in the score reason.

Both start empty. While they are empty, scoring works exactly as before.

## Why it exists

When time is short, the jobs you care most about should come first and the ones you would never take should sink. Writing your priorities once is faster than checking every listing by hand.

## How to use it

1. Open **Settings → Scoring Settings**.
2. In **Target companies**, write one company per line. Put other names for the same company on the same line, separated by `|`:

   ```text
   GoTo | Gojek | Tokopedia
   Grab
   TikTok
   Shopee | Sea
   Traveloka
   tiket.com
   Blibli
   Xendit
   ```

3. In **Dealbreakers**, write what you will not accept, for example:

   ```text
   Unpaid roles
   On-site outside Jakarta
   More than 2 years of experience required
   ```

4. Click **Save**.
5. On the jobs page, open **Filters** and switch on **Target companies** to see only those jobs.

The Target badge and filter use your current list every time the jobs list loads, so changes apply straight away to jobs you already have. Scores change only when a job is scored again.

### How company names match

- Case, accents and punctuation do not matter.
- Legal and regional words around a name are ignored: `PT`, `Tbk`, `Pte Ltd`, `Inc`, `Holdings`, `Group`, `Indonesia`, and similar. `PT Shopee International Indonesia` matches `Shopee`.
- Website endings are ignored: `tiket.com` matches the employer `PT Global Tiket Network`.
- Names match whole words only. `Grab` matches `GrabTaxi Holdings` (a capital letter starts a new word) but not `Grabango` or `Telegraph`. `Sea` does not match `Research`.
- Spaces inside a name do not matter: `GoTo` matches `Go To`.
- All names on one line count as the same company. The badge and the scoring prompt use the first name.

### How scoring uses them

The default scoring prompt has two placeholders, `{{targetCompaniesSection}}` and `{{dealbreakersSection}}`. When a setting is filled in, its placeholder becomes a short block of instructions:

- Target companies: the list, whether this job's employer is on it, and an instruction to favour a target company only when fit is otherwise comparable (a tie-breaker worth a few points, never a reason to score a poor fit highly).
- Dealbreakers: your text, and an instruction to score a job that clearly breaks one at 20 or lower and name the dealbreaker in the reason. Missing or unclear information does not count as a violation.

If you use a custom scoring prompt without these placeholders, JobOps adds the blocks after your template, so they are never dropped. See [Settings → Prompt Templates](/docs/features/settings#prompt-templates).

### Agent access

The `list_jobs` tool returns `isTargetCompany` for each job and takes a `targetCompany` filter (`true` or `false`). `get_job` also returns `isTargetCompany`. See [Agent Access](/docs/features/agent-access).

## Common problems

### A job at a target company has no badge

- Check how the employer is written on the job. Add that name to the company's line, for example `tiket.com | Global Tiket Network`.
- A name you type made only of legal or regional words (`PT`, `Holdings`, `Indonesia`) is ignored.

### A job is flagged that should not be

- Short names match any employer containing them as a whole word. Use a longer name, for example `Sea Limited` instead of `Sea`.

### Scores did not change after editing the lists

- Existing scores are not recalculated. Rescore the job from its job page, or wait for the next pipeline run to score new jobs.

## Related pages

- [Settings](/docs/features/settings)
- [Orchestrator](/docs/features/orchestrator)
- [Pipeline Run](/docs/features/pipeline-run)
- [Agent Access](/docs/features/agent-access)
