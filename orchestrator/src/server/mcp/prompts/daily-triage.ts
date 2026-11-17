import { definePrompt, promptIntArg } from "@server/mcp/kit";
import { z } from "zod";
import { daysBefore, hoursBefore, playbookPreamble } from "./common";

/** A run that started longer ago than this is stale. */
const STALE_RUN_HOURS = 20;
/** "New" jobs: discovered within this many days. */
const NEW_JOB_WINDOW_DAYS = 7;
/** A triage note younger than this means the job was already reviewed. */
const TRIAGE_NOTE_FRESH_DAYS = 3;
const MAX_CANDIDATES = 25;
const MAX_JOBS_READ = 20;
const MAX_SKIPS_WITHOUT_ASKING = 5;
const MAX_POLLS = 40;
/** Jobs the discovery run itself may tailor (the playbook prepares the rest). */
const RUN_TOP_N = 1;

/** Tool calls outside polling, for a given number of jobs to prepare. */
function callBudget(prepareLimit: number): number {
  const setup = 8; // status, settings, presets, run start, three lists, Role CVs
  const noteChecks = MAX_CANDIDATES;
  const reads = MAX_JOBS_READ;
  const skips = 2 * MAX_SKIPS_WITHOUT_ASKING;
  const triageNotes = 10;
  const perPrepared = 3; // process_job, get_job, get_job_pdf_link
  return (
    setup +
    noteChecks +
    reads +
    skips +
    triageNotes +
    perPrepared * prepareLimit
  );
}

export const dailyTriagePrompt = definePrompt({
  name: "daily_triage",
  title: "Daily triage",
  description:
    "Make sure discovery ran in the last day, review new high-score and target-company jobs, skip clear mismatches with a reason note, prepare the best few (tailored CV and PDF, from a Role CV when your settings use them), and report a short ranked list with links and what needs your decision.",
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

Done looks like: no clear mismatch left among the new jobs, at most ${prepareLimit} jobs newly prepared (tailored, with a PDF), every job you reviewed marked with a note, and the report below.

Budget, so the run stays cheap and predictable:
- Polling a discovery run: at most ${MAX_POLLS} calls to \`get_pipeline_progress\` (about 20 minutes). Polls do not count toward the limit below.
- Everything else: at most ${callBudget(prepareLimit)} tool calls. That covers checking at most ${MAX_CANDIDATES} candidates for earlier triage notes, reading at most ${MAX_JOBS_READ} job descriptions, at most ${MAX_SKIPS_WITHOUT_ASKING} skips, one triage note per job left for the owner, and three calls per prepared job.
- Model work: a discovery run scores every job it imports and tailors at most ${RUN_TOP_N} itself; on top of that, only the ${prepareLimit} jobs you prepare.
When you reach a limit, stop and say in the report what is left.

${playbookPreamble(context)}

## Steps

1. Check the setup. Call \`get_app_status\`. If \`profile.configured\` is false, stop: tell the owner that scoring and tailoring need a master resume, which they set up in the JobOps web app (Design Resume, or a Reactive Resume base resume in Settings). Then call \`get_settings(keys: ["targetCompanies", "dealbreakers", "roleCvPipelineMode"])\` and keep the target companies and dealbreakers in mind. \`roleCvPipelineMode\` off means tailoring does not start from Role CVs.

2. Make sure discovery is fresh. Call \`get_pipeline_status\`.
   - If \`isRunning\` is true, a run is already going: go to step 3 and do not start another.
   - If \`lastRun\` is not null and its \`startedAt\` is after ${staleBefore}, discovery is fresh: go to step 4. If its \`status\` is failed, quote its \`errorMessage\` in the report.
   - Otherwise start a run (write) from the owner's saved search. Call \`list_search_presets(limit: 1)\`; the first preset is the most recently used one. If there is none, do not start a run: say in the report that no saved search exists and ask the owner to save one in the JobOps web app (run a search there and save it), then continue with step 4. If there is one, pass its \`config\` fields to \`start_pipeline_run\` explicitly: \`searchTerms\`, \`sources\`, \`country\`, \`cityLocations\`, \`proximity\`, \`workplaceTypes\`, \`searchScope\`, \`matchStrictness\`, \`minSuitabilityScore\`, \`runBudget\`, \`scoringInstructions\` and, when present, \`watchlistSelectedSourceIds\`, copied exactly; leave out \`locationMode\` and \`automaticPresetId\`, which the tool does not take. Set \`topN: ${RUN_TOP_N}\` instead of the preset's value, so the run tailors at most ${RUN_TOP_N} job itself. For example \`start_pipeline_run(searchTerms: ["<term>"], sources: ["<source>"], country: "<country>", cityLocations: ["<city>"], workplaceTypes: ["<type>"], searchScope: "<scope>", matchStrictness: "<strictness>", topN: ${RUN_TOP_N}, minSuitabilityScore: <preset value>, runBudget: <preset value>, scoringInstructions: "<text>")\`. Passing \`searchTerms\` also saves them as the owner's default search terms; that is expected, because they come from the owner's own saved search, but never pass terms the preset does not contain.
   - A \`CONFLICT\` answer means a run is already active, so poll it. An \`INVALID_REQUEST\` answer (a source not available or not fitting the location) means the saved search needs fixing: report the message, do not edit the search, and continue with the jobs already in JobOps.

3. Wait for the run. Poll \`get_pipeline_progress\` until \`step\` is completed, cancelled or failed. Wait 15-30 seconds between polls if you have a way to wait (such as a shell sleep); otherwise work on steps 4 and 5 with the jobs already in JobOps between polls. After ${MAX_POLLS} polls, stop waiting, continue with what is there, and say so in the report. If \`paused\` is true, read \`actionRequired\`:
   - kind \`challenge\`: a job site wants a bot check that only a person can solve. Tell the owner now, passing on \`actionRequired.message\`, and keep going with the jobs already in JobOps. Do not cancel the run.
   - kind \`llm_configuration\`: no AI model is configured. Ask the owner to set the AI provider in the JobOps web app (Settings). Call \`resume_pipeline_scoring\` (write) only after they confirm. Model steps below fail until then, so skip step 7.

4. Collect candidates. New means discovered since ${since}.
   - High scores: \`list_jobs(statuses: ["discovered"], minScore: ${minScore}, discoveredSince: "${since}", sort: "score_desc", limit: 30)\`.
   - Target companies at any score, unscored included: \`list_jobs(statuses: ["discovered"], targetCompany: true, discoveredSince: "${since}", sort: "score_desc", limit: 30)\`.
   - Already prepared and waiting for the owner to apply: \`list_jobs(statuses: ["ready"], sort: "score_desc", limit: 20)\`.
   Merge the first two lists without duplicates, best first, with target companies (\`isTargetCompany\`) ahead at similar fit, and keep the first ${MAX_CANDIDATES}. If all three lists are empty, say so, suggest the \`weekly_review\` playbook to tune the search, and stop.

5. Leave out jobs already reviewed. For each candidate, \`list_job_notes(jobId: "<id>", limit: 5, previewChars: 300)\`. A note titled "Triage — YYYY-MM-DD" from the last ${TRIAGE_NOTE_FRESH_DAYS} days whose recorded score equals the job's current \`score\` means the job was reviewed and nothing changed: do not read it again; carry it into Owner decides with the question from that note. Review the job again only when its score changed or the note is older.

6. Decide on the remaining candidates, best first, reading at most ${MAX_JOBS_READ}: \`get_job(jobId: "<id>", descriptionMaxChars: 4000)\` gives the score reason and the description. Put each job in one group:
   - Clear mismatch, only when one of these is plainly true: it is not a software engineering role; it requires (as a must-have, not "preferred") about three or more years of professional experience; its title is senior, staff, lead, principal or manager level; it needs a location or work arrangement the owner cannot do; it hits a dealbreaker; or the posting is closed. Intern, graduate, new-graduate, associate and junior roles, roles asking for 0-2 years, and roles that only prefer some experience are not mismatches on level. Skip a clear mismatch (write): first \`add_job_note(jobId: "<id>", title: "Skipped — YYYY-MM-DD", content: "<one-line reason naming the requirement>")\`, then \`skip_job(jobId: "<id>")\`. Skip at most ${MAX_SKIPS_WITHOUT_ASKING} jobs this way; list further mismatches under proposed skips for the owner instead.
   - Prepare: a real fit for the owner's level and interests, with no blocking gap.
   - Owner decides: anything you are unsure about, including any doubt about level. When in doubt, it goes here, not to Skip. Record it (write) so tomorrow's triage does not read it again: \`add_job_note(jobId: "<id>", title: "Triage — YYYY-MM-DD", content: "Owner decides (score <score>): <the open question>")\`.
   Judge fit from the description and the profile, not from the score alone; the score can be wrong in both directions.

7. Prepare the best ${prepareLimit} jobs from the Prepare group (write), one job at a time:
   - \`process_job(jobId: "<id>")\` tailors the CV, renders the PDF and moves the job to ready. It picks and uses a Role CV by itself when the owner's settings use Role CVs, and keeps one the owner chose by hand. It can take a minute.
   - Then \`get_job(jobId: "<id>", includeDescription: false)\`: its \`roleCvId\` is the Role CV the job uses (null means none). Call \`list_role_cvs\` once to turn ids into names. When \`roleCvPipelineMode\` is off, report the Role CV as none.
   - \`get_job_pdf_link(jobId: "<id>")\` gives the PDF link for the report.
   - If a model tool fails with \`UPSTREAM_ERROR\`, stop preparing and report the error; do not try the remaining jobs. A \`CONFLICT\` means the job is busy: leave it for the next triage.
   Never prepare more than ${prepareLimit} jobs in this run, however many look good; record the rest under Owner decides as in step 6.

## Report

Keep it short; the owner may read it on a phone. In this order:
1. Discovery: whether a run was started (and from which saved search) and what it found (\`jobsDiscovered\`), or why it did not run.
2. Ready to apply, ranked, jobs prepared today first and then older ready jobs: title — employer (★ for a target company), score, one line on why it made the list, the Role CV used or none, and links to the JobOps page, the posting and the PDF. The owner reviews the CV and applies through the posting; once they tell you they applied, record it with \`mark_job_applied(jobId: "<id>")\`.
3. Owner decides: each job with the question to answer (including ones carried over from earlier triage notes), plus any proposed skips.
4. Skipped today: how many, with the one-line reasons.
5. Not done: candidates you did not read, steps that failed or were skipped (including write steps with a read-only token), and why.`;
  },
});
