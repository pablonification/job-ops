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
import { getUserId, runWithRequestContext } from "@infra/request-context";
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
import * as pipelineSearchPresetsRepo from "@server/repositories/pipeline-search-presets";
import * as settingsRepo from "@server/repositories/settings";
import { trackCanonicalActivationEvent } from "@server/services/activation-funnel";
import { simulatePipelineRun } from "@server/services/demo-simulator";
import { closeHiringCafeBrowser } from "@server/services/hiring-cafe-browser";
import { reserveHostedUsage } from "@server/services/hosted-usage";
import { ensurePipelineSearchTerms } from "@server/services/pipeline-search-terms";
import { getPrivateDataScope } from "@server/tenancy/private-scope";
import { withoutUndefined } from "@server/utils/without-undefined";
import {
  createLocationIntent,
  planLocationSources,
} from "@shared/location-intelligence.js";
import { parseSearchCitiesSetting } from "@shared/search-cities";
import { settingsRegistry } from "@shared/settings-registry";
import type { PipelineRunTrigger, PipelineSearchPreset } from "@shared/types";
import {
  pipelineSearchPresetConfigSchema,
  type StartPipelineRunConfig,
  startPipelineRunSchema,
} from "./pipeline-search-config";

/** Who asked for a run. Stored on the run and shown in run history. */
export {
  PIPELINE_RUN_TRIGGERS,
  type PipelineRunTrigger,
} from "@shared/types";
export {
  type StartPipelineRunConfig,
  startPipelineRunSchema,
} from "./pipeline-search-config";

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

const NO_SOURCES_MESSAGE =
  "No job sources to search. Choose sources for this run, or save a search in the run dialog first.";

/** Fields that only make sense together: where to search. */
const LOCATION_PLACE_KEYS = ["country", "cityLocations", "proximity"] as const;

/** A saved search (preset) as run settings. */
function presetToRunConfig(
  preset: PipelineSearchPreset,
): StartPipelineRunConfig {
  const parsed = pipelineSearchPresetConfigSchema.safeParse(preset.config);
  if (!parsed.success) {
    throw badRequest(
      `The saved search "${preset.name}" is incomplete. Open it in the run dialog and save it again.`,
    );
  }
  const config = parsed.data;
  return startPipelineRunSchema.parse({
    topN: config.topN,
    minSuitabilityScore: config.minSuitabilityScore,
    sources: config.sources,
    runBudget: config.runBudget,
    searchTerms: config.searchTerms,
    scoringInstructions: config.scoringInstructions,
    country: config.country,
    cityLocations: config.cityLocations,
    // As in the run dialog: the map point is used only in radius mode.
    proximity:
      config.locationMode === "radius" ? (config.proximity ?? null) : null,
    workplaceTypes: config.workplaceTypes,
    searchScope: config.searchScope,
    matchStrictness: config.matchStrictness,
    watchlistSelectedSourceIds: config.watchlistSelectedSourceIds,
  });
}

/**
 * Where to search, from the stored search settings (the same values
 * `runPipeline` falls back to). Used when there is no saved search.
 */
async function storedSearchSettingsConfig(): Promise<StartPipelineRunConfig> {
  const stored = await settingsRepo.getAllSettings();
  const registry = settingsRegistry;
  const latitude = registry.locationLatitude.parse(stored.locationLatitude);
  const longitude = registry.locationLongitude.parse(stored.locationLongitude);
  const radiusMode =
    registry.locationSearchMode.parse(stored.locationSearchMode) === "radius";
  return withoutUndefined({
    country: stored.jobspyCountryIndeed?.trim() || undefined,
    cityLocations: parseSearchCitiesSetting(
      stored.searchCities ?? stored.jobspyLocation,
    ),
    proximity:
      radiusMode && latitude != null && longitude != null
        ? {
            latitude,
            longitude,
            radiusMiles:
              registry.locationRadiusMiles.parse(stored.locationRadiusMiles) ??
              registry.locationRadiusMiles.default(),
          }
        : null,
    workplaceTypes:
      registry.workplaceTypes.parse(stored.workplaceTypes) ?? undefined,
    searchScope:
      registry.locationSearchScope.parse(stored.locationSearchScope) ??
      undefined,
    matchStrictness:
      registry.locationMatchStrictness.parse(stored.locationMatchStrictness) ??
      undefined,
  }) as StartPipelineRunConfig;
}

export type ResolvedPipelineRunConfig = {
  config: StartPipelineRunConfig;
  /** The saved search the omitted fields came from, if any. */
  savedSearch: { id: string; name: string } | null;
};

/**
 * The run settings to use when the caller gives none or only some.
 *
 * Layers, lowest first; a field set in a higher layer wins:
 * 1. The stored search settings (country, cities or map point, workplace
 *    types, location scope and strictness). Only used when there is no
 *    saved search; search terms are filled later from the stored terms.
 * 2. The current user's saved search: `savedSearchId` when given (an
 *    unknown id is an error), else the most recently used one.
 * 3. The caller's explicit fields. Undefined fields never override. Where
 *    to search (country, cities, map point) is taken as a group: if the
 *    caller sets any of them, the lower layers' place is not mixed in.
 *
 * Throws `badRequest` when no sources result (nothing saved and none
 * passed); it never falls back to the built-in default sources.
 */
export async function resolvePipelineRunConfig(
  requested: StartPipelineRunConfig,
  options: { savedSearchId?: string | null; requireSources?: boolean } = {},
): Promise<ResolvedPipelineRunConfig> {
  const explicit = withoutUndefined(requested) as StartPipelineRunConfig;
  const savedSearchId = options.savedSearchId?.trim() || null;

  // Saved searches belong to a user; without one there are none to use.
  const presets = getUserId()
    ? await pipelineSearchPresetsRepo.listPipelineSearchPresets()
    : [];
  const preset = savedSearchId
    ? presets.find((candidate) => candidate.id === savedSearchId)
    : presets[0];
  if (savedSearchId && !preset) {
    throw badRequest(
      "The saved search chosen for this run no longer exists. Pick another saved search.",
    );
  }
  const base = preset
    ? presetToRunConfig(preset)
    : await storedSearchSettingsConfig();

  const callerSetsPlace = LOCATION_PLACE_KEYS.some((key) =>
    Object.hasOwn(explicit, key),
  );
  const lower = callerSetsPlace
    ? Object.fromEntries(
        Object.entries(base).filter(
          ([key]) => !(LOCATION_PLACE_KEYS as readonly string[]).includes(key),
        ),
      )
    : base;
  const config = { ...lower, ...explicit } as StartPipelineRunConfig;

  if ((options.requireSources ?? true) && !config.sources?.length) {
    throw badRequest(NO_SOURCES_MESSAGE);
  }
  return {
    config,
    savedSearch: preset ? { id: preset.id, name: preset.name } : null,
  };
}

/**
 * The extractor registry, or SERVICE_UNAVAILABLE when it failed to load.
 * `route` names the caller in the log.
 */
export async function loadExtractorRegistry(
  route = "/api/pipeline/run",
): Promise<ExtractorRegistry> {
  try {
    return await getExtractorRegistry();
  } catch (error) {
    logger.error("Extractor registry unavailable during source validation", {
      route,
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
  /** May be partial: omitted fields come from `resolvePipelineRunConfig`. */
  config: StartPipelineRunConfig;
  trigger: PipelineRunTrigger;
  /** Public origin for analytics; null when there is no HTTP request. */
  requestOrigin?: string | null;
  /** Saved search to fill omitted fields from; default the latest used. */
  savedSearchId?: string | null;
  /**
   * The config was already resolved by the caller (the scheduler, from the
   * search it chose): use it as is, so no field comes from another search.
   */
  configResolved?: boolean;
}): Promise<StartPipelineRunResult> {
  const { trigger } = args;
  // The demo simulates a run and needs no real sources.
  const requireSources = !isDemoMode();
  let config: StartPipelineRunConfig;
  if (args.configResolved) {
    config = args.config;
    if (requireSources && !config.sources?.length) {
      throw badRequest(NO_SOURCES_MESSAGE);
    }
  } else {
    ({ config } = await resolvePipelineRunConfig(args.config, {
      savedSearchId: args.savedSearchId,
      requireSources,
    }));
  }
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
      // Omitted fields stay absent so runPipeline's defaults apply.
      withoutUndefined({
        topN: config.topN,
        minSuitabilityScore: config.minSuitabilityScore,
        sources: config.sources,
        scoringInstructions: config.scoringInstructions,
        runBudget: config.runBudget,
        locationIntent,
        watchlistSelectedSourceIds: config.watchlistSelectedSourceIds,
      }),
      {
        hostedUsageReservationId: pipelineUsage.reservation?.id ?? null,
        trigger,
      },
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
