/**
 * Application tracking actions shared by the REST routes
 * (`POST /api/jobs/:id/apply`, `PATCH /api/jobs/:id/outcome`,
 * `POST /api/jobs/:id/stages`, `POST /api/jobs/:id/check-sponsor`) and the
 * MCP tools. Demo-mode simulation stays in the routes.
 */
import { badRequest, notFound } from "@infra/errors";
import { logger } from "@infra/logger";
import { trackServerProductEvent } from "@infra/product-analytics";
import * as jobsRepo from "@server/repositories/jobs";
import {
  reconcileActivationMilestonesFromHistorySafely,
  trackCanonicalActivationEvent,
} from "@server/services/activation-funnel";
import { transitionStage } from "@server/services/applicationTracking";
import * as visaSponsors from "@server/services/visa-sponsors/index";
import type {
  ApplicationStage,
  Job,
  JobOutcome,
  StageEvent,
  StageEventMetadata,
} from "@shared/types";
import { trackApplicationAcceptedIfNeeded } from "./analytics";
import { requireJob } from "./common";
import { notifyJobCompleteWebhook } from "./webhooks";

/**
 * Marks a job as applied now: records an `applied` stage event, sets status
 * and appliedAt, tracks the activation event and notifies the job-complete
 * webhook.
 */
export async function markJobApplied(
  jobId: string,
  context: { requestOrigin: string | null; source: string },
): Promise<Job> {
  const job = await requireJob(jobId);

  const appliedAtDate = new Date();
  const appliedAt = appliedAtDate.toISOString();

  transitionStage(
    job.id,
    "applied",
    Math.floor(appliedAtDate.getTime() / 1000),
    {
      eventLabel: "Applied",
      actor: "system",
    },
    null,
  );

  const updatedJob = await jobsRepo.updateJob(job.id, {
    status: "applied",
    appliedAt,
  });
  if (!updatedJob) throw notFound("Job not found");

  void trackCanonicalActivationEvent(
    "application_marked_applied",
    {
      source: context.source,
      had_pdf: Boolean(updatedJob.pdfPath),
      tracer_links_enabled: Boolean(updatedJob.tracerLinksEnabled),
      sponsor_match_found:
        typeof updatedJob.sponsorMatchScore === "number" &&
        updatedJob.sponsorMatchScore >= 50,
    },
    {
      occurredAt: appliedAtDate,
      requestOrigin: context.requestOrigin,
      urlPath: "/jobs",
    },
  );
  notifyJobCompleteWebhook(updatedJob).catch((error) => {
    logger.warn("Job complete webhook dispatch failed", error);
  });

  return updatedJob;
}

/**
 * Sets (or clears, with `null`) a job's outcome. `closedAt` (unix seconds)
 * defaults to now when an outcome is set and is cleared with the outcome.
 */
export async function setJobOutcome(
  jobId: string,
  input: { outcome: JobOutcome | null; closedAt?: number | null },
  context: { requestOrigin: string | null; route: string; source: string },
): Promise<Job> {
  const currentJob = await jobsRepo.getJobById(jobId);
  if (!currentJob) throw notFound("Job not found");

  const closedAt = input.outcome
    ? (input.closedAt ?? Math.floor(Date.now() / 1000))
    : null;
  const job = await jobsRepo.updateJob(jobId, {
    outcome: input.outcome,
    closedAt,
  });
  if (!job) throw notFound("Job not found");

  trackApplicationAcceptedIfNeeded({
    closedAt: job.closedAt,
    nextOutcome: job.outcome,
    previousOutcome: currentJob.outcome,
    requestOrigin: context.requestOrigin,
    source: context.source,
  });
  queueMicrotask(() => {
    void reconcileActivationMilestonesFromHistorySafely({
      route: context.route,
      jobId,
    });
  });
  return job;
}

/**
 * Appends a stage event (`no_change` with `eventType: "note"` only adds a
 * timeline entry) and updates the job's status, dates and outcome to match.
 */
export function transitionJobStage(
  jobId: string,
  input: {
    toStage: ApplicationStage | "no_change";
    occurredAt?: number | null;
    metadata?: StageEventMetadata | null;
    outcome?: JobOutcome | null;
  },
  context: { route: string },
): StageEvent {
  const event = transitionStage(
    jobId,
    input.toStage,
    input.occurredAt ?? undefined,
    input.metadata ?? null,
    input.outcome ?? null,
  );
  queueMicrotask(() => {
    void reconcileActivationMilestonesFromHistorySafely({
      route: context.route,
      jobId,
    });
  });
  return event;
}

export type JobSponsorCheck = {
  job: Job;
  matchResults: Array<{ name: string; score: number }>;
};

/**
 * Looks the job's employer up in the visa sponsor registers and stores the
 * best match score and names on the job.
 */
export async function checkJobSponsor(
  jobId: string,
  context: { requestOrigin: string | null },
): Promise<JobSponsorCheck> {
  const job = await requireJob(jobId);
  if (!job.employer) throw badRequest("Job has no employer name");

  const sponsorResults = await visaSponsors.searchSponsors(job.employer, {
    limit: 10,
    minScore: 50,
  });

  const { sponsorMatchScore, sponsorMatchNames } =
    visaSponsors.calculateSponsorMatchSummary(sponsorResults);

  const updatedJob = await jobsRepo.updateJob(job.id, {
    sponsorMatchScore: sponsorMatchScore,
    sponsorMatchNames: sponsorMatchNames ?? undefined,
  });
  if (!updatedJob) throw notFound("Job not found");

  if (sponsorMatchScore >= 50 && sponsorResults.length > 0) {
    void trackServerProductEvent(
      "sponsor_match_found",
      {
        match_score: sponsorMatchScore,
        match_count: sponsorResults.length,
      },
      {
        requestOrigin: context.requestOrigin,
        urlPath: "/visa-sponsors",
      },
    );
  }

  return {
    job: updatedJob,
    matchResults: sponsorResults.slice(0, 5).map((result) => ({
      name: result.sponsor.organisationName,
      score: result.score,
    })),
  };
}
