/**
 * Per-job tailoring and PDF rendering, shared by the REST routes
 * (`POST /api/jobs/:id/summarize`, `POST /api/jobs/:id/generate-pdf`) and the
 * MCP tools. Demo-mode simulation stays in the routes.
 */
import { badRequest } from "@infra/errors";
import { generateFinalPdf, summarizeJob } from "@server/pipeline/index";
import type { Job } from "@shared/types";
import {
  appErrorFromPipelineFailure,
  queueTailoringAutoPdfRegenerationIfNeeded,
  requireJob,
} from "./common";

export const TAILORING_GENERATE_FIELDS = [
  "summary",
  "headline",
  "skills",
  "projects",
] as const;
export type TailoringGenerateField = (typeof TAILORING_GENERATE_FIELDS)[number];

/**
 * Runs the tailoring model for one job (all fields, or only `fields`), then
 * queues an automatic PDF regeneration when the tailored content changed.
 * Returns the updated job.
 */
export async function tailorJob(
  jobId: string,
  options: {
    force?: boolean;
    fields?: TailoringGenerateField[];
    route: string;
  },
): Promise<Job> {
  const previousJob = await requireJob(jobId);
  const result = await summarizeJob(jobId, {
    force: options.force ?? false,
    fields: options.fields,
  });
  if (!result.success) {
    throw badRequest(result.error ?? "Failed to summarize the job");
  }

  const job = await requireJob(jobId);
  queueTailoringAutoPdfRegenerationIfNeeded(previousJob, job, options.route);
  return job;
}

/** Renders the tailored resume PDF for one job and returns the updated job. */
export async function generateJobPdf(
  jobId: string,
  options: { requestOrigin: string | null },
): Promise<Job> {
  const result = await generateFinalPdf(jobId, {
    requestOrigin: options.requestOrigin,
    analyticsOrigin: "generate_pdf",
  });
  if (!result.success) {
    throw appErrorFromPipelineFailure(
      result,
      "Failed to generate a resume PDF",
    );
  }
  return requireJob(jobId);
}
