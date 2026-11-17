/**
 * Starting, cancelling and resuming pipeline runs.
 *
 * Shared by the REST routes (`/api/pipeline/run|cancel|resume-scoring`), the
 * MCP tools and, later, the in-process scheduler. Nothing here reads an HTTP
 * request: callers pass plain inputs, call from inside the caller's tenant
 * request context (`runWithRequestContext`), and get a result back or an
 * `AppError` thrown.
 */
import { badRequest, conflict, serviceUnavailable } from "@infra/errors";
import { logger } from "@infra/logger";
import { runWithRequestContext } from "@infra/request-context";
import { isDemoMode } from "@server/config/demo";
import {
  type ExtractorRegistry,
  getExtractorRegistry,
} from "@server/extractors/registry";
import {
  getPipelineStatus,
  requestPipelineCancel,
  resumePipelineScoring,
  runPipeline,
} from "@server/pipeline/index";
import { trackCanonicalActivationEvent } from "@server/services/activation-funnel";
import { simulatePipelineRun } from "@server/services/demo-simulator";
import { closeHiringCafeBrowser } from "@server/services/hiring-cafe-browser";
import { reserveHostedUsage } from "@server/services/hosted-usage";
import { ensurePipelineSearchTerms } from "@server/services/pipeline-search-terms";
import { getPrivateDataScope } from "@server/tenancy/private-scope";
import {
  createLocationIntent,
  planLocationSources,
} from "@shared/location-intelligence.js";
import type { StartPipelineRunConfig } from "./pipeline-search-config";

export {
  type StartPipelineRunConfig,
  startPipelineRunSchema,
} from "./pipeline-search-config";

/** Who asked for a run. Logged with the run start; not persisted yet. */
export const PIPELINE_RUN_TRIGGERS = ["user", "agent", "schedule"] as const;
export type PipelineRunTrigger = (typeof PIPELINE_RUN_TRIGGERS)[number];

export type StartPipelineRunResult =
  | { status: "started"; message: "Search started" }
  | {
      status: "simulated";
      simulated: Awaited<ReturnType<typeof simulatePipelineRun>>;
    };

function toSelectedSourcesValue(
  sources: readonly string[] | undefined,
): string | undefined {
  if (!Array.isArray(sources) || sources.length === 0) return undefined;
  return [...sources]
    .sort((left, right) => left.localeCompare(right))
    .join("|");
}

async function loadExtractorRegistry(): Promise<ExtractorRegistry> {
  try {
    return await getExtractorRegistry();
  } catch (error) {
    logger.error("Extractor registry unavailable during source validation", {
      route: "/api/pipeline/run",
      error,
    });
    throw serviceUnavailable(
      "Extractor registry is unavailable. Try again after fixing startup errors.",
    );
  }
}

/**
 * Validates a run request and starts the pipeline in the background.
 *
 * Checks, in order: requested sources exist at runtime, sources are
 * compatible with the location setup, no run is active for this tenant/user
 * (single-flight), search terms are available, and hosted usage can be
 * reserved. Then fires `runPipeline` without awaiting it and returns.
 *
 * Throws `badRequest` (unknown or incompatible sources), `conflict` (a run is
 * already active), `serviceUnavailable` (extractor registry down) or the
 * hosted quota error. In demo mode it returns a simulated result instead.
 */
export async function startPipelineRun(args: {
  config: StartPipelineRunConfig;
  trigger: PipelineRunTrigger;
  /** Public origin for analytics; null when there is no HTTP request. */
  requestOrigin?: string | null;
}): Promise<StartPipelineRunResult> {
  const { config, trigger } = args;
  const locationIntent = createLocationIntent({
    selectedCountry: config.country,
    cityLocations: config.cityLocations,
    proximity: config.proximity,
    workplaceTypes: config.workplaceTypes,
    geoScope: config.searchScope,
    matchStrictness: config.matchStrictness,
  });

  if (config.sources && config.sources.length > 0) {
    const registry = await loadExtractorRegistry();
    const unavailableSources = config.sources.filter(
      (source) => !registry.manifestBySource.has(source),
    );
    if (unavailableSources.length > 0) {
      throw badRequest(
        `Requested sources are not available at runtime: ${unavailableSources.join(", ")}`,
        { unavailableSources },
      );
    }

    const sourcePlans = planLocationSources({
      intent: locationIntent,
      sources: config.sources,
      capabilitiesBySource: registry.locationCapabilitiesBySource ?? {},
    });
    if (sourcePlans.incompatibleSources.length > 0) {
      const incompatible = sourcePlans.plans
        .filter((plan) => !plan.isCompatible)
        .map((plan) => ({ source: plan.source, reasons: plan.reasons }));
      throw badRequest(
        "Requested sources are incompatible with the selected location setup",
        { incompatibleSources: incompatible },
      );
    }
  }

  if (isDemoMode()) {
    const simulated = await simulatePipelineRun({
      topN: config.topN,
      minSuitabilityScore: config.minSuitabilityScore,
      sources: config.sources,
      scoringInstructions: config.scoringInstructions,
      locationIntent,
    });
    return { status: "simulated", simulated };
  }

  if (getPipelineStatus().isRunning) {
    throw conflict("Pipeline is already running");
  }

  const searchTermsState = await ensurePipelineSearchTerms({
    requestedSearchTerms: config.searchTerms,
  });
  const pipelineUsage = await reserveHostedUsage({ action: "pipeline_run" });

  // Start in the background, inside the caller's tenant/user context.
  runWithRequestContext({}, () => {
    runPipeline(
      {
        topN: config.topN,
        minSuitabilityScore: config.minSuitabilityScore,
        sources: config.sources,
        scoringInstructions: config.scoringInstructions,
        runBudget: config.runBudget,
        locationIntent,
        watchlistSelectedSourceIds: config.watchlistSelectedSourceIds,
      },
      { hostedUsageReservationId: pipelineUsage.reservation?.id ?? null },
    ).catch((error) => {
      logger.error("Background pipeline run failed", error);
    });
  });
  logger.info("Pipeline run started", {
    trigger,
    sourceCount: config.sources?.length ?? null,
    searchTermsSource: searchTermsState.source,
  });

  void trackCanonicalActivationEvent(
    "jobs_pipeline_run_started",
    {
      source_count: config.sources?.length,
      selected_sources: toSelectedSourcesValue(config.sources),
      top_n: config.topN,
      min_suitability_score: config.minSuitabilityScore,
      run_budget: config.runBudget,
      country: config.country,
      has_city_locations: Array.isArray(config.cityLocations)
        ? config.cityLocations.length > 0
        : false,
      search_terms_count: searchTermsState.searchTermsCount,
      search_terms_source: searchTermsState.source,
      // Count-only, never raw IDs (tenant safety / PII).
      watchlist_source_filter_count: Array.isArray(
        config.watchlistSelectedSourceIds,
      )
        ? config.watchlistSelectedSourceIds.length
        : undefined,
    },
    { requestOrigin: args.requestOrigin ?? null, urlPath: "/jobs" },
  );

  return { status: "started", message: "Search started" };
}

export type CancelPipelineRunResult = {
  message: string;
  pipelineRunId: string | null;
  alreadyRequested: boolean;
};

/**
 * Requests cancellation of the active run for this tenant/user and closes the
 * Hiring Cafe browser it may hold. Throws `conflict` when nothing is running.
 */
export async function cancelPipelineRun(): Promise<CancelPipelineRunResult> {
  const cancelResult = requestPipelineCancel();
  if (!cancelResult.accepted) {
    throw conflict("No running pipeline to cancel");
  }
  await closeHiringCafeBrowser(getPrivateDataScope().scopeKey);

  logger.info("Pipeline cancellation requested", {
    route: "/api/pipeline/cancel",
    action: "cancel",
    status: "accepted",
    pipelineRunId: cancelResult.pipelineRunId,
    alreadyRequested: cancelResult.alreadyRequested,
  });

  return {
    message: cancelResult.alreadyRequested
      ? "Pipeline cancellation already requested"
      : "Pipeline cancellation requested",
    pipelineRunId: cancelResult.pipelineRunId,
    alreadyRequested: cancelResult.alreadyRequested,
  };
}

/**
 * Resumes a run paused at `configuration_required` (LLM not configured).
 * Throws `conflict` when no run is waiting.
 */
export function resumePipelineRunScoring(): { resolved: true } {
  const { resolved } = resumePipelineScoring();
  if (!resolved) {
    throw conflict("Pipeline is not paused waiting for LLM configuration");
  }
  return { resolved: true };
}
