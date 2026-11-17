import { conflict } from "@infra/errors";
import {
  defineTool,
  defineToolGroup,
  jobIdInput,
  loadCompactJobState,
} from "@server/mcp/kit";
import { getStageEvents, getTasks } from "@server/services/applicationTracking";
import {
  markJobApplied,
  setJobOutcome,
  transitionJobStage,
} from "@server/services/jobs/application";
import { requireJob } from "@server/services/jobs/common";
import {
  APPLICATION_OUTCOMES,
  APPLICATION_STAGES,
  type StageEventMetadata,
} from "@shared/types";
import { z } from "zod";

const MCP_ROUTE = "POST /mcp";

/** ISO date input converted to the unix seconds the stage APIs store. */
const unixSecondsInput = (description: string) =>
  z
    .string()
    .trim()
    .min(1)
    .refine((value) => !Number.isNaN(Date.parse(value)), {
      message: "Expected an ISO date such as 2026-11-01T09:30:00Z",
    })
    .transform((value) => Math.floor(Date.parse(value) / 1000))
    .describe(description);

const markJobAppliedTool = defineTool({
  name: "mark_job_applied",
  title: "Mark a job as applied",
  description:
    "Record that the user applied to this job now: adds an Applied stage event, sets status applied and appliedAt, and fires the job-complete webhook. Only call it after the user really applied. Fails with CONFLICT if the job is already applied or further along.",
  scope: "write",
  input: z.object({ jobId: jobIdInput }).strict(),
  handler: async ({ jobId }, context) => {
    const current = await requireJob(jobId);
    if (current.status === "applied" || current.status === "in_progress") {
      throw conflict(
        `This job is already marked ${current.status === "applied" ? "applied" : "in progress"}. Use transition_job_stage to record later steps.`,
      );
    }
    const job = await markJobApplied(jobId, {
      requestOrigin: context.requestOrigin,
      source: "mcp_mark_job_applied",
    });
    return { job: await loadCompactJobState(job) };
  },
});

const transitionJobStageTool = defineTool({
  name: "transition_job_stage",
  title: "Move an application to a stage",
  description:
    "Record an application step: move to a stage (applied, recruiter_screen, assessment, hiring_manager_screen, technical_interview, onsite, offer, closed) or add a timeline note with toStage no_change and eventType note. Updates the job status (applied, or in_progress for later stages) and, with outcome, closes it.",
  scope: "write",
  input: z
    .object({
      jobId: jobIdInput,
      toStage: z
        .enum([...APPLICATION_STAGES, "no_change"])
        .describe("Target stage, or no_change to only add an event."),
      occurredAt: unixSecondsInput(
        "When it happened (ISO date). Default now.",
      ).optional(),
      eventLabel: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe("Timeline title, e.g. 'Phone screen with Rina'."),
      note: z.string().trim().max(5000).optional(),
      eventType: z
        .enum(["interview_log", "status_update", "note"])
        .optional()
        .describe("note with toStage no_change adds a timeline note only."),
      externalUrl: z.string().trim().url().max(2000).optional(),
      outcome: z
        .enum(APPLICATION_OUTCOMES)
        .optional()
        .describe("Also set the final outcome and close the application."),
    })
    .strict(),
  handler: async (input) => {
    await requireJob(input.jobId);
    const metadata: StageEventMetadata = {
      actor: "user",
      ...(input.eventLabel ? { eventLabel: input.eventLabel } : {}),
      ...(input.note ? { note: input.note } : {}),
      ...(input.eventType ? { eventType: input.eventType } : {}),
      ...(input.externalUrl ? { externalUrl: input.externalUrl } : {}),
    };
    const event = transitionJobStage(
      input.jobId,
      {
        toStage: input.toStage,
        occurredAt: input.occurredAt,
        metadata,
        outcome: input.outcome ?? null,
      },
      { route: MCP_ROUTE },
    );
    return {
      event,
      job: await loadCompactJobState(await requireJob(input.jobId)),
    };
  },
});

const setJobOutcomeTool = defineTool({
  name: "set_job_outcome",
  title: "Set an application's outcome",
  description:
    "Set the final outcome of an application (offer_accepted, offer_declined, rejected, withdrawn, no_response, ghosted) and close it, or pass null to reopen it.",
  scope: "write",
  idempotent: true,
  input: z
    .object({
      jobId: jobIdInput,
      outcome: z.enum(APPLICATION_OUTCOMES).nullable(),
      closedAt: unixSecondsInput(
        "When it closed (ISO date). Default now; ignored when outcome is null.",
      ).optional(),
    })
    .strict(),
  handler: async ({ jobId, outcome, closedAt }, context) => {
    const job = await setJobOutcome(
      jobId,
      { outcome, closedAt },
      {
        requestOrigin: context.requestOrigin,
        route: MCP_ROUTE,
        source: "mcp_set_job_outcome",
      },
    );
    return {
      job: await loadCompactJobState(job),
      closedAt: job.closedAt,
    };
  },
});

const getJobTimeline = defineTool({
  name: "get_job_timeline",
  title: "Get an application's timeline",
  description:
    "Stage history of a job's application (stage events oldest first, with notes and outcomes) and its tasks such as follow-ups and interview prep.",
  scope: "read",
  input: z
    .object({
      jobId: jobIdInput,
      includeCompletedTasks: z
        .boolean()
        .default(true)
        .describe("Include completed tasks. Default true."),
    })
    .strict(),
  handler: async ({ jobId, includeCompletedTasks }) => {
    const job = await requireJob(jobId);
    const [events, tasks] = await Promise.all([
      getStageEvents(jobId),
      getTasks(jobId, includeCompletedTasks),
    ]);
    return {
      job: await loadCompactJobState(job),
      events,
      tasks,
    };
  },
});

export const applicationsToolGroup = defineToolGroup({
  id: "applications",
  tools: [
    markJobAppliedTool,
    transitionJobStageTool,
    setJobOutcomeTool,
    getJobTimeline,
  ],
});
