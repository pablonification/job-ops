/**
 * Input schemas for pipeline runs, saved searches (presets) and search
 * planning. Shared by the REST routes and the MCP tools so both validate the
 * same way.
 */
import { PIPELINE_EXTRACTOR_SOURCE_IDS } from "@shared/extractors";
import {
  LOCATION_INPUT_MODE_VALUES,
  LOCATION_MATCH_STRICTNESS_VALUES,
  LOCATION_SEARCH_SCOPE_VALUES,
} from "@shared/location-preferences.js";
import {
  MAX_PIPELINE_RUN_BUDGET,
  normalizePipelineRunBudget,
} from "@shared/types";
import { z } from "zod";

export const WORKPLACE_TYPE_VALUES = ["remote", "hybrid", "onsite"] as const;

export const pipelineSourceSchema = z.enum(
  PIPELINE_EXTRACTOR_SOURCE_IDS as [
    (typeof PIPELINE_EXTRACTOR_SOURCE_IDS)[number],
    ...(typeof PIPELINE_EXTRACTOR_SOURCE_IDS)[number][],
  ],
);

export const pipelineRunBudgetSchema = z
  .number()
  .int()
  .max(MAX_PIPELINE_RUN_BUDGET)
  .transform(normalizePipelineRunBudget);

const proximitySchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  radiusMiles: z.number().int().min(1).max(200),
});

/** Body of `POST /api/pipeline/run` and input of `start_pipeline_run`. */
export const startPipelineRunSchema = z.object({
  topN: z
    .number()
    .min(1)
    .max(50)
    .optional()
    .describe("How many top-scoring jobs to tailor automatically (1-50)."),
  minSuitabilityScore: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("Only tailor jobs scoring at least this (0-100)."),
  sources: z
    .array(pipelineSourceSchema)
    .min(1)
    .optional()
    .describe(
      "Job source ids to search (see list_sources). Omit for the saved defaults.",
    ),
  runBudget: pipelineRunBudgetSchema
    .optional()
    .describe("Maximum number of jobs to collect across all sources."),
  searchTerms: z
    .array(z.string().trim().min(1))
    .optional()
    .describe(
      "Job titles to search for. They are saved as the default search terms.",
    ),
  scoringInstructions: z
    .string()
    .trim()
    .max(4000)
    .optional()
    .describe("Extra ranking preferences for scoring this run."),
  country: z
    .string()
    .trim()
    .optional()
    .describe("Country to search in, e.g. indonesia or united kingdom."),
  cityLocations: z
    .array(z.string().trim().min(1))
    .optional()
    .describe("Cities to search in, e.g. Jakarta."),
  proximity: proximitySchema
    .nullable()
    .optional()
    .describe("Search around a map point instead of named cities."),
  workplaceTypes: z
    .array(z.enum(WORKPLACE_TYPE_VALUES))
    .min(1)
    .max(3)
    .optional(),
  searchScope: z.enum(LOCATION_SEARCH_SCOPE_VALUES).optional(),
  matchStrictness: z.enum(LOCATION_MATCH_STRICTNESS_VALUES).optional(),
  // Per-#621: optional client-supplied per-run Watchlist source filter.
  // Omitted preserves the legacy "include every saved Watchlist source"
  // behavior; [] disables Watchlist entirely; non-empty restricts to a
  // subset. Cross-tenant safety is enforced by re-resolving IDs against
  // the user's saved Watchlist sources inside discoverJobsStep.
  watchlistSelectedSourceIds: z
    .array(z.string().min(1).max(128))
    .optional()
    .describe(
      "Watchlist source ids to include. Omit for all saved Watchlist sources; [] for none.",
    ),
});

export type StartPipelineRunConfig = z.output<typeof startPipelineRunSchema>;

export const pipelineSearchPresetConfigSchema = z.object({
  searchTerms: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
  sources: z.array(pipelineSourceSchema).min(1),
  country: z.string().trim().max(100),
  cityLocations: z.array(z.string().trim().min(1).max(100)).max(25),
  locationMode: z.enum(LOCATION_INPUT_MODE_VALUES).optional(),
  proximity: proximitySchema.nullable().optional(),
  workplaceTypes: z.array(z.enum(WORKPLACE_TYPE_VALUES)).min(1).max(3),
  searchScope: z.enum(LOCATION_SEARCH_SCOPE_VALUES),
  matchStrictness: z.enum(LOCATION_MATCH_STRICTNESS_VALUES),
  topN: z.number().int().min(1).max(50),
  minSuitabilityScore: z.number().int().min(0).max(100),
  runBudget: pipelineRunBudgetSchema,
  scoringInstructions: z.string().trim().max(4000).optional().default(""),
  automaticPresetId: z
    .enum(["fast", "balanced", "detailed", "custom"])
    .optional(),
  // Optional per-#621 Watchlist source selection persisted with the preset.
  // Omitted = legacy behavior (include every saved Watchlist source).
  watchlistSelectedSourceIds: z
    .array(z.string().min(1).max(128))
    .max(200)
    .optional(),
});

export const createPipelineSearchPresetSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    config: pipelineSearchPresetConfigSchema,
  })
  .strict();

export const updatePipelineSearchPresetSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    config: pipelineSearchPresetConfigSchema.optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.config !== undefined, {
    message: "Provide a name or config update",
  });

export const pipelineSearchPlanSchema = z
  .object({
    prompt: z.string().trim().min(1).max(2000),
    currentConfig: pipelineSearchPresetConfigSchema,
  })
  .strict();
