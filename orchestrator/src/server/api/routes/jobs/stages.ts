import { badRequest, toAppError } from "@infra/errors";
import { fail, ok } from "@infra/http";
import { resolveRequestOrigin } from "@server/infra/request-origin";
import { reconcileActivationMilestonesFromHistorySafely } from "@server/services/activation-funnel";
import {
  deleteStageEvent,
  getStageEvents,
  getTasks,
  updateStageEvent,
} from "@server/services/applicationTracking";
import {
  setJobOutcome,
  transitionJobStage,
} from "@server/services/jobs/application";
import { hydrateJobPdfFreshness } from "@server/services/jobs/common";
import { type Request, type Response, Router } from "express";
import { z } from "zod";
import {
  transitionStageSchema,
  updateOutcomeSchema,
  updateStageEventSchema,
} from "./shared";

export const jobsStagesRouter = Router();

jobsStagesRouter.get("/:id/events", async (req: Request, res: Response) => {
  try {
    const events = await getStageEvents(req.params.id);
    ok(res, events);
  } catch (error) {
    fail(res, toAppError(error));
  }
});

jobsStagesRouter.get("/:id/tasks", async (req: Request, res: Response) => {
  try {
    const includeCompleted =
      req.query.includeCompleted === "1" ||
      req.query.includeCompleted === "true";
    const tasks = await getTasks(req.params.id, includeCompleted);
    ok(res, tasks);
  } catch (error) {
    fail(res, toAppError(error));
  }
});

jobsStagesRouter.post("/:id/stages", async (req: Request, res: Response) => {
  try {
    const input = transitionStageSchema.parse(req.body);
    const event = transitionJobStage(req.params.id, input, {
      route: "POST /api/jobs/:id/stages",
    });
    ok(res, event);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return fail(res, badRequest(error.message, error.flatten()));
    }
    fail(res, toAppError(error));
  }
});

jobsStagesRouter.patch(
  "/:id/events/:eventId",
  async (req: Request, res: Response) => {
    try {
      const input = updateStageEventSchema.parse(req.body);
      updateStageEvent(req.params.eventId, input);
      ok(res, null);
      queueMicrotask(() => {
        void reconcileActivationMilestonesFromHistorySafely({
          route: "PATCH /api/jobs/:id/events/:eventId",
          jobId: req.params.id,
          eventId: req.params.eventId,
        });
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return fail(res, badRequest(error.message, error.flatten()));
      }
      fail(res, toAppError(error));
    }
  },
);

jobsStagesRouter.delete(
  "/:id/events/:eventId",
  async (req: Request, res: Response) => {
    try {
      deleteStageEvent(req.params.eventId);
      ok(res, null);
      queueMicrotask(() => {
        void reconcileActivationMilestonesFromHistorySafely({
          route: "DELETE /api/jobs/:id/events/:eventId",
          jobId: req.params.id,
          eventId: req.params.eventId,
        });
      });
    } catch (error) {
      fail(res, toAppError(error));
    }
  },
);

jobsStagesRouter.patch("/:id/outcome", async (req: Request, res: Response) => {
  try {
    const input = updateOutcomeSchema.parse(req.body);
    const job = await setJobOutcome(req.params.id, input, {
      requestOrigin: resolveRequestOrigin(req),
      route: "PATCH /api/jobs/:id/outcome",
      source: "jobs_outcome_route",
    });
    ok(res, await hydrateJobPdfFreshness(job));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return fail(res, badRequest(error.message, error.flatten()));
    }
    fail(res, toAppError(error));
  }
});
