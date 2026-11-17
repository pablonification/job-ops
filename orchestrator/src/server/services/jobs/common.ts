/**
 * Small job helpers shared by the REST routes and the MCP tools.
 */
import {
  AppError,
  type AppErrorCode,
  badRequest,
  notFound,
} from "@infra/errors";
import { logger } from "@infra/logger";
import * as jobsRepo from "@server/repositories/jobs";
import {
  enqueueAutoPdfRegenerationForJob,
  shouldEnqueueTailoringAutoPdfRegeneration,
} from "@server/services/auto-pdf-regeneration";
import {
  applyJobPdfFreshness,
  type PdfFingerprintContext,
  resolvePdfFingerprintContext,
} from "@server/services/pdf-fingerprint";
import type { Job } from "@shared/types";

export async function requireJob(jobId: string): Promise<Job> {
  const job = await jobsRepo.getJobById(jobId);
  if (!job) {
    throw notFound("Job not found");
  }
  return job;
}

export async function hydrateJobPdfFreshness<T extends Job>(
  job: T,
): Promise<T> {
  const context = await resolvePdfFingerprintContext();
  return applyJobPdfFreshness(job, context);
}

export function hydrateJobPdfFreshnessWithContext<T extends Job>(
  job: T,
  context: PdfFingerprintContext,
): T {
  return applyJobPdfFreshness(job, context);
}

export function queueTailoringAutoPdfRegenerationIfNeeded(
  previousJob: Job,
  nextJob: Job,
  route: string,
): void {
  if (!shouldEnqueueTailoringAutoPdfRegeneration(previousJob, nextJob)) {
    return;
  }

  queueMicrotask(() => {
    void enqueueAutoPdfRegenerationForJob({
      jobId: nextJob.id,
      reason: "tailoring_updated",
      requestedBy: "user",
    }).catch((error) => {
      logger.warn("Failed to queue auto PDF regeneration after job update", {
        route,
        jobId: nextJob.id,
        reason: "tailoring_updated",
        error,
      });
    });
  });
}

const STATUS_BY_APP_ERROR_CODE: Record<AppErrorCode, number> = {
  INVALID_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  REQUEST_TIMEOUT: 408,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  SERVICE_UNAVAILABLE: 503,
  UPSTREAM_ERROR: 502,
  INTERNAL_ERROR: 500,
};

export function appErrorFromPipelineFailure(
  result: { error?: string; errorCode?: AppErrorCode },
  fallbackMessage: string,
): AppError {
  const code =
    result.errorCode ?? (result.error === "Job not found" ? "NOT_FOUND" : null);

  if (!code) {
    return badRequest(result.error ?? fallbackMessage);
  }

  return new AppError({
    status: STATUS_BY_APP_ERROR_CODE[code],
    code,
    message: result.error ?? fallbackMessage,
  });
}
