import { definePrompt, promptIntArg } from "@server/mcp/kit";
import { z } from "zod";
import { daysBefore, playbookPreamble } from "./common";

const MAX_SUGGESTIONS = 6;

export const weeklyReviewPrompt = definePrompt({
  name: "weekly_review",
  title: "Weekly review",
  description:
    "Review the job search over a period: funnel numbers, what is working by source and by role, and specific changes to search terms, sources and target companies, applied only after you approve them.",
  input: z
    .object({
      periodDays: promptIntArg({
        min: 1,
        max: 90,
        default: 7,
        description: "Length of the period to review, in days.",
      }),
    })
    .strict(),
  render: ({ periodDays }, context) => {
    const since = daysBefore(context.now, periodDays);
    return `# Weekly review

Goal: show the owner how the job search went over the last ${periodDays} days and suggest a few specific changes, so the next runs find better jobs and the owner's limited time goes to the right applications. Settings stay as they are until the owner picks which suggestions to apply.

Done looks like: funnel numbers, what is working by source and by role, up to ${MAX_SUGGESTIONS} suggestions each backed by numbers, and the chosen ones applied. Budget: about 40 tool calls; no tool that calls the AI model or searches job sites.

The period starts at ${since}.

${playbookPreamble(context)}

## Gather

1. Totals by status, all time: \`get_job_counts\`.
2. Jobs found in the period (a cohort; read \`total\` from each call):
   - found: \`list_jobs(discoveredSince: "${since}", limit: 1)\`;
   - scored 70 or more: \`list_jobs(discoveredSince: "${since}", minScore: 70, limit: 1)\`;
   - prepared, meaning a resume PDF exists whatever the job's status is now: \`list_jobs(discoveredSince: "${since}", hasPdf: true, limit: 1)\`;
   - applied: \`list_jobs(discoveredSince: "${since}", statuses: ["applied", "in_progress"], limit: 1)\`;
   - interviewing: \`list_jobs(discoveredSince: "${since}", statuses: ["in_progress"], limit: 100)\`, counting only jobs whose \`outcome\` is null (a closed application keeps status \`in_progress\`);
   - skipped: \`list_jobs(discoveredSince: "${since}", statuses: ["skipped"], limit: 1)\`.
3. Applications and outcomes: \`list_jobs(statuses: ["applied", "in_progress"], sort: "updated_desc", limit: 100)\`, with more pages while \`hasMore\` is true. Count applications whose \`appliedAt\` falls in the period (they may be for jobs found earlier) and group the \`outcome\` values (status alone does not tell an open application from a closed one): \`offer_accepted\` and \`offer_declined\` are offers, then \`rejected\`, \`withdrawn\`, \`no_response\` and \`ghosted\`; null means still open. An offer that is still open shows only as the \`offer\` stage in \`get_job_timeline\`; check timelines only for the \`in_progress\` jobs and only if there are 10 or fewer, otherwise report open offers as not available.
4. Runs: \`list_pipeline_runs(limit: 20)\`. For runs started in the period: status, \`jobsDiscovered\` and any \`errorMessage\`. For the latest completed run, \`get_pipeline_run(runId: "<id>")\` shows the sources and search terms it used.
5. Jobs for the breakdown: \`list_jobs(discoveredSince: "${since}", sort: "score_desc", limit: 100)\` and further pages while \`hasMore\` is true, up to 300 jobs.
6. The current search: \`get_settings(keys: ["searchTerms", "searchCities", "targetCompanies", "dealbreakers", "blockedCompanyKeywords"])\` and \`list_search_presets(limit: 5)\`.

## Analyse

- Funnel for the jobs found in the period: found, scored 70 or more, prepared, applied, interviewing, with the count at each step and the conversion between steps; then offers and other outcomes from step 3. When a number cannot be computed from the tools, write "not available" instead of estimating it.
- By source (\`source\`): jobs found, median score, share scoring 70 or more, skipped, applied. Name sources that found nothing useful and sources that failed in runs.
- By role family, grouped from titles (backend, frontend, mobile, data, machine learning, infrastructure, QA, other engineering, not engineering): the same numbers. Many non-engineering or senior titles mean the search terms are too broad.
- Target companies: jobs found at them (\`isTargetCompany\`) and applications sent, and target companies with no jobs found at all (they may need another name variant or a source that covers them).
- Effort: jobs prepared but not applied to after a week suggest preparing fewer per day; applications to low-scoring jobs suggest a higher minimum score in daily triage.
Use only numbers you actually computed, and say when a group is too small to conclude anything (fewer than about 10 jobs).

## Suggest

Up to ${MAX_SUGGESTIONS} changes. For each: the evidence (numbers), the exact change, and the effect you expect. Typical kinds:
- search terms to add, drop or narrow: \`update_settings(updates: { "searchTerms": ["<term>", "<term>"] })\`; the next run uses them;
- sources for the next runs: check \`list_sources\` for sources that support the owner's country, then save them in a search with \`save_search_preset\` or pass \`sources\` to the next \`start_pipeline_run\`;
- target companies to add (employers that keep scoring well) or name variants to add, in \`targetCompanies\`;
- dealbreakers or \`blockedCompanyKeywords\` that would have caught jobs the owner keeps skipping;
- habits: a different \`minScore\` or \`prepareLimit\` for the \`daily_triage\` playbook, or running the \`follow_ups\` playbook for quiet applications.
Do not suggest changing the AI provider, API keys, webhooks or backups. If a run failed because of one of those, tell the owner to fix it in the JobOps web app.

## Report and apply

Give the funnel as a small table, two or three sentences on what is working and what is not, then the suggestions as a numbered list, and ask which ones to apply. Apply only those the owner picks (write), with \`update_settings\` or \`save_search_preset\`, then read the changed settings back with \`get_settings\` and confirm what changed. Report any \`FORBIDDEN\` answer as it is: some settings can only be changed in the web app, and users who are not admins can change only search settings.`;
  },
});
