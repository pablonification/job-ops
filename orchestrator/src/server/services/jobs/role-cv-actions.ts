/**
 * Job-level Role CV actions, for the API routes and agent tools:
 * - `matchJobRoleCv`: auto-pick the best Role CV for a job (or none).
 * - `setJobRoleCv`: choose a Role CV by hand (or none).
 * - `applyRoleCvToJob`: copy a Role CV into the job's tailoring, no model call.
 * - `refineJobWithRoleCv`: per-job tailoring starting from a Role CV.
 *
 * Each returns the updated job.
 */

import { badRequest, notFound } from "@infra/errors";
import { logger } from "@infra/logger";
import { isDemoMode } from "@server/config/demo";
import { summarizeJob } from "@server/pipeline/index";
import * as jobsRepo from "@server/repositories/jobs";
import {
  enqueueAutoPdfRegenerationForJob,
  shouldEnqueueTailoringAutoPdfRegeneration,
} from "@server/services/auto-pdf-regeneration";
import { simulateSummarizeJob } from "@server/services/demo-simulator";
import {
  prepareJobRoleCvAction,
  toJobTailoringFields,
} from "@server/services/job-role-cv";
import type { Job } from "@shared/types";

export { matchJobRoleCv, setJobRoleCv } from "@server/services/job-role-cv";

/**
 * Queues a PDF regeneration when a tailoring change needs one, exactly as a
 * manual edit in the Tailoring tab does.
 */
function queueAutoPdfRegenerationIfNeeded(
  previousJob: Job,
  nextJob: Job,
): void {
  if (!shouldEnqueueTailoringAutoPdfRegeneration(previousJob, nextJob)) return;
  queueMicrotask(() => {
    void enqueueAutoPdfRegenerationForJob({
      jobId: nextJob.id,
      reason: "tailoring_updated",
      requestedBy: "user",
    }).catch((error) => {
      logger.warn("Failed to queue auto PDF regeneration after Role CV use", {
        jobId: nextJob.id,
        error,
      });
    });
  });
}

async function requireJob(jobId: string): Promise<Job> {
  const job = await jobsRepo.getJobById(jobId);
  if (!job) throw notFound("Job not found");
  return job;
}

/**
 * Apply as-is: copies the Role CV's headline, summary, skills and project
 * selection into the job's tailoring fields, without a model call. Uses
 * `roleCvId` (recorded as a manual choice) or the job's current Role CV. The
 * PDF reacts like it does to a manual edit: the fingerprint goes stale and
 * ready jobs with a generated PDF are queued for regeneration.
 */
export async function applyRoleCvToJob(
  jobId: string,
  options?: { roleCvId?: string },
): Promise<Job> {
  const { job, roleCvId, content } = await prepareJobRoleCvAction(
    jobId,
    options,
  );
  const updated = await jobsRepo.updateJob(
    jobId,
    toJobTailoringFields(content),
  );
  if (!updated) throw notFound("Job not found");
  logger.info("Role CV applied to job as-is", { jobId, roleCvId });
  queueAutoPdfRegenerationIfNeeded(job, updated);
  return updated;
}

/**
 * Refine: regenerates the job's headline, summary, skills and project
 * selection for this job, with the Role CV's content as the starting point in
 * the tailoring prompt. Uses `roleCvId` (recorded as a manual choice) or the
 * job's current Role CV.
 */
export async function refineJobWithRoleCv(
  jobId: string,
  options?: { roleCvId?: string; requestOrigin?: string | null },
): Promise<Job> {
  const { job, roleCvId, content } = await prepareJobRoleCvAction(
    jobId,
    options,
  );

  const result = isDemoMode()
    ? await simulateSummarizeJob(jobId, { force: true })
    : await summarizeJob(jobId, {
        force: true,
        requestOrigin: options?.requestOrigin ?? null,
        tailoringBaseline: {
          headline: content.headline,
          summary: content.summary,
          skills: content.skills,
        },
      });
  if (!result.success) {
    throw badRequest(result.error ?? "Failed to refine the job's CV");
  }

  const updated = await requireJob(jobId);
  logger.info("Job tailoring refined from Role CV", { jobId, roleCvId });
  queueAutoPdfRegenerationIfNeeded(job, updated);
  return updated;
}
