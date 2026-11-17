/**
 * Role CVs on jobs: which Role CV a job uses, how it was chosen, and copying
 * a Role CV into the job's tailoring fields.
 *
 * A job's Role CV is denormalised: applying copies the Role CV's fields into
 * the job's `tailored_*` columns, so the PDF fingerprint, auto-regeneration,
 * the Tailoring tab and Ghostwriter keep working unchanged. Editing a Role CV
 * never rewrites jobs; re-applying is explicit.
 *
 * This module must not import the pipeline (the pipeline imports it). The
 * "apply as-is" and "refine" actions live in `services/jobs/role-cv-actions.ts`.
 */

import { badRequest, notFound } from "@infra/errors";
import { logger } from "@infra/logger";
import * as jobsRepo from "@server/repositories/jobs";
import * as roleCvsRepo from "@server/repositories/role-cvs";
import * as settingsRepo from "@server/repositories/settings";
import { settingsRegistry } from "@shared/settings-registry";
import type {
  Job,
  RoleCvPipelineMode,
  RoleCvTailoringContent,
  UpdateJobInput,
} from "@shared/types";
import { pickRoleCvForJob } from "./role-cv-matching";
import { getRoleCvTailoringContent } from "./role-cvs";

export type RoleCvProcessingPlan = {
  mode: Exclude<RoleCvPipelineMode, "off">;
  roleCvId: string;
  content: RoleCvTailoringContent;
};

const NO_CONTENT_MESSAGE =
  "This Role CV has no headline or summary yet. Generate it first.";
const NO_ROLE_CV_MESSAGE = "Choose a Role CV for this job first.";

export async function getRoleCvPipelineMode(): Promise<RoleCvPipelineMode> {
  const raw = await settingsRepo.getSetting("roleCvPipelineMode");
  return (
    settingsRegistry.roleCvPipelineMode.parse(raw ?? undefined) ??
    settingsRegistry.roleCvPipelineMode.default()
  );
}

/** A Role CV is usable on a job once it has a headline and a summary. */
export function hasRoleCvContent(content: RoleCvTailoringContent): boolean {
  return (
    content.headline.trim().length > 0 && content.summary.trim().length > 0
  );
}

/** The job tailoring fields a Role CV's content maps to. */
export function toJobTailoringFields(
  content: RoleCvTailoringContent,
): Pick<
  UpdateJobInput,
  | "tailoredHeadline"
  | "tailoredSummary"
  | "tailoredSkills"
  | "selectedProjectIds"
> {
  return {
    tailoredHeadline: content.headline,
    tailoredSummary: content.summary,
    tailoredSkills: JSON.stringify(content.skills),
    selectedProjectIds: content.selectedProjectIds.join(","),
  };
}

async function requireJob(jobId: string): Promise<Job> {
  const job = await jobsRepo.getJobById(jobId);
  if (!job) throw notFound("Job not found");
  return job;
}

async function requireUpdatedJob(
  jobId: string,
  input: UpdateJobInput,
): Promise<Job> {
  const job = await jobsRepo.updateJob(jobId, input);
  if (!job) throw notFound("Job not found");
  return job;
}

/** Sets the job's Role CV by hand (`null` means "no Role CV"). */
export async function setJobRoleCv(
  jobId: string,
  roleCvId: string | null,
): Promise<Job> {
  await requireJob(jobId);
  if (roleCvId && !(await roleCvsRepo.getRoleCvRowById(roleCvId))) {
    throw notFound("Role CV not found");
  }
  return requireUpdatedJob(jobId, { roleCvId, roleCvMatchSource: "manual" });
}

/**
 * Auto-matches the job to one of the user's Role CVs (or none) and stores the
 * result with match source "auto", replacing any earlier choice. With no Role
 * CVs the job is returned unchanged.
 */
export async function matchJobRoleCv(jobId: string): Promise<Job> {
  const job = await requireJob(jobId);
  const roleCvs = await roleCvsRepo.listRoleCvRows();
  if (roleCvs.length === 0) return job;
  const match = await pickRoleCvForJob({ job, roleCvs });
  logger.info("Role CV matched to job", {
    jobId,
    roleCvId: match.roleCvId,
    method: match.method,
  });
  return requireUpdatedJob(jobId, {
    roleCvId: match.roleCvId,
    roleCvMatchSource: "auto",
  });
}

/**
 * Resolves which Role CV id to use for an explicit action: the given one
 * (recorded as a manual choice when it differs) or the job's current one.
 */
async function resolveActionRoleCv(
  job: Job,
  roleCvId: string | undefined,
): Promise<{ roleCvId: string; content: RoleCvTailoringContent }> {
  const id = roleCvId ?? job.roleCvId;
  if (!id) throw badRequest(NO_ROLE_CV_MESSAGE);
  const content = await getRoleCvTailoringContent(id);
  if (!hasRoleCvContent(content)) throw badRequest(NO_CONTENT_MESSAGE);
  return { roleCvId: id, content };
}

/**
 * Prepares an explicit "apply" or "refine": validates the Role CV and records
 * it on the job as a manual choice when it differs from the current one.
 */
export async function prepareJobRoleCvAction(
  jobId: string,
  options?: { roleCvId?: string },
): Promise<{ job: Job; roleCvId: string; content: RoleCvTailoringContent }> {
  const job = await requireJob(jobId);
  const resolved = await resolveActionRoleCv(job, options?.roleCvId);
  if (resolved.roleCvId === job.roleCvId) return { job, ...resolved };
  const updated = await requireUpdatedJob(jobId, {
    roleCvId: resolved.roleCvId,
    roleCvMatchSource: "manual",
  });
  return { job: updated, ...resolved };
}

/**
 * Decides how auto-tailoring (pipeline, "move to ready", manual import) uses
 * Role CVs for a job. Returns null, meaning "tailor as before", when the
 * setting is off, the job needs no tailoring, the user has no Role CVs, no
 * Role CV fits, or the chosen one has no content. Auto-matches a job that was
 * never matched and stores the result. Never throws.
 */
export async function resolveRoleCvForProcessing(
  jobId: string,
  options?: { force?: boolean },
): Promise<RoleCvProcessingPlan | null> {
  try {
    const mode = await getRoleCvPipelineMode();
    if (mode === "off") return null;

    const job = await jobsRepo.getJobById(jobId);
    if (!job) return null;
    // Same rule as summarizeJob: existing tailoring is kept unless forced.
    if (!options?.force && job.tailoredSummary && job.tailoredHeadline) {
      return null;
    }

    let roleCvId = job.roleCvId;
    if (!roleCvId) {
      // A stored "none" (auto or manual) is respected.
      if (job.roleCvMatchSource) return null;
      const roleCvs = await roleCvsRepo.listRoleCvRows();
      if (roleCvs.length === 0) return null;
      const match = await pickRoleCvForJob({ job, roleCvs });
      await jobsRepo.updateJob(jobId, {
        roleCvId: match.roleCvId,
        roleCvMatchSource: "auto",
      });
      logger.info("Role CV matched to job", {
        jobId,
        roleCvId: match.roleCvId,
        method: match.method,
      });
      if (!match.roleCvId) return null;
      roleCvId = match.roleCvId;
    }

    const content = await getRoleCvTailoringContent(roleCvId);
    if (!hasRoleCvContent(content)) return null;
    return { mode, roleCvId, content };
  } catch (error) {
    logger.warn("Could not use a Role CV for this job, tailoring as usual", {
      jobId,
      error,
    });
    return null;
  }
}
