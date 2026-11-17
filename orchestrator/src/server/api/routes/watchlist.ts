import { badRequest, toAppError, unprocessableEntity } from "@infra/errors";
import { asyncRoute, fail, ok } from "@infra/http";
import * as watchlistRepo from "@server/repositories/watchlist";
import { getWatchlistSourceAdapter } from "@server/watchlist/adapters";
import {
  getCurrentWatchlistResults,
  getWatchlistSelectedSourceById,
  withWatchlistSourceTimeout,
} from "@server/watchlist/results";
import {
  getWatchlistSources,
  replaceWatchlistSources,
  updateWatchlistSelectionsSchema,
} from "@server/watchlist/selections";
import {
  MAX_WATCHLIST_SOURCES,
  type WatchlistResultsResponse,
} from "@shared/types";
import { type Request, type Response, Router } from "express";
import { z } from "zod";

export const watchlistRouter = Router();

const watchlistStateParamsSchema = z.object({
  source: z.string().trim().min(1).max(120),
  sourceJobId: z.string().trim().min(1).max(500),
});

const watchlistCheckSchema = z.object({
  checks: z
    .array(
      z.object({
        source: z.string().trim().min(1).max(120),
        sourceJobIds: z.array(z.string().trim().min(1).max(500)).max(200),
      }),
    )
    .max(MAX_WATCHLIST_SOURCES),
});

const watchlistSourceJobSchema = z.object({
  selectedSourceId: z.string().trim().min(1).max(500),
  jobRef: z.string().trim().min(1).max(3000),
});

const watchlistSourceBrandingSchema = z.object({
  selectedSourceId: z.string().trim().min(1).max(500).nullable().optional(),
  sourceType: z.string().trim().min(1).max(120),
  careersUrl: z.string().trim().url().max(2000),
});

watchlistRouter.get(
  "/states",
  asyncRoute(async (_req: Request, res: Response) => {
    ok(res, { states: await watchlistRepo.listWatchlistJobStates() });
  }),
);

watchlistRouter.get(
  "/sources",
  asyncRoute(async (_req: Request, res: Response) => {
    ok(res, await getWatchlistSources());
  }),
);

watchlistRouter.post(
  "/results",
  asyncRoute(async (_req: Request, res: Response) => {
    ok(
      res,
      (await getCurrentWatchlistResults()) satisfies WatchlistResultsResponse,
    );
  }),
);

watchlistRouter.post(
  "/job-details",
  asyncRoute(async (req: Request, res: Response) => {
    const parsedBody = watchlistSourceJobSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      return fail(
        res,
        badRequest(
          "Invalid watchlist job details payload",
          parsedBody.error.flatten(),
        ),
      );
    }

    try {
      const source = await getWatchlistSelectedSourceById(
        parsedBody.data.selectedSourceId,
      );
      const adapter = getWatchlistSourceAdapter(source.sourceType);
      if (!adapter) {
        return fail(
          res,
          unprocessableEntity("Unsupported watchlist source type", {
            sourceType: source.sourceType,
          }),
        );
      }
      ok(
        res,
        await withWatchlistSourceTimeout((signal) =>
          adapter.fetchJobDetails({
            source,
            jobRef: parsedBody.data.jobRef,
            signal,
          }),
        ),
      );
    } catch (error) {
      fail(res, toAppError(error));
    }
  }),
);

watchlistRouter.post(
  "/import-draft",
  asyncRoute(async (req: Request, res: Response) => {
    const parsedBody = watchlistSourceJobSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      return fail(
        res,
        badRequest(
          "Invalid watchlist import payload",
          parsedBody.error.flatten(),
        ),
      );
    }

    try {
      const source = await getWatchlistSelectedSourceById(
        parsedBody.data.selectedSourceId,
      );
      const adapter = getWatchlistSourceAdapter(source.sourceType);
      if (!adapter) {
        return fail(
          res,
          unprocessableEntity("Unsupported watchlist source type", {
            sourceType: source.sourceType,
          }),
        );
      }
      const result = await withWatchlistSourceTimeout((signal) =>
        adapter.prepareImportDraft({
          source,
          jobRef: parsedBody.data.jobRef,
          signal,
        }),
      );

      ok(res, {
        ...result,
        sourceType: source.sourceType,
        catalogSourceId: source.catalogSourceId,
        careersUrl: source.careersUrl,
      });
    } catch (error) {
      fail(res, toAppError(error));
    }
  }),
);

watchlistRouter.post(
  "/source-branding",
  asyncRoute(async (req: Request, res: Response) => {
    const parsedBody = watchlistSourceBrandingSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      return fail(
        res,
        badRequest(
          "Invalid watchlist source branding payload",
          parsedBody.error.flatten(),
        ),
      );
    }

    try {
      const selectedSource = parsedBody.data.selectedSourceId
        ? await getWatchlistSelectedSourceById(parsedBody.data.selectedSourceId)
        : null;
      const source = selectedSource ?? {
        sourceType: parsedBody.data.sourceType,
        careersUrl: parsedBody.data.careersUrl,
      };
      const adapter = getWatchlistSourceAdapter(source.sourceType);
      const fetchBranding = adapter?.fetchBranding;
      if (!fetchBranding) {
        return fail(
          res,
          unprocessableEntity("Watchlist source branding is not supported", {
            sourceType: source.sourceType,
          }),
        );
      }

      ok(
        res,
        await withWatchlistSourceTimeout((signal) =>
          fetchBranding({
            source,
            signal,
          }),
        ),
      );
    } catch (error) {
      fail(res, toAppError(error));
    }
  }),
);

watchlistRouter.post(
  "/checks",
  asyncRoute(async (req: Request, res: Response) => {
    const parsedBody = watchlistCheckSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      return fail(
        res,
        badRequest(
          "Invalid watchlist check payload",
          parsedBody.error.flatten(),
        ),
      );
    }

    ok(res, await watchlistRepo.recordWatchlistCheck(parsedBody.data));
  }),
);

watchlistRouter.put(
  "/sources",
  asyncRoute(async (req: Request, res: Response) => {
    const parsedBody = updateWatchlistSelectionsSchema.safeParse(
      req.body ?? {},
    );
    if (!parsedBody.success) {
      return fail(
        res,
        badRequest(
          "Invalid watchlist source selections",
          parsedBody.error.flatten(),
        ),
      );
    }

    ok(res, await replaceWatchlistSources(parsedBody.data.selections));
  }),
);

watchlistRouter.put(
  "/states/:source/:sourceJobId",
  asyncRoute(async (req: Request, res: Response) => {
    const parsedParams = watchlistStateParamsSchema.safeParse(req.params);
    if (!parsedParams.success) {
      return fail(
        res,
        badRequest(
          "Invalid watchlist state parameters",
          parsedParams.error.flatten(),
        ),
      );
    }

    const state = await watchlistRepo.setWatchlistJobState({
      ...parsedParams.data,
      state: "ignored",
    });

    ok(res, { state });
  }),
);

watchlistRouter.delete(
  "/states/:source/:sourceJobId",
  asyncRoute(async (req: Request, res: Response) => {
    const parsedParams = watchlistStateParamsSchema.safeParse(req.params);
    if (!parsedParams.success) {
      return fail(
        res,
        badRequest(
          "Invalid watchlist state parameters",
          parsedParams.error.flatten(),
        ),
      );
    }

    await watchlistRepo.clearWatchlistJobState(parsedParams.data);
    ok(res, { cleared: true });
  }),
);
