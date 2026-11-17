import { definePrompt, promptChoiceArg, promptJobIdArg } from "@server/mcp/kit";
import { z } from "zod";
import { playbookPreamble } from "./common";

const ROUND_VALUES = [
  "recruiter_screen",
  "assessment",
  "hiring_manager_screen",
  "technical_interview",
  "onsite",
  "all",
] as const;

type Round = (typeof ROUND_VALUES)[number];

const ROUND_LABELS: Record<Round, string> = {
  recruiter_screen: "the recruiter or HR screen",
  assessment: "the online assessment or take-home test",
  hiring_manager_screen: "the hiring manager or team-match conversation",
  technical_interview: "the technical interview",
  onsite: "the final round",
  all: "every round of the process",
};

export const interviewPrepPrompt = definePrompt({
  name: "interview_prep",
  title: "Interview prep",
  description:
    "Interview preparation for one job, saved as a note: company and role research, likely questions by round, STAR stories drawn only from your profile, and the gaps to be ready for.",
  input: z
    .object({
      jobId: promptJobIdArg(),
      round: promptChoiceArg({
        values: ROUND_VALUES,
        aliases: {
          recruiter: "recruiter_screen",
          hr: "recruiter_screen",
          screen: "recruiter_screen",
          test: "assessment",
          oa: "assessment",
          "take-home": "assessment",
          manager: "hiring_manager_screen",
          hm: "hiring_manager_screen",
          technical: "technical_interview",
          tech: "technical_interview",
          final: "onsite",
        },
        description:
          "Round to prepare for: recruiter_screen, assessment, hiring_manager_screen, technical_interview, onsite or all. Default: the next round after the job's current stage.",
      }),
    })
    .strict(),
  render: ({ jobId, round }, context) => {
    const id = JSON.stringify(jobId);
    const target = round
      ? ROUND_LABELS[round]
      : "the next round of this application";
    const roundStep = round
      ? `Prepare for ${ROUND_LABELS[round]}.`
      : "Prepare for the round after the latest stage: after `applied`, usually `recruiter_screen` or `assessment`; after `recruiter_screen`, usually `technical_interview`; after `technical_interview`, `hiring_manager_screen` or `onsite`. If the timeline or notes name the next round, use that. With no stage events at all, give a short overview of every round instead.";
    return `# Interview prep

Goal: get the owner ready for ${target} at the company behind job ${id} with as little prep time as possible: what the company and role are about, the questions they are likely to face, and true stories from their own background to answer them, saved as a note they can review just before the interview.

Done looks like: a note titled "Interview prep — <round> — YYYY-MM-DD" on the job with the parts below, under 15000 characters, and a short summary in the chat. Budget: about 12 tool calls and at most 6 web searches.

${playbookPreamble(context)}

## Gather

1. \`get_job(jobId: ${id})\`. If it returns \`NOT_FOUND\`, tell the owner and stop.
2. \`get_job_timeline(jobId: ${id})\`: the current stage (the newest event's \`toStage\`) and any interview dates or notes in the events. ${roundStep}
3. \`list_job_notes(jobId: ${id}, previewChars: 3000)\` for an evaluation, recruiter details or earlier prep. Build on earlier prep instead of repeating it.
4. \`get_profile(includeDetails: true)\`. If \`configured\` is false, stop and ask the owner to set up their master resume in the JobOps web app; stories cannot be written without it.
5. Web research, at most 6 searches, keeping every link: the company's products and news from the last 12 months; its engineering blog or tech stack; how it interviews for this kind of role and level, from its own careers pages first and then candidate reports (label those as anecdotal); and the values or principles it says it hires for.

## Write

1. Company and role in brief, at most 10 bullets: what they build, what this team probably does, recent news worth mentioning in the interview, and why the role fits the owner, based on the profile.
2. The round: what it tests, its format and length if known, and 5-8 likely questions specific to this posting and company. For a technical round, the topics to revise in priority order (data structures and algorithms at the level asked, the stack the posting names, system design basics only if the posting or reports mention it) and a practice plan that fits a busy week, such as three 45-minute sessions.
3. STAR stories, only from the profile. Choose 4-6 experiences or projects. For each: the questions it answers, then Situation, Task, Action and Result written only with facts the profile states. Where a detail is missing (a number, the owner's exact part in a team effort, the outcome), write a bracketed question for the owner, such as [How long did the job take before and after your change?], instead of filling it in.
4. Coverage check: map common behavioural questions (teamwork, a disagreement, a mistake or failure, learning something fast, ownership under a deadline, why this company) to the stories. Where the profile has no story for one, write "No story in your profile yet" and suggest what kind of real experience the owner could think back to. Never write a fictional story.
5. Questions the owner can ask the interviewers: 3-5, specific to the team and role.
6. Gaps to be ready for: requirements the profile does not meet (from an evaluation note if there is one) and an honest way to talk about each.
7. Logistics: the interview date if known, whether it may be in Indonesian or English (the posting's language is a hint), and anything to confirm with the recruiter.

## Save and report

- Save the prep (write): \`add_job_note(jobId: ${id}, title: "Interview prep — <round> — YYYY-MM-DD", content: "<the prep in Markdown>")\`.
- Do not change the application's stage. After the interview the owner can tell you how it went, and you can record it with \`transition_job_stage(jobId: ${id}, toStage: "<the stage>", eventType: "interview_log", note: "<what they told you>")\`.
- Reply with the five most important things to practise, the bracketed questions the owner should answer to finish their stories, and the link to the job in JobOps.`;
  },
});
