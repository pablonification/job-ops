import { conflict } from "@infra/errors";
import { hydrateJobPdfFreshness } from "@server/services/jobs/common";
import type { Job, JobPdfFreshness } from "@shared/types";
import { z } from "zod";
import { type CompactJobSummary, toCompactJobSummary } from "./job-summary";

/** `jobId` input field shared by the job tools. */
export const jobIdInput = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("Job id from list_jobs.");

/**
 * What write tools return for a job after acting on it: the compact summary
 * plus the PDF freshness, so the agent can tell whether the PDF matches the
 * tailored content without calling get_job.
 */
export type CompactJobState = CompactJobSummary & {
  pdfFreshness: JobPdfFreshness;
};

/** For a job whose PDF freshness is already resolved. */
export function toCompactJobState(job: Job): CompactJobState {
  return { ...toCompactJobSummary(job), pdfFreshness: job.pdfFreshness };
}

/** Resolves the PDF freshness first, then builds the compact state. */
export async function loadCompactJobState(job: Job): Promise<CompactJobState> {
  return toCompactJobState(await hydrateJobPdfFreshness(job));
}

/**
 * Refuses (CONFLICT) to start model or renderer work on a job that is
 * already busy, so the agent waits instead of racing the running work.
 */
export function assertJobIdle(
  job: Pick<Job, "status" | "pdfRegenerating">,
  options: { allowPdfRegenerating?: boolean } = {},
): void {
  if (job.status === "processing") {
    throw conflict(
      "This job is being processed. Wait until get_job shows a status other than processing, then try again.",
    );
  }
  if (job.pdfRegenerating && !options.allowPdfRegenerating) {
    throw conflict(
      "The resume PDF for this job is being generated. Wait until get_job shows pdfRegenerating false, then try again.",
    );
  }
}
