import { definePrompt, promptChoiceArg, promptJobIdArg } from "@server/mcp/kit";
import { z } from "zod";
import { playbookPreamble } from "./common";

const LANGUAGE_RULES = {
  en: "Write in clear, natural English. Keep company, product and team names as they are.",
  id: 'Write in natural, professional Bahasa Indonesia (semi-formal, not textbook-stiff). Greet recruiters and engineers with "Halo Kak [Nama]" and a senior hiring manager with "Halo Pak/Bu [Nama]". Keep everyday tech terms in English the way Indonesian engineers do (backend, API, deployment, code review), and avoid word-for-word translations from English.',
} as const;

/**
 * Placeholders are written in the drafts' language, so a draft reads
 * naturally once the owner fills them in; the playbook says so explicitly.
 */
const PLACEHOLDERS = {
  en: { name: "[Name]", link: "[link to my application]" },
  id: { name: "[Nama]", link: "[tautan lamaran saya]" },
} as const;

export const outreachDraftsPrompt = definePrompt({
  name: "outreach_drafts",
  title: "Outreach drafts",
  description:
    "Draft short messages about one job for a recruiter, the hiring manager and an engineer on the team, in English or Indonesian, saved as a note. Nothing is sent.",
  input: z
    .object({
      jobId: promptJobIdArg(),
      language: promptChoiceArg({
        values: ["en", "id"],
        aliases: {
          english: "en",
          inggris: "en",
          indonesian: "id",
          indonesia: "id",
          bahasa: "id",
        },
        description:
          "Language of the drafts: en (English, default) or id (Indonesian).",
      }),
    })
    .strict(),
  render: ({ jobId, language }, context) => {
    const id = JSON.stringify(jobId);
    const lang = language ?? "en";
    const languageName = lang === "id" ? "Indonesian" : "English";
    const placeholder = PLACEHOLDERS[lang];
    return `# Outreach drafts

Goal: three short messages the owner can send to people at the company behind job ${id}: a recruiter, the hiring manager, and an engineer on the team, written in ${languageName}. A specific, honest note from a candidate gets read; a generic one does not. The owner decides whether and when to send each one and sends it themselves. Nothing in this playbook is ever sent.

Done looks like: a note titled "Outreach drafts — YYYY-MM-DD" on the job with the three drafts, each as a connection request of at most 300 characters and a message of at most 120 words, plus the names and sources you found, and the drafts shown in the chat. Budget: about 10 tool calls and at most 5 web searches.

${playbookPreamble(context)}

## Gather

1. \`get_job(jobId: ${id}, descriptionMaxChars: 6000)\`. If it returns \`NOT_FOUND\`, tell the owner and stop.
2. \`get_profile(includeDetails: true)\`. If \`configured\` is false, stop and ask the owner to set up their master resume in the JobOps web app.
3. \`list_job_notes(jobId: ${id}, previewChars: 2000)\` for an evaluation, earlier outreach or known contacts. If a note says someone was already contacted, do not draft a first message to them again; ask the owner.
4. Web research, at most 5 searches: what the team or product does, and one or two recent, concrete things (an engineering blog post, a launch, a talk), with links. Look for the recruiter or hiring manager only on public professional pages (the company site, public LinkedIn results). Never guess a name, email address or job title; when you cannot find a person, use the placeholder ${placeholder.name}.

## Write

- Pick one or two proof points from the profile that match requirements the posting states: a specific project or experience and what it achieved. Use only facts and numbers that are in the profile; do not add metrics or enlarge the owner's part.
- Recruiter: who the owner is in one line (level and focus), the exact role title and the posting link, one proof point tied to a stated requirement, and a simple ask, such as whether the role fits their graduation timing or the best way to be considered.
- Hiring manager: one specific thing about the team's work from your research, how one proof point relates to it, and a small ask, such as whether they would look at the application or have 15 minutes for a call.
- Engineer on the team: genuine interest in their work and one specific question. No request for a referral or a job in this first message.
- Tone: polite, direct and specific. No flattery, no "I hope this message finds you well", no "passionate", no exaggeration, no emoji.
- ${LANGUAGE_RULES[lang]}
- Placeholders are in square brackets and in the language of the drafts: ${placeholder.name} for a person's name and ${placeholder.link} for a link, plus others in the same style when needed. Never fill one with a guess.

## Save and report

- Save the drafts (write): \`add_job_note(jobId: ${id}, title: "Outreach drafts — YYYY-MM-DD", content: "<the drafts in Markdown>")\`. Start the note with "Drafts, not sent." and end it with the sources you used.
- Reply with the three drafts, the placeholders the owner must fill, and a reminder that they send the messages themselves.
- When the owner later tells you they sent one, record it with \`add_job_note(jobId: ${id}, title: "Outreach sent — YYYY-MM-DD", content: "<who, which channel>")\`, and for a job they have applied to, also \`transition_job_stage(jobId: ${id}, toStage: "no_change", eventType: "note", eventLabel: "Outreach sent")\`.`;
  },
});
