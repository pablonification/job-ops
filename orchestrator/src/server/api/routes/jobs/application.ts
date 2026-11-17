import { fail, ok, okWithMeta } from "@infra/http";
import { isDemoMode } from "@server/config/demo";
import { resolveRequestOrigin } from "@server/infra/request-origin";
import { simulateApplyJob } from "@server/services/demo-simulator";
import {
  checkJobSponsor,
  markJobApplied,
} from "@server/services/jobs/application";
import { hydrateJobPdfFreshness } from "@server/services/jobs/common";
import { type Request, type Response, Router } from "express";
import { toJobsRouteError } from "./shared";

export const jobsApplicationRouter = Router();

jobsApplicationRouter.post(
  "/:id/check-sponsor",
  async (req: Request, res: Response) => {
    try {
      const { job, matchResults } = await checkJobSponsor(req.params.id, {
        requestOrigin: resolveRequestOrigin(req),
      });
      ok(res, {
        ...(await hydrateJobPdfFreshness(job)),
        matchResults,
      });
    } catch (error) {
      fail(res, toJobsRouteError(error));
    }
  },
);

jobsApplicationRouter.post(
  "/:id/apply",
  async (req: Request, res: Response) => {
    try {
      if (isDemoMode()) {
        const updatedJob = await simulateApplyJob(req.params.id);
        return okWithMeta(res, await hydrateJobPdfFreshness(updatedJob), {
          simulated: true,
        });
      }

      const updatedJob = await markJobApplied(req.params.id, {
        requestOrigin: resolveRequestOrigin(req),
        source: "jobs_apply_route",
      });
      ok(res, await hydrateJobPdfFreshness(updatedJob));
    } catch (error) {
      fail(res, toJobsRouteError(error));
    }
  },
);
