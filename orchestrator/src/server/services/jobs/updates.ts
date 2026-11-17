/**
 * Job edits and deletion with their side effects, shared by the REST routes
 * (`PATCH /api/jobs/:id`, `DELETE /api/jobs/:id`) and the MCP tools.
 */
import { AppError, conflict, notFound } from "@infra/errors";
import { logger } from "@infra/logger";
import * as jobsRepo from "@server/repositories/jobs";
import { reconcileActivationMilestonesFromHistorySafely } from "@server/services/activation-funnel";
import { removeStoredJobDocuments } from "@server/services/job-document-storage";
import { removeStoredJobPdf } from "@server/services/pdf-storage";
import { getTracerReadiness } from "@server/services/tracer-links";
import type { Job, UpdateJobInput } from "@shared/types";
import { trackApplicationAcceptedIfNeeded } from "./analytics";
import {
  isJobUrlConflictError,
  queueTailoringAutoPdfRegenerationIfNeeded,
} from "./common";

/**
 * Applies a validated job update. Turning tracer links on requires a passing
 * readiness check (409 otherwise). After the update it tracks an accepted
 * offer, queues an automatic PDF regeneration when tailored content changed,
 * and reconciles activation milestones when the outcome changed.
 */
export async function updateJobWithSideEffects(
  jobId: string,
  input: UpdateJobInput,
  context: { requestOrigin: string | null; route: string; source: string },
): Promise<Job> {
  const currentJob = await jobsRepo.getJobById(jobId);
  if (!currentJob) throw notFound("Job not found");

  const isTurningTracerLinksOn =
    input.tracerLinksEnabled === true && !currentJob.tracerLinksEnabled;

  if (isTurningTracerLinksOn) {
    const readiness = await getTracerReadiness({
      requestOrigin: context.requestOrigin,
      force: true,
    });

    if (!readiness.canEnable) {
      throw new AppError({
        status: 409,
        code: "CONFLICT",
        message:
          readiness.reason ??
          "Tracer links are unavailable right now. Verify Tracer Links in Settings.",
        details: {
          tracerReadiness: {
            status: readiness.status,
            checkedAt: readiness.checkedAt,
            publicBaseUrl: readiness.publicBaseUrl,
          },
        },
      });
    }
  }

  let job: Job | null;
  try {
    job = await jobsRepo.updateJob(jobId, input);
  } catch (error) {
    if (isJobUrlConflictError(error)) {
      throw conflict("Another job already uses that job URL");
    }
    throw error;
  }
  if (!job) throw notFound("Job not found");

  logger.info("Job updated", {
    route: context.route,
    jobId,
    updatedFields: Object.keys(input),
  });

  trackApplicationAcceptedIfNeeded({
    closedAt: job.closedAt,
    nextOutcome: job.outcome,
    previousOutcome: currentJob.outcome,
    requestOrigin: context.requestOrigin,
    source: context.source,
  });
  queueTailoringAutoPdfRegenerationIfNeeded(currentJob, job, context.route);
  if (Object.hasOwn(input, "closedAt") || Object.hasOwn(input, "outcome")) {
    queueMicrotask(() => {
      void reconcileActivationMilestonesFromHistorySafely({
        route: context.route,
        jobId,
        updatedFields: Object.keys(input),
      });
    });
  }
  return job;
}

/**
 * Deletes a job and its stored PDF and documents. Refuses (409) while the job
 * is being processed, its PDF renders, or Ghostwriter is replying.
 */
export async function deleteJobWithFiles(
  jobId: string,
  context: { route: string },
): Promise<void> {
  const result = await jobsRepo.deleteJob(jobId);
  if (result === "not_found") throw notFound("Job not found");
  if (result === "busy") {
    throw conflict(
      "This job is being processed. Wait for PDF generation or Ghostwriter to finish, then try again.",
    );
  }

  const cleanupResults = await Promise.allSettled([
    removeStoredJobPdf(jobId),
    removeStoredJobDocuments(jobId),
  ]);
  for (const cleanup of cleanupResults) {
    if (cleanup.status === "rejected") {
      logger.warn("Failed to remove deleted job files", {
        route: context.route,
        jobId,
        error: cleanup.reason,
      });
    }
  }
  logger.info("Job deleted", { route: context.route, jobId });
}
