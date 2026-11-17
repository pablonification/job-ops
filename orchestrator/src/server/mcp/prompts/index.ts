/**
 * Playbooks: MCP prompts that run a whole job-search workflow with the tools.
 * Claude Code lists them as slash commands (`/<server>:<name>`).
 *
 * To add one: write `./<name>.ts` with `definePrompt` from `@server/mcp/kit`
 * (start the text with `playbookPreamble`), add it below, and keep every
 * tool call in the text in the `tool_name(argument: value)` form so the
 * prompt test can check it against the registered tools.
 */
import type { McpPromptDefinition } from "@server/mcp/kit";
import { dailyTriagePrompt } from "./daily-triage";
import { evaluateJobPrompt } from "./evaluate-job";
import { followUpsPrompt } from "./follow-ups";
import { interviewPrepPrompt } from "./interview-prep";
import { outreachDraftsPrompt } from "./outreach-drafts";
import { weeklyReviewPrompt } from "./weekly-review";

export const MCP_PROMPTS: readonly McpPromptDefinition[] = [
  dailyTriagePrompt,
  evaluateJobPrompt,
  outreachDraftsPrompt,
  interviewPrepPrompt,
  followUpsPrompt,
  weeklyReviewPrompt,
];
