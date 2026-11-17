import { fail, ok } from "@infra/http";
import { resolveRequestOrigin } from "@server/infra/request-origin";
import { hydrateJobPdfFreshness } from "@server/services/jobs/common";
import {
  applyRoleCvToJob,
  matchJobRoleCv,
  refineJobWithRoleCv,
  setJobRoleCv,
} from "@server/services/jobs/role-cv-actions";
import { type Request, type Response, Router } from "express";
import { z } from "zod";
import { toJobsRouteError } from "./shared";

export const jobsRoleCvRouter = Router();

const roleCvIdSchema = z.string().trim().min(1).max(200);

const setJobRoleCvSchema = z
  .object({ roleCvId: roleCvIdSchema.nullable() })
  .strict();

const useJobRoleCvSchema = z
  .object({ roleCvId: roleCvIdSchema.optional() })
  .strict();

/** Auto-picks the best Role CV for the job (or none). */
jobsRoleCvRouter.post(
  "/:id/role-cv/match",
  async (req: Request, res: Response) => {
    try {
      const job = await matchJobRoleCv(req.params.id);
      ok(res, await hydrateJobPdfFreshness(job));
    } catch (error) {
      fail(res, toJobsRouteError(error));
    }
  },
);

/** Sets the job's Role CV by hand; `null` means no Role CV. */
jobsRoleCvRouter.put("/:id/role-cv", async (req: Request, res: Response) => {
  try {
    const input = setJobRoleCvSchema.parse(req.body ?? {});
    const job = await setJobRoleCv(req.params.id, input.roleCvId);
    ok(res, await hydrateJobPdfFreshness(job));
  } catch (error) {
    fail(res, toJobsRouteError(error));
  }
});

/** Copies the Role CV into the job's tailoring fields (no model call). */
jobsRoleCvRouter.post(
  "/:id/role-cv/apply",
  async (req: Request, res: Response) => {
    try {
      const input = useJobRoleCvSchema.parse(req.body ?? {});
      const job = await applyRoleCvToJob(req.params.id, input);
      ok(res, await hydrateJobPdfFreshness(job));
    } catch (error) {
      fail(res, toJobsRouteError(error));
    }
  },
);

/** Tailors the job's CV starting from the Role CV. */
jobsRoleCvRouter.post(
  "/:id/role-cv/refine",
  async (req: Request, res: Response) => {
    try {
      const input = useJobRoleCvSchema.parse(req.body ?? {});
      const job = await refineJobWithRoleCv(req.params.id, {
        ...input,
        requestOrigin: resolveRequestOrigin(req),
      });
      ok(res, await hydrateJobPdfFreshness(job));
    } catch (error) {
      fail(res, toJobsRouteError(error));
    }
  },
);
