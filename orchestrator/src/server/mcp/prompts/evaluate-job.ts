import { definePrompt, promptJobIdArg } from "@server/mcp/kit";
import { z } from "zod";
import { playbookPreamble } from "./common";

export const evaluateJobPrompt = definePrompt({
  name: "evaluate_job",
  title: "Evaluate a job",
  description:
    "Deep evaluation of one job, saved as a note: requirement-to-evidence table (job description first, profile second), gaps, level fit, compensation, posting-legitimacy signals, and a clear apply or skip recommendation with the next action.",
  input: z.object({ jobId: promptJobIdArg() }).strict(),
  render: ({ jobId }, context) => {
    const id = JSON.stringify(jobId);
    return `# Evaluate a job

Goal: give the owner an honest, evidence-based answer to "should I apply to this job, and what would make my application stronger?", saved as a note on job ${id} so it is there when they come back to it. The owner is early in their career and short on time, so a clear "skip" is as useful as a clear "apply".

Done looks like: a note titled "Evaluation — YYYY-MM-DD" on the job with the parts below, and a short answer in the chat. Budget: about 15 tool calls and at most 5 web searches.

${playbookPreamble(context)}

## Gather

1. \`get_job(jobId: ${id})\`. If it returns \`NOT_FOUND\`, tell the owner this id is not one of their jobs and stop. If the description is missing or only a few lines, try to read the posting at \`jobUrl\` with your own web tools; if that fails too, say the evaluation is limited and work with what there is.
2. \`get_profile(includeDetails: true)\`. If \`configured\` is false, stop and ask the owner to set up their master resume in the JobOps web app; an evaluation without it would be guesswork.
3. \`get_settings(keys: ["targetCompanies", "dealbreakers"])\` and \`list_job_notes(jobId: ${id}, previewChars: 2000)\` for earlier evaluations, research or contacts. Use earlier notes, but check them against the current posting.

## Evaluate

Work in this order and keep each part short.

1. Role summary: title, team or product if known, level, location and work arrangement, employment type and duration (for internships), and whether the employer is one of the owner's target companies (\`isTargetCompany\`). Flag any dealbreaker it hits.

2. Requirement-to-evidence table, built in two passes.
   - Pass 1, from the job description only, before you look at the profile: list up to 12 requirements. Give each a weight (must-have, strong plus or nice-to-have) and say whether the posting states it or you inferred it. An inferred requirement is never a must-have.
   - Pass 2, against the profile: for each requirement, the match (met, partial, not met) and the evidence, naming or quoting the specific experience, project, course or skill from the profile. No evidence means not met. Do not stretch evidence: coursework is not production experience, and a skill listed with no project or role behind it is at most partial.
   - Order rows by weight, with unmet rows before met ones within a weight.
   Columns: Requirement | Weight | Stated or inferred | Match | Evidence from the profile.

3. Gaps: each unmet or partial must-have and strong plus, and for each whether the owner can address it before applying (for example by bringing forward an existing project that genuinely shows it, or a short piece of work they could do this week) or should acknowledge it honestly. Never suggest claiming anything the profile does not support.

4. Level fit: compare what the posting asks (years, seniority words, graduation or enrollment conditions) with the profile (education dates, internships, length of work experience). Say plainly whether it fits, is a stretch, or does not fit. For an intern or new graduate, internship, graduate-programme, junior and 0-2 year roles fit; 3+ years, senior, lead and manager roles do not, whatever the score says. List conditions you cannot confirm from the profile (enrollment status, graduation window, work authorization, relocation) as questions for the owner.

5. Compensation: only what the posting states (the job's \`salary\` field or the description) or what a source you cite with its link says. Otherwise write "not stated". Never estimate a figure yourself. Missing pay is not a mark against the job.

6. Posting legitimacy signals. List what you observe, each as a signal with what it may mean, not as a verdict:
   - age: \`datePosted\` and \`discoveredAt\`; a posting open for months may be stale or a standing pipeline;
   - reposts: \`list_jobs(employer: "<employer>", query: "<two or three title words>", limit: 20)\` shows the same title found several times;
   - vagueness: no team, stack, responsibilities or concrete requirements;
   - missing company details, or an application route that asks for payment, unusual personal data, or contact outside the company's own channels;
   - whether the company's own careers site lists the role (one web search).
   End with an overall read: no concerns, some caution, or several warning signs.

7. Recommendation: exactly one of "Apply now", "Apply after addressing: <the gaps>", or "Skip", with two or three sentences of reasons. If your view differs from the JobOps score, say so and why.

8. The single most useful next action, concrete. For example: prepare the CV with \`apply_role_cv_to_job(jobId: ${id}, mode: "refine")\` or \`process_job(jobId: ${id})\`; run the \`outreach_drafts\` playbook for this job; ask the owner whether they graduate in time; or skip it.

## Save and report

- Save the evaluation (write): \`add_job_note(jobId: ${id}, title: "Evaluation — YYYY-MM-DD", content: "<the evaluation in Markdown>")\`, under 15000 characters, with the table as a Markdown table.
- Do not change the job's status, skip it or tailor it unless the owner asks; those decisions are theirs.
- Reply in the chat with the recommendation and its reasons, the top three gaps, the next action, and the link to the job in JobOps. With a read-only token, give the whole evaluation in the chat instead.`;
  },
});
