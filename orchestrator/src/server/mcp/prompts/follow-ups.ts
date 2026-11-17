import { definePrompt, promptIntArg } from "@server/mcp/kit";
import { z } from "zod";
import { daysBefore, playbookPreamble, toUnixSeconds } from "./common";

const MAX_TIMELINES = 30;

export const followUpsPrompt = definePrompt({
  name: "follow_ups",
  title: "Follow-ups",
  description:
    "Find applications with no movement for a number of days, draft a short follow-up for each (saved as notes, never sent), and propose stage or outcome updates for your approval.",
  input: z
    .object({
      days: promptIntArg({
        min: 1,
        max: 90,
        default: 7,
        description:
          "Days without movement before an application counts as quiet.",
      }),
    })
    .strict(),
  render: ({ days }, context) => {
    const cutoff = daysBefore(context.now, days);
    return `# Follow-ups

Goal: make sure no application the owner cares about goes quiet unnoticed. Find applications with no movement for ${days} days or more, draft a short follow-up for each, and propose stage or outcome updates. The owner sends the messages and approves the updates; you change nothing on an application's timeline without their yes.

Done looks like: a ranked list of quiet applications, a saved draft for each one worth chasing, and a numbered list of proposed updates waiting for the owner's answer. Budget: about 50 tool calls, timelines for at most ${MAX_TIMELINES} applications.

Quiet means the last movement was before ${cutoff} (unix time ${toUnixSeconds(cutoff)}).

${playbookPreamble(context)}

## Steps

1. Inbox first: \`list_inbox_items(limit: 50)\`. Pending items are recruiter emails JobOps matched to jobs (invites, rejections, offers) that may already show movement. Do not resolve them yourself: list each under "Inbox to review" with its suggested job and stage change, and do not draft a follow-up to a company that has just replied. If no mailbox is connected the list is empty or the call fails; move on.

2. Open applications: \`list_jobs(statuses: ["applied", "in_progress"], sort: "updated_desc", limit: 100)\`, then further pages with \`offset\` set to \`nextOffset\` while \`hasMore\` is true, up to 300 jobs. Leave out jobs that have an \`outcome\` (closed).

3. Last movement. For each open application, oldest \`appliedAt\` first and at most ${MAX_TIMELINES}, call \`get_job_timeline(jobId: "<id>")\`. The last movement is the later of the newest event's \`occurredAt\` (unix seconds) and \`appliedAt\`. Note the current stage (the newest event's \`toStage\`), how many "Follow-up sent" events the stage already has, and any open \`follow_up\` tasks. Applications whose last movement is before the cutoff are quiet. If more than ${MAX_TIMELINES} applications are open, say how many you did not check.

4. Decide for each quiet application:
   - Follow up, when fewer than two follow-ups were sent for the current stage: a polite message of at most 120 words to the recruiter or contact (from the notes or timeline, otherwise [Name]) with the role and when the owner applied, one sentence on a relevant strength taken from the profile (call \`get_profile\` once if you need it; facts only), and a simple question about the status or next steps. Write it in the posting's language (Indonesian for an Indonesian posting, otherwise English). Friendly, not pushy.
   - Propose an update instead when the facts support it: \`set_job_outcome(jobId: "<id>", outcome: "no_response")\` after about 30 days in \`applied\` with two follow-ups and no reply; \`ghosted\` when silence follows an interview; or a stage change the inbox or notes show already happened, such as \`transition_job_stage(jobId: "<id>", toStage: "recruiter_screen")\`.
   Rank target companies (\`isTargetCompany\`) and later stages first, since an interview going quiet matters more than a fresh application, then the longest quiet.

5. Save each draft (write): \`add_job_note(jobId: "<id>", title: "Follow-up draft — YYYY-MM-DD", content: "<the draft>")\`. Check \`list_job_notes(jobId: "<id>")\` first; if a follow-up draft from the last ${days} days exists, update it with \`update_job_note\` instead of adding another.

## Report and ask

- A table: job (link to its JobOps page), employer, stage, days quiet, follow-ups sent so far, proposed action.
- The drafts, each with the placeholders to fill.
- Inbox to review, if any.
- Proposed updates as a numbered list, asking which to apply.

Apply only the updates the owner approves (write), with \`set_job_outcome\` or \`transition_job_stage\`. When the owner says they sent a follow-up, record it so the next check counts from that day: \`transition_job_stage(jobId: "<id>", toStage: "no_change", eventType: "note", eventLabel: "Follow-up sent", note: "<channel and recipient>")\`.`;
  },
});
