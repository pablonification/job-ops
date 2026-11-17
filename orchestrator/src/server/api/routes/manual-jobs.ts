import { toAppError } from "@infra/errors";
import { fail, ok } from "@infra/http";
import {
  fetchManualJobContent,
  importManualJob,
  manualJobFetchSchema,
  manualJobImportSchema,
} from "@server/services/manual-job-import";
import { inferManualJobDetails } from "@server/services/manualJob";
import { type Request, type Response, Router } from "express";
import { z } from "zod";

export const manualJobsRouter = Router();

const manualJobInferenceSchema = z.object({
  jobDescription: z.string().trim().min(1).max(60000),
});

/**
 * POST /api/manual-jobs/fetch - Fetch and extract job content from a URL
 */
manualJobsRouter.post("/fetch", async (req: Request, res: Response) => {
  try {
    const input = manualJobFetchSchema.parse(req.body ?? {});
    ok(res, await fetchManualJobContent(input.url));
  } catch (error) {
    fail(res, toAppError(error));
  }
});

/**
 * POST /api/manual-jobs/infer - Infer job details from a pasted description
 */
manualJobsRouter.post("/infer", async (req: Request, res: Response) => {
  try {
    const input = manualJobInferenceSchema.parse(req.body ?? {});
    const result = await inferManualJobDetails(input.jobDescription);

    ok(res, {
      job: result.job,
      warning: result.warning ?? null,
    });
  } catch (error) {
    fail(res, toAppError(error));
  }
});

/**
 * POST /api/manual-jobs/import - Import a manually curated job into the DB
 */
manualJobsRouter.post("/import", async (req: Request, res: Response) => {
  try {
    const input = manualJobImportSchema.parse(req.body ?? {});
    ok(res, await importManualJob(input));
  } catch (error) {
    fail(res, toAppError(error));
  }
});
