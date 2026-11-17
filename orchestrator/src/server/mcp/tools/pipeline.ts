import { badRequest, conflict, notFound } from "@infra/errors";
import {
  defineTool,
  defineToolGroup,
  paginateArray,
  paginationShape,
  toPageMeta,
} from "@server/mcp/kit";
import {
  getPendingChallenges,
  getPipelineStatus,
  getProgress,
} from "@server/pipeline/index";
import * as pipelineRepo from "@server/repositories/pipeline";
import * as pipelineSearchPresetsRepo from "@server/repositories/pipeline-search-presets";
import { getSettingsPresence } from "@server/services/envSettings";
import { checkExtractorHealth } from "@server/services/extractor-health";
import {
  cancelPipelineRun,
  loadExtractorRegistry,
  resumePipelineRunScoring,
  startPipelineRun,
  startPipelineRunSchema,
} from "@server/services/pipeline-run";
import {
  createPipelineSearchPresetSchema,
  pipelineSearchPresetConfigSchema,
  pipelineSourceSchema,
  updatePipelineSearchPresetSchema,
} from "@server/services/pipeline-search-config";
import { planPipelineSearch } from "@server/services/pipeline-search-plan";
import {
  EXTRACTOR_SOURCE_METADATA,
  type ExtractorSourceId,
  PIPELINE_EXTRACTOR_SOURCE_IDS,
} from "@shared/extractors";
import { normalizeLocationSourceCapabilities } from "@shared/location-domain.js";
import type { SettingsRegistryKey } from "@shared/settings-registry";
import type {
  PipelinePendingChallenge,
  PipelineProgressState,
  PipelineRun,
} from "@shared/types";
import { z } from "zod";

const idInput = (description: string) =>
  z.string().trim().min(1).max(200).describe(description);

/** The config snapshot is large and rarely useful in run lists. */
function toRunSummary(run: PipelineRun) {
  const { configSnapshot: _configSnapshot, ...summary } = run;
  return summary;
}

function toChallengeSummary(challenge: PipelinePendingChallenge) {
  return {
    extractorId: challenge.extractorId,
    extractorName: challenge.extractorName,
    url: challenge.url,
    sources: challenge.sources,
    canSkipSearch: challenge.canSkipSearch === true,
    solveAttempted: challenge.solveAttempted === true,
  };
}

/** What the human (or agent) must do when a run is paused. */
function describeActionRequired(
  progress: PipelineProgressState,
  challenges: PipelinePendingChallenge[],
) {
  if (progress.step === "challenge_required") {
    const names = challenges.map((challenge) => challenge.extractorName);
    return {
      kind: "challenge" as const,
      who: "human" as const,
      message: `The run is paused: ${
        names.length > 0 ? names.join(", ") : "a job site"
      } showed a bot check (Cloudflare challenge). Ask the user to open JobOps in a browser, go to the running search, and solve or skip the challenge there. The run continues by itself afterwards; keep polling get_pipeline_progress.`,
      challenges: challenges.map(toChallengeSummary),
    };
  }
  if (progress.step === "configuration_required") {
    return {
      kind: "llm_configuration" as const,
      who: "human" as const,
      message:
        "The run is paused before scoring because no AI model is configured. Ask the user to set the AI provider and key in the JobOps web app (Settings); agents cannot change them. Then call resume_pipeline_scoring, or cancel_pipeline_run to stop the run.",
    };
  }
  return null;
}

const startPipelineRunTool = defineTool({
  name: "start_pipeline_run",
  title: "Start a job discovery run",
  description:
    "Start a pipeline run that searches job sites, imports and scores new jobs, and tailors the best ones. Returns immediately; poll get_pipeline_progress until step is completed, cancelled or failed. Every field is optional. Omitted fields are taken from your most recently used saved search (see list_search_presets); fields you pass override it. Passing country, cityLocations or proximity replaces the saved search's whole location. With no saved search, the location comes from your search settings (get_settings), search terms from the saved search terms, and you must pass sources. Fails with INVALID_REQUEST when no sources result or a source does not support the chosen location (see list_sources), and with CONFLICT if a run is already active.",
  scope: "write",
  openWorld: true,
  input: startPipelineRunSchema.strict(),
  handler: async (config, context) => {
    const result = await startPipelineRun({
      config,
      trigger: "agent",
      requestOrigin: context.requestOrigin,
    });
    if (result.status === "simulated") {
      return { started: false, simulated: true, result: result.simulated };
    }
    return {
      started: true,
      message: result.message,
      isRunning: getPipelineStatus().isRunning,
      progress: getProgress(),
      next: "Poll get_pipeline_progress every 15-30 seconds until step is completed, cancelled or failed.",
    };
  },
});

const getPipelineProgressTool = defineTool({
  name: "get_pipeline_progress",
  title: "Get pipeline run progress",
  description:
    "Progress of the current or last pipeline run: step (idle, crawling, importing, scoring, processing, completed, cancelled, failed, or paused at challenge_required / configuration_required), counters, and actionRequired explaining what must happen when the run is paused.",
  scope: "read",
  input: z.object({}).strict(),
  handler: async () => {
    const { isRunning } = getPipelineStatus();
    const progress = getProgress();
    const challenges = getPendingChallenges();
    const lastRun = await pipelineRepo.getLatestPipelineRun();
    const { pendingChallenges: _pendingChallenges, ...counters } = progress;
    return {
      isRunning,
      step: progress.step,
      message: progress.message,
      paused:
        progress.step === "challenge_required" ||
        progress.step === "configuration_required",
      actionRequired: describeActionRequired(progress, challenges),
      progress: counters,
      lastRun: lastRun ? toRunSummary(lastRun) : null,
    };
  },
});

const cancelPipelineRunTool = defineTool({
  name: "cancel_pipeline_run",
  title: "Cancel the pipeline run",
  description:
    "Request cancellation of the active pipeline run. Jobs already imported are kept. Fails with CONFLICT when no run is active.",
  scope: "write",
  idempotent: true,
  input: z.object({}).strict(),
  handler: async () => ({ ...(await cancelPipelineRun()) }),
});

const resumePipelineScoringTool = defineTool({
  name: "resume_pipeline_scoring",
  title: "Resume scoring after LLM setup",
  description:
    "Resume a pipeline run paused at configuration_required once an AI model is configured. Fails with CONFLICT when no run is waiting.",
  scope: "write",
  input: z.object({}).strict(),
  handler: async () => ({ ...resumePipelineRunScoring() }),
});

const listPipelineRunsTool = defineTool({
  name: "list_pipeline_runs",
  title: "List past pipeline runs",
  description:
    "Past pipeline runs, newest first: status, start and end time, jobs discovered and processed, error message. Call get_pipeline_run for one run's settings and metrics.",
  scope: "read",
  input: z.object({ ...paginationShape }).strict(),
  handler: async ({ limit, offset }) => {
    const { runs, total } = await pipelineRepo.listPipelineRunsPage({
      limit,
      offset,
    });
    return {
      runs: runs.map(toRunSummary),
      ...toPageMeta({ limit, offset, total, returned: runs.length }),
    };
  },
});

const getPipelineRunTool = defineTool({
  name: "get_pipeline_run",
  title: "Get one pipeline run",
  description:
    "One pipeline run with the settings it ran with (requested and effective), its result summary, duration, and jobs created, updated and processed during it.",
  scope: "read",
  input: z
    .object({ runId: idInput("Run id from list_pipeline_runs.") })
    .strict(),
  handler: async ({ runId }) => {
    const insights = await pipelineRepo.getPipelineRunInsights(runId);
    if (!insights) throw notFound("Pipeline run not found");
    return { ...insights };
  },
});

const planSearchTool = defineTool({
  name: "plan_search",
  title: "Plan a search from a request",
  description:
    "Turn a natural-language request (e.g. 'remote backend roles in Indonesia, prefer fintech') into search settings: terms, sources, location, volume and ranking preferences. Calls the AI model (costs tokens); does not start a run or save anything. Pass the result's config fields to start_pipeline_run or save_search_preset.",
  scope: "read",
  // Changes no data, but spends model usage, so not marked read-only.
  readOnly: false,
  openWorld: true,
  input: z
    .object({
      prompt: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("What the user wants to search for."),
      currentConfig: pipelineSearchPresetConfigSchema
        .optional()
        .describe(
          "Settings to start from. Omit to start from presetId or the most recently used saved search.",
        ),
      presetId: idInput(
        "Saved search to start from (see list_search_presets).",
      ).optional(),
    })
    .strict(),
  handler: async ({ prompt, currentConfig, presetId }) => {
    let baseConfig = currentConfig;
    if (!baseConfig) {
      const presets =
        await pipelineSearchPresetsRepo.listPipelineSearchPresets();
      const preset = presetId
        ? presets.find((candidate) => candidate.id === presetId)
        : presets[0];
      if (presetId && !preset) throw notFound("Saved search not found");
      if (!preset) {
        throw badRequest(
          "Pass currentConfig, or save a search first with save_search_preset.",
        );
      }
      baseConfig = pipelineSearchPresetConfigSchema.parse(preset.config);
    }
    return {
      ...(await planPipelineSearch({ prompt, currentConfig: baseConfig })),
    };
  },
});

/**
 * Settings each credentialed source needs (mirrors the Run panel). A source
 * whose metadata says `requiresCredentials` but has no entry here reports
 * `configured: false`, and a test fails.
 */
const SOURCE_CREDENTIAL_SETTINGS: Partial<
  Record<ExtractorSourceId, readonly SettingsRegistryKey[]>
> = {
  ukvisajobs: ["ukvisajobsEmail", "ukvisajobsPassword"],
  adzuna: ["adzunaAppId", "adzunaAppKey"],
  seek: ["apifyToken"],
};

const sourcesInput = z
  .array(pipelineSourceSchema)
  .min(1)
  .describe("Source ids from list_sources.");

const listSourcesTool = defineTool({
  name: "list_sources",
  title: "List job sources",
  description:
    "Job sources the pipeline can search: id, label, whether available on this server, supported countries (null = any), whether a country or city is required, and credential needs (configured or not). check_source_health runs a live test search.",
  scope: "read",
  input: z
    .object({
      sources: sourcesInput
        .optional()
        .describe("Only these source ids. Default: all pipeline sources."),
    })
    .strict(),
  handler: async ({ sources }) => {
    const registry = await loadExtractorRegistry("MCP list_sources");
    const selected = sources ?? [...PIPELINE_EXTRACTOR_SOURCE_IDS];
    const presence = await getSettingsPresence([
      ...new Set(
        selected.flatMap((source) => SOURCE_CREDENTIAL_SETTINGS[source] ?? []),
      ),
    ]);

    return {
      sources: selected.map((source) => {
        const metadata = EXTRACTOR_SOURCE_METADATA[source];
        const capabilities = normalizeLocationSourceCapabilities(
          registry.locationCapabilitiesBySource?.[source] ?? { source },
        );
        const required = metadata.requiresCredentials === true;
        const settings = SOURCE_CREDENTIAL_SETTINGS[source] ?? [];
        return {
          id: source,
          label: metadata.label,
          availableAtRuntime: registry.manifestBySource.has(source),
          supportedCountries: capabilities.supportedCountryKeys,
          requiresCountry: capabilities.requiresSelectedCountry,
          requiresCityLocations: capabilities.requiresCityLocations,
          credentials: {
            required,
            settings,
            // Fail closed: a credentialed source without a known settings
            // list never reports configured.
            configured: required
              ? settings.length > 0 &&
                settings.every((key) => presence[key]?.set === true)
              : true,
          },
        };
      }),
    };
  },
});

const MAX_HEALTH_CHECK_SOURCES = 5;

const checkSourceHealthTool = defineTool({
  name: "check_source_health",
  title: "Check job source health",
  description:
    "Run a small live test search on each given source to see whether it works right now. Slow, and it uses the source (some sources bill per run), so check only the sources you are about to use. Results are cached for a while.",
  scope: "write",
  idempotent: true,
  openWorld: true,
  input: z
    .object({ sources: sourcesInput.max(MAX_HEALTH_CHECK_SOURCES) })
    .strict(),
  handler: async ({ sources }) => {
    const registry = await loadExtractorRegistry("MCP check_source_health");
    const results = [];
    for (const source of sources) {
      if (!registry.manifestBySource.has(source)) {
        results.push({ id: source, availableAtRuntime: false, health: null });
        continue;
      }
      const health = await checkExtractorHealth(source);
      results.push({
        id: source,
        availableAtRuntime: true,
        health: health
          ? {
              healthy: health.healthy,
              status: health.response.status,
              message: health.errorMessage ?? health.response.message,
              checkedAt: health.response.checkedAt,
              jobsReturned: health.response.jobsReturned,
              cached: health.response.cached,
            }
          : null,
      });
    }
    return { sources: results };
  },
});

const listSearchPresetsTool = defineTool({
  name: "list_search_presets",
  title: "List saved searches",
  description:
    "The user's saved searches (presets), most recently used first, each with its full config (terms, sources, location, volume, ranking preferences).",
  scope: "read",
  input: z.object({ ...paginationShape }).strict(),
  handler: async (input) => {
    const presets = await pipelineSearchPresetsRepo.listPipelineSearchPresets();
    const { items, page } = paginateArray(presets, input);
    return { presets: items, ...page };
  },
});

const saveSearchPresetTool = defineTool({
  name: "save_search_preset",
  title: "Save a search",
  description:
    "Create a saved search (name + config), or update one by id (name and/or config). Names are unique per user (CONFLICT otherwise). config has the same fields as a plan_search result.",
  scope: "write",
  input: z
    .object({
      id: idInput("Saved search to update. Omit to create one.").optional(),
      name: z.string().trim().min(1).max(80).optional(),
      config: pipelineSearchPresetConfigSchema.optional(),
    })
    .strict(),
  handler: async ({ id, ...fields }) => {
    if (!id) {
      const input = createPipelineSearchPresetSchema.parse(fields);
      if (
        await pipelineSearchPresetsRepo.pipelineSearchPresetNameExists({
          name: input.name,
        })
      ) {
        throw conflict("A saved search with this name already exists");
      }
      return {
        created: true,
        preset:
          await pipelineSearchPresetsRepo.createPipelineSearchPreset(input),
      };
    }

    const input = updatePipelineSearchPresetSchema.parse(fields);
    if (
      input.name !== undefined &&
      (await pipelineSearchPresetsRepo.pipelineSearchPresetNameExists({
        name: input.name,
        excludingId: id,
      }))
    ) {
      throw conflict("A saved search with this name already exists");
    }
    const updated = await pipelineSearchPresetsRepo.updatePipelineSearchPreset(
      id,
      input,
    );
    if (!updated) throw notFound("Saved search not found");
    return { created: false, preset: updated };
  },
});

const deleteSearchPresetTool = defineTool({
  name: "delete_search_preset",
  title: "Delete a saved search",
  description:
    "Delete one saved search by id. Jobs and past runs are not affected.",
  scope: "write",
  destructive: true,
  input: z
    .object({ id: idInput("Saved search id from list_search_presets.") })
    .strict(),
  handler: async ({ id }) => {
    const deleted =
      await pipelineSearchPresetsRepo.deletePipelineSearchPreset(id);
    if (deleted === 0) throw notFound("Saved search not found");
    return { deleted: true, id };
  },
});

export const pipelineToolGroup = defineToolGroup({
  id: "pipeline",
  tools: [
    startPipelineRunTool,
    getPipelineProgressTool,
    cancelPipelineRunTool,
    resumePipelineScoringTool,
    listPipelineRunsTool,
    getPipelineRunTool,
    planSearchTool,
    listSourcesTool,
    checkSourceHealthTool,
    listSearchPresetsTool,
    saveSearchPresetTool,
    deleteSearchPresetTool,
  ],
});
