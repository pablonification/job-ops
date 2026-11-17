import { definePrompt, promptIntArg } from "@server/mcp/kit";
import { z } from "zod";
import { daysBefore, hoursBefore, playbookPreamble } from "./common";

/** A run that started longer ago than this is stale. */
const STALE_RUN_HOURS = 20;
/** "New" jobs: discovered within this many days. */
const NEW_JOB_WINDOW_DAYS = 7;
const MAX_JOBS_READ = 25;
const MAX_SKIPS_WITHOUT_ASKING = 5;

export const dailyTriagePrompt = definePrompt({
  name: "daily_triage",
  title: "Daily triage",
  description:
    "Make sure discovery ran in the last day, review new high-score and target-company jobs, skip clear mismatches with a reason note, prepare the best few (Role CV match, tailored CV, PDF), and report a short ranked list with links and what needs your decision.",
  input: z
    .object({
      prepareLimit: promptIntArg({
        min: 1,
        max: 10,
        default: 3,
        description: "How many jobs to prepare (tailor and render a PDF).",
      }),
      minScore: promptIntArg({
        min: 0,
        max: 100,
        default: 70,
        description: "Lowest suitability score worth a look.",
      }),
    })
    .strict(),
  render: ({ prepareLimit, minScore }, context) => {
    const staleBefore = hoursBefore(context.now, STALE_RUN_HOURS);
    const since = daysBefore(context.now, NEW_JOB_WINDOW_DAYS);
    return `# Daily triage

Goal: help the owner, who has little free time, spend today's job-search minutes well. Make sure discovery ran recently, sort the new jobs into prepare, owner-decides and skip, get tailored CVs ready for the best ${prepareLimit}, and finish with a short ranked list the owner can act on in a few minutes.

Done looks like: no clear mismatch left among the new jobs, at most ${prepareLimit} jobs newly prepared (tailored, with a PDF), and the report below. Budget: about 60 tool calls, at most ${MAX_JOBS_READ} job descriptions read, and model work only for one discovery run and the jobs you prepare. When you reach the budget, stop and say what is left.

${playbookPreamble(context)}

## Steps

1. Check the setup. Call \`get_app_status\`. If \`profile.configured\` is false, stop: tell the owner that scoring and tailoring need a master resume, which they set up in the JobOps web app (Design Resume, or a Reactive Resume base resume in Settings). Then call \`get_settings(keys: ["targetCompanies", "dealbreakers", "searchTerms"])\` and keep the target companies and dealbreakers in mind.

2. Make sure discovery is fresh. Call \`get_pipeline_status\`.
   - If \`isRunning\` is true, a run is already going: go to step 3 and do not start another.
   - Otherwise look at \`lastRun\`. If it is null, or its \`startedAt\` is before ${staleBefore}, start a run (write) with \`start_pipeline_run()\` and no arguments, so it uses the owner's saved search. Do not pass \`searchTerms\` unless the owner asked: they are saved as the new defaults. A \`CONFLICT\` answer means a run is already active, so poll it. An \`INVALID_REQUEST\` about sources means the saved search does not fit the location: report it, do not edit the search, and continue with the jobs already in JobOps.
   - If the last run is recent, go to step 4. If its \`status\` is failed, quote its \`errorMessage\` in the report.

3. Wait for the run. Poll \`get_pipeline_progress\` until \`step\` is completed, cancelled or failed. Wait 15-30 seconds between polls if you have a way to wait (such as a shell sleep); otherwise work on step 4 with the jobs already in JobOps between polls. Stop waiting after about 20 minutes or 40 polls, continue with what is there, and say so in the report. If \`paused\` is true, read \`actionRequired\`:
   - kind \`challenge\`: a job site wants a bot check that only a person can solve. Tell the owner now, passing on \`actionRequired.message\`, and keep going with the jobs already in JobOps. Do not cancel the run.
   - kind \`llm_configuration\`: no AI model is configured. Ask the owner to set the AI provider in the JobOps web app (Settings). Call \`resume_pipeline_scoring\` (write) only after they confirm. Model steps below fail until then, so skip step 6.

4. Collect candidates. New means discovered since ${since}.
   - High scores: \`list_jobs(statuses: ["discovered"], minScore: ${minScore}, discoveredSince: "${since}", sort: "score_desc", limit: 30)\`.
   - Target companies at any score, unscored included: \`list_jobs(statuses: ["discovered"], targetCompany: true, discoveredSince: "${since}", sort: "score_desc", limit: 30)\`.
   - Already prepared and waiting for the owner to apply: \`list_jobs(statuses: ["ready"], sort: "score_desc", limit: 20)\`.
   Merge the first two lists without duplicates, best first, with target companies (\`isTargetCompany\`) ahead at similar fit. If all three lists are empty, say so, suggest the \`weekly_review\` playbook to tune the search, and stop.

5. Decide on each candidate, best first, reading at most ${MAX_JOBS_READ}: \`get_job(jobId: "<id>", descriptionMaxChars: 4000)\` gives the score reason and the description. Put each job in one group:
   - Clear mismatch: not a software engineering role; asks for years of experience or a senior, lead or manager level the owner's profile does not have; a location or work arrangement the owner cannot do; a dealbreaker; or the posting is closed. Skip it (write): first \`add_job_note(jobId: "<id>", title: "Skipped — YYYY-MM-DD", content: "<one-line reason>")\`, then \`skip_job(jobId: "<id>")\`. Skip at most ${MAX_SKIPS_WITHOUT_ASKING} jobs this way; list further mismatches under proposed skips for the owner instead.
   - Prepare: a real fit for the owner's level and interests, with no blocking gap.
   - Owner decides: anything you are unsure about. Leave it as it is and write down the open question.
   Judge fit from the description and the profile, not from the score alone; the score can be wrong in both directions. When you call a job a mismatch, name the requirement that rules it out.

6. Prepare the best ${prepareLimit} jobs from the Prepare group (write), one job at a time:
   - Once, call \`list_role_cvs\`. If the owner has Role CVs with \`hasContent\` true, call \`match_job_role_cv(jobId: "<id>")\` for each job you prepare and note the chosen Role CV's name (\`roleCv\` null means none fits).
   - \`process_job(jobId: "<id>")\` tailors the CV (starting from the matched Role CV when the owner's settings use Role CVs), renders the PDF and moves the job to ready. It can take a minute.
   - \`get_job_pdf_link(jobId: "<id>")\` gives the PDF link for the report.
   - If a model tool fails with \`UPSTREAM_ERROR\`, stop preparing and report the error; do not try the remaining jobs. A \`CONFLICT\` means the job is busy: leave it for the next triage.
   Never prepare more than ${prepareLimit} jobs in this run, however many look good; list the rest under Owner decides.

## Report

Keep it short; the owner may read it on a phone. In this order:
1. Discovery: whether a run was started and what it found (\`jobsDiscovered\`), or why it did not run.
2. Ready to apply, ranked, jobs prepared today first and then older ready jobs: title — employer (★ for a target company), score, one line on why it made the list, the Role CV used, and links to the JobOps page, the posting and the PDF. The owner reviews the CV and applies through the posting; once they tell you they applied, record it with \`mark_job_applied(jobId: "<id>")\`.
3. Owner decides: each job with the question to answer, plus any proposed skips.
4. Skipped today: how many, with the one-line reasons.
5. Not done: candidates you did not read, steps that failed or were skipped (including write steps with a read-only token), and why.`;
  },
});
