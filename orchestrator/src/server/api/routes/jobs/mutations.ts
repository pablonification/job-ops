import { fail, ok } from "@infra/http";
import { logger } from "@infra/logger";
import { isDemoMode, sendDemoBlocked } from "@server/config/demo";
import { resolveRequestOrigin } from "@server/infra/request-origin";
import {
  deleteJobWithFiles,
  updateJobWithSideEffects,
} from "@server/services/jobs/updates";
import { type Request, type Response, Router } from "express";
import {
  hydrateJobPdfFreshness,
  isJobUrlConflictError,
  toJobsRouteError,
  updateJobSchema,
} from "./shared";

export const jobsMutationsRouter = Router();

jobsMutationsRouter.delete("/:id", async (req: Request, res: Response) => {
  const route = "DELETE /api/jobs/:id";
  const jobId = req.params.id;
  try {
    if (isDemoMode()) {
      return sendDemoBlocked(
        res,
        "Deleting jobs is disabled to keep the demo stable.",
        { route, jobId },
      );
    }

    await deleteJobWithFiles(jobId, { route });
    ok(res, null);
  } catch (error) {
    const err = toJobsRouteError(error);
    logger[err.status === 404 || err.status === 409 ? "warn" : "error"](
      "Job deletion failed",
      {
        route,
        jobId,
        status: err.status,
        code: err.code,
        details: err.details,
      },
    );
    fail(res, err);
  }
});

jobsMutationsRouter.patch("/:id", async (req: Request, res: Response) => {
  const route = "PATCH /api/jobs/:id";
  try {
    const input = updateJobSchema.parse(req.body);
    const job = await updateJobWithSideEffects(req.params.id, input, {
      requestOrigin: resolveRequestOrigin(req),
      route,
      source: "jobs_patch_route",
    });
    ok(res, await hydrateJobPdfFreshness(job));
  } catch (error) {
    const err = toJobsRouteError(error, {
      invalidRequestFallbackMessage: "Invalid job update request",
      conflictWhen: isJobUrlConflictError,
      conflictMessage: "Another job already uses that job URL",
    });

    logger[err.status === 404 ? "warn" : "error"]("Job update failed", {
      route,
      jobId: req.params.id,
      status: err.status,
      code: err.code,
      details: err.details,
    });

    fail(res, err);
  }
});
