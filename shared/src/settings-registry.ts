import { z } from "zod";
import {
  LOCATION_INPUT_MODE_VALUES,
  LOCATION_MATCH_STRICTNESS_VALUES,
  LOCATION_SEARCH_SCOPE_VALUES,
} from "./location-preferences";
import {
  DEFAULT_DIGEST_MAX_JOBS,
  DEFAULT_SCHEDULE_CATCH_UP_MINUTES,
  DEFAULT_SCHEDULE_TIME,
  DEFAULT_SCHEDULE_TIME_ZONE,
  DIGEST_MODE_VALUES,
  type DigestMode,
  isValidScheduleTime,
  isValidTimeZone,
  MAX_DIGEST_MAX_JOBS,
  MAX_SCHEDULE_CATCH_UP_MINUTES,
  SCHEDULE_WEEKDAY_VALUES,
  type ScheduleWeekday,
  TELEGRAM_BOT_TOKEN_PATTERN,
  TELEGRAM_CHAT_ID_PATTERN,
} from "./pipeline-schedule";
import { getDefaultPromptTemplate } from "./prompt-template-definitions";
import { normalizeTargetCompanyLines } from "./target-companies";
import {
  ROLE_CV_PIPELINE_MODE_VALUES,
  type RoleCvPipelineMode,
} from "./types/role-cvs";
import {
  CHAT_STYLE_LANGUAGE_MODE_VALUES,
  CHAT_STYLE_MANUAL_LANGUAGE_VALUES,
  type ChatStyleLanguageMode,
  type ChatStyleManualLanguage,
  LLM_PROVIDER_VALUES,
  LLM_PURPOSE_VALUES,
  type LlmProviderId,
  type LlmPurposeApiKeys,
  type LlmPurposeOverrides,
  PDF_PAPER_SIZE_VALUES,
  PDF_RENDERER_VALUES,
  type PdfPaperSize,
  type PdfRenderer,
  type ResumeProjectsSettings,
  TYPST_THEME_VALUES,
  type TypstTheme,
} from "./types/settings";

function parseNonEmptyStringOrNull(raw: string | undefined): string | null {
  return raw === undefined || raw === "" ? null : raw;
}

function parseIntOrNull(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseNumberOrNull(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJsonArrayOrNull(raw: string | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

function parseBitBoolOrNull(raw: string | undefined): boolean | null {
  if (!raw) return null;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return null;
}

const GLM_PROVIDER_ALIASES = new Set([
  "zhipu",
  "zhipu_ai",
  "zhipuai",
  "bigmodel",
  "zai",
  "z_ai",
]);

/**
 * Map known GLM provider aliases to "glm".
 * `normalized` should already be lowercased with separators (-, .) replaced by underscores.
 */
export function mapGlmProviderAlias(normalized: string): string {
  return GLM_PROVIDER_ALIASES.has(normalized) ? "glm" : normalized;
}

function normalizeLlmProviderOrNull(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const normalized = raw.trim().toLowerCase().replace(/[-.]/g, "_");
  const mapped = mapGlmProviderAlias(normalized);
  if (mapped === "claude") return "anthropic";
  return mapped || null;
}

export const DEFAULT_GEMINI_MODEL = "google/gemini-3-flash-preview";
export const DEFAULT_ATLAS_CLOUD_MODEL = "deepseek-ai/deepseek-v3.2";
export const DEFAULT_API_ROUTE_MODEL = "gpt-6.1-sol";
export const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
export const DEFAULT_GLM_MODEL = "glm-5.1";
export const DEFAULT_CODEX_MODEL = "gpt-5.4-mini";
export const DEFAULT_CLAUDE_CLI_MODEL = "claude-sonnet-5";
export const DEFAULT_CLAUDE_AGENT_SDK_MODEL = "sonnet";

export function getDefaultModelForProvider(
  provider: string | null | undefined,
  fallbackModel?: string | null,
): string {
  const trimmedFallback = fallbackModel?.trim();
  if (trimmedFallback) {
    return trimmedFallback;
  }

  const normalizedProvider = normalizeLlmProviderOrNull(provider ?? undefined);

  if (normalizedProvider === "api_route") {
    return DEFAULT_API_ROUTE_MODEL;
  }

  if (
    normalizedProvider === "atlascloud" ||
    normalizedProvider === "atlas_cloud"
  ) {
    return DEFAULT_ATLAS_CLOUD_MODEL;
  }

  if (normalizedProvider === "openai") {
    return DEFAULT_OPENAI_MODEL;
  }

  if (normalizedProvider === "anthropic") {
    return DEFAULT_ANTHROPIC_MODEL;
  }

  if (normalizedProvider === "gemini" || normalizedProvider === "gemini_cli") {
    return DEFAULT_GEMINI_MODEL;
  }

  if (normalizedProvider === "claude_cli") {
    return DEFAULT_CLAUDE_CLI_MODEL;
  }

  if (normalizedProvider === "claude_agent_sdk") {
    return DEFAULT_CLAUDE_AGENT_SDK_MODEL;
  }

  if (normalizedProvider === "glm") {
    return DEFAULT_GLM_MODEL;
  }

  if (normalizedProvider === "codex") {
    return DEFAULT_CODEX_MODEL;
  }

  // Both serve whatever the operator has installed or configured, so there
  // is no model name that is right everywhere.
  if (normalizedProvider === "ollama" || normalizedProvider === "litellm") {
    return "";
  }
  return DEFAULT_GEMINI_MODEL;
}

function serializeNullableNumber(
  value: number | null | undefined,
): string | null {
  return value !== null && value !== undefined ? String(value) : null;
}

function serializeNullableJsonArray(
  value: string[] | null | undefined,
): string | null {
  return value !== null && value !== undefined ? JSON.stringify(value) : null;
}

function serializeBitBool(value: boolean | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value ? "1" : "0";
}

function createEnumParser<const TValues extends readonly [string, ...string[]]>(
  values: TValues,
): (raw: string | undefined) => TValues[number] | null {
  const allowedValues = new Set<string>(values);

  return (raw: string | undefined): TValues[number] | null => {
    if (!raw) return null;
    return allowedValues.has(raw) ? (raw as TValues[number]) : null;
  };
}

function createEnumArrayParser<
  const TValues extends readonly [string, ...string[]],
>(values: TValues): (raw: string | undefined) => TValues[number][] | null {
  const allowedValues = new Set<string>(values);

  return (raw: string | undefined): TValues[number][] | null => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return null;

      const out: TValues[number][] = [];
      const seen = new Set<string>();
      for (const value of parsed) {
        if (typeof value !== "string" || !allowedValues.has(value)) {
          return null;
        }
        if (seen.has(value)) continue;
        seen.add(value);
        out.push(value as TValues[number]);
      }
      if (out.length === 0) return null;
      return out;
    } catch {
      return null;
    }
  };
}

const parseChatStyleLanguageModeOrNull = createEnumParser(
  CHAT_STYLE_LANGUAGE_MODE_VALUES,
);

const parseChatStyleManualLanguageOrNull = createEnumParser(
  CHAT_STYLE_MANUAL_LANGUAGE_VALUES,
);
const parsePdfRendererOrNull = createEnumParser(PDF_RENDERER_VALUES);
const parseTypstThemeOrNull = createEnumParser(TYPST_THEME_VALUES);
const parsePdfPaperSizeOrNull = createEnumParser(PDF_PAPER_SIZE_VALUES);

const llmPurposeOverrideSchema = z.object({
  provider: z.preprocess(
    (value) =>
      typeof value === "string" ? normalizeLlmProviderOrNull(value) : value,
    z.enum(LLM_PROVIDER_VALUES).nullable().optional(),
  ),
  baseUrl: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? null : value,
    z.string().trim().url().max(2000).nullable().optional(),
  ),
  model: z.preprocess(
    (value) => (value === "" ? null : value),
    z.string().trim().max(200).nullable().optional(),
  ),
});

export const llmPurposeOverridesSchema = z
  .object({
    scoring: llmPurposeOverrideSchema.optional(),
    tailoring: llmPurposeOverrideSchema.optional(),
    projectSelection: llmPurposeOverrideSchema.optional(),
  })
  .strict();

export const llmPurposeApiKeysSchema = z
  .object({
    scoring: z.string().trim().max(2000).nullable().optional(),
    tailoring: z.string().trim().max(2000).nullable().optional(),
    projectSelection: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

const WORKPLACE_TYPE_VALUES = ["remote", "hybrid", "onsite"] as const;
const parseWorkplaceTypesOrNull = createEnumArrayParser(WORKPLACE_TYPE_VALUES);
const parseLocationSearchScopeOrNull = createEnumParser(
  LOCATION_SEARCH_SCOPE_VALUES,
);
const parseLocationMatchStrictnessOrNull = createEnumParser(
  LOCATION_MATCH_STRICTNESS_VALUES,
);
const parseScheduleWeekdaysOrNull = createEnumArrayParser(
  SCHEDULE_WEEKDAY_VALUES,
);
const parseDigestModeOrNull = createEnumParser(DIGEST_MODE_VALUES);

function parseBoundedIntOrNull(
  raw: string | undefined,
  min: number,
  max: number,
): number | null {
  const parsed = raw ? parseInt(raw, 10) : NaN;
  if (Number.isNaN(parsed)) return null;
  return Math.min(max, Math.max(min, parsed));
}

function parseJsonObjectOrNull<T>(raw: string | undefined): T | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as T)
      : null;
  } catch {
    return null;
  }
}

function parseLlmPurposeOverrides(
  raw: string | undefined,
): LlmPurposeOverrides | null {
  const parsed = parseJsonObjectOrNull<unknown>(raw);
  if (!parsed) return null;

  const result = llmPurposeOverridesSchema.safeParse(parsed);
  return result.success ? normalizeLlmPurposeOverrides(result.data) : null;
}

function parseLlmPurposeApiKeys(
  raw: string | undefined,
): LlmPurposeApiKeys | null {
  const parsed = parseJsonObjectOrNull<unknown>(raw);
  if (!parsed) return null;

  const result = llmPurposeApiKeysSchema.safeParse(parsed);
  return result.success ? normalizeLlmPurposeApiKeys(result.data) : null;
}

function normalizeLlmPurposeApiKeys(
  value: LlmPurposeApiKeys | null | undefined,
): LlmPurposeApiKeys | null {
  if (!value) return null;

  const out: LlmPurposeApiKeys = {};
  for (const purpose of LLM_PURPOSE_VALUES) {
    const apiKey = value[purpose]?.trim();
    if (apiKey) {
      out[purpose] = apiKey;
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}

function normalizeLlmPurposeOverrides(
  value: LlmPurposeOverrides | null | undefined,
): LlmPurposeOverrides | null {
  if (!value) return null;

  const out: LlmPurposeOverrides = {};
  for (const purpose of LLM_PURPOSE_VALUES) {
    const override = value[purpose];
    if (!override) continue;

    const provider = normalizeLlmProviderOrNull(
      override.provider ?? undefined,
    ) as LlmProviderId | null;
    const baseUrl = override.baseUrl?.trim() || null;
    const model = override.model?.trim() || null;
    const normalized = {
      ...(provider ? { provider } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(model ? { model } : {}),
    };

    if (Object.keys(normalized).length > 0) {
      out[purpose] = normalized;
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}

export const resumeProjectsSchema = z.object({
  maxProjects: z.number().int().min(0).max(100),
  lockedProjectIds: z.array(z.string().trim().min(1)).max(200),
  aiSelectableProjectIds: z.array(z.string().trim().min(1)).max(200),
});

export const settingsRegistry = {
  // --- Typed Settings ---
  model: {
    kind: "typed" as const,
    schema: z.string().trim().max(200),
    default: (): string =>
      typeof process !== "undefined"
        ? getDefaultModelForProvider(
            process.env.LLM_PROVIDER,
            process.env.MODEL,
          )
        : DEFAULT_GEMINI_MODEL,
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  llmProvider: {
    kind: "typed" as const,
    envKey: "LLM_PROVIDER",
    schema: z.preprocess(
      (v) => (typeof v === "string" ? normalizeLlmProviderOrNull(v) : v),
      z.enum(LLM_PROVIDER_VALUES).nullable(),
    ),
    default: (): string =>
      typeof process !== "undefined"
        ? normalizeLlmProviderOrNull(process.env.LLM_PROVIDER) || "openrouter"
        : "openrouter",
    parse: normalizeLlmProviderOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  llmBaseUrl: {
    kind: "typed" as const,
    envKey: "LLM_BASE_URL",
    schema: z.preprocess(
      (v) => (v === "" ? null : v),
      z.string().trim().url().max(2000).nullable(),
    ),
    default: (): string =>
      typeof process !== "undefined" ? process.env.LLM_BASE_URL || "" : "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  llmPurposeOverrides: {
    kind: "typed" as const,
    schema: llmPurposeOverridesSchema,
    default: (): LlmPurposeOverrides => ({}),
    parse: (raw: string | undefined): LlmPurposeOverrides | null =>
      parseLlmPurposeOverrides(raw),
    serialize: (
      value: LlmPurposeOverrides | null | undefined,
    ): string | null => {
      const normalized = normalizeLlmPurposeOverrides(value);
      return normalized ? JSON.stringify(normalized) : null;
    },
  },
  pipelineWebhookUrl: {
    kind: "typed" as const,
    schema: z.string().trim().max(2000),
    default: (): string =>
      typeof process !== "undefined"
        ? process.env.PIPELINE_WEBHOOK_URL || process.env.WEBHOOK_URL || ""
        : "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  jobCompleteWebhookUrl: {
    kind: "typed" as const,
    schema: z.string().trim().max(2000),
    default: (): string =>
      typeof process !== "undefined"
        ? process.env.JOB_COMPLETE_WEBHOOK_URL || ""
        : "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  resumeProjects: {
    kind: "typed" as const,
    schema: resumeProjectsSchema,
    default: (): ResumeProjectsSettings => ({
      maxProjects: 20,
      lockedProjectIds: [],
      aiSelectableProjectIds: [],
    }),
    parse: (raw: string | undefined): ResumeProjectsSettings | null => {
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    serialize: (
      value: ResumeProjectsSettings | null | undefined,
    ): string | null => {
      return value ? JSON.stringify(value) : null;
    },
  },
  pdfRenderer: {
    kind: "typed" as const,
    schema: z.enum(PDF_RENDERER_VALUES),
    default: (): PdfRenderer => "rxresume",
    parse: parsePdfRendererOrNull,
    serialize: (value: PdfRenderer | null | undefined): string | null =>
      value ?? null,
  },
  typstTheme: {
    kind: "typed" as const,
    schema: z.enum(TYPST_THEME_VALUES),
    default: (): TypstTheme => "classic",
    parse: parseTypstThemeOrNull,
    serialize: (value: TypstTheme | null | undefined): string | null =>
      value ?? null,
  },
  pdfPaperSize: {
    kind: "typed" as const,
    schema: z.enum(PDF_PAPER_SIZE_VALUES),
    default: (): PdfPaperSize => "auto",
    parse: parsePdfPaperSizeOrNull,
    serialize: (value: PdfPaperSize | null | undefined): string | null =>
      value ?? null,
  },
  ukvisajobsMaxJobs: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(1000),
    default: (): number => 50,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  adzunaMaxJobsPerTerm: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(1000),
    default: (): number =>
      parseInt(
        typeof process !== "undefined"
          ? process.env.ADZUNA_MAX_JOBS_PER_TERM || "50"
          : "50",
        10,
      ),
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  gradcrackerMaxJobsPerTerm: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(1000),
    default: (): number => 50,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  startupjobsMaxJobsPerTerm: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(1000),
    default: (): number =>
      parseInt(
        typeof process !== "undefined"
          ? process.env.STARTUPJOBS_MAX_RESULTS || "50"
          : "50",
        10,
      ),
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  seekMaxJobsPerTerm: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(1000),
    default: (): number =>
      parseInt(
        typeof process !== "undefined"
          ? process.env.SEEK_MAX_JOBS_PER_TERM || "50"
          : "50",
        10,
      ),
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  naukriMaxJobsPerTerm: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(1000),
    default: (): number =>
      parseInt(
        typeof process !== "undefined"
          ? process.env.NAUKRI_MAX_JOBS_PER_TERM || "50"
          : "50",
        10,
      ),
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  jobindexMaxJobsPerTerm: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(1000),
    default: (): number =>
      parseInt(
        typeof process !== "undefined"
          ? process.env.JOBINDEX_MAX_JOBS_PER_TERM || "50"
          : "50",
        10,
      ),
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  searchTerms: {
    kind: "typed" as const,
    schema: z.array(z.string().trim().min(1).max(200)).max(100),
    default: (): string[] =>
      (typeof process !== "undefined"
        ? process.env.JOBSPY_SEARCH_TERMS || "web developer"
        : "web developer"
      )
        .split("|")
        .map((v) => v.trim())
        .filter(Boolean),
    parse: parseJsonArrayOrNull,
    serialize: serializeNullableJsonArray,
  },
  workplaceTypes: {
    kind: "typed" as const,
    schema: z.array(z.enum(WORKPLACE_TYPE_VALUES)).min(1).max(3),
    default: (): Array<(typeof WORKPLACE_TYPE_VALUES)[number]> => [
      "remote",
      "hybrid",
      "onsite",
    ],
    parse: parseWorkplaceTypesOrNull,
    serialize: serializeNullableJsonArray,
  },
  onboardingProfileCompleted: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => false,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  onboardingLlmCompleted: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => false,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  onboardingResumeConfirmedSource: {
    kind: "typed" as const,
    schema: z.string().trim().max(300),
    default: (): string => "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  onboardingLegacyMigrationPending: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => false,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  blockedCompanyKeywords: {
    kind: "typed" as const,
    schema: z.array(z.string().trim().min(1).max(200)).max(200),
    default: (): string[] => [],
    parse: parseJsonArrayOrNull,
    serialize: serializeNullableJsonArray,
  },
  scoringInstructions: {
    kind: "typed" as const,
    schema: z.string().trim().max(4000),
    default: (): string => "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  // One company per line; aliases on a line are separated by "|". Blank
  // lines are accepted (the Settings textarea sends them while typing) and
  // dropped when saved.
  targetCompanies: {
    kind: "typed" as const,
    schema: z.array(z.string().trim().max(500)).max(200),
    default: (): string[] => [],
    parse: (raw: string | undefined): string[] | null => {
      const parsed = parseJsonArrayOrNull(raw);
      return parsed ? normalizeTargetCompanyLines(parsed) : null;
    },
    serialize: (value: string[] | null | undefined): string | null => {
      const normalized = normalizeTargetCompanyLines(value);
      return normalized.length > 0 ? JSON.stringify(normalized) : null;
    },
  },
  dealbreakers: {
    kind: "typed" as const,
    schema: z.string().trim().max(4000),
    default: (): string => "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value?.trim() ? value.trim() : null,
  },
  ghostwriterSystemPromptTemplate: {
    kind: "typed" as const,
    schema: z.string().trim().max(12000),
    default: (): string =>
      getDefaultPromptTemplate("ghostwriterSystemPromptTemplate"),
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  ghostwriterStopSlopEnabled: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => false,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  tailoringPromptTemplate: {
    kind: "typed" as const,
    schema: z.string().trim().max(12000),
    default: (): string => getDefaultPromptTemplate("tailoringPromptTemplate"),
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  roleCvPromptTemplate: {
    kind: "typed" as const,
    schema: z.string().trim().max(12000),
    default: (): string => getDefaultPromptTemplate("roleCvPromptTemplate"),
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  roleCvPipelineMode: {
    kind: "typed" as const,
    schema: z.enum(ROLE_CV_PIPELINE_MODE_VALUES),
    // Refine only takes effect once at least one Role CV exists.
    default: (): RoleCvPipelineMode => "refine",
    parse: createEnumParser(ROLE_CV_PIPELINE_MODE_VALUES),
    serialize: (value: RoleCvPipelineMode | null | undefined): string | null =>
      value ?? null,
  },
  scoringPromptTemplate: {
    kind: "typed" as const,
    schema: z.string().trim().max(12000),
    default: (): string => getDefaultPromptTemplate("scoringPromptTemplate"),
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  searchCities: {
    kind: "typed" as const,
    schema: z.string().trim().max(3000),
    default: (): string =>
      typeof process !== "undefined"
        ? process.env.SEARCH_CITIES || process.env.JOBSPY_LOCATION || ""
        : "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  locationSearchMode: {
    kind: "typed" as const,
    schema: z.enum(LOCATION_INPUT_MODE_VALUES),
    default: () => "radius" as const,
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  locationLatitude: {
    kind: "typed" as const,
    schema: z.number().min(-90).max(90).nullable(),
    default: (): number | null => null,
    parse: parseNumberOrNull,
    serialize: serializeNullableNumber,
  },
  locationLongitude: {
    kind: "typed" as const,
    schema: z.number().min(-180).max(180).nullable(),
    default: (): number | null => null,
    parse: parseNumberOrNull,
    serialize: serializeNullableNumber,
  },
  locationRadiusMiles: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(200),
    default: (): number => 50,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  locationSearchScope: {
    kind: "typed" as const,
    schema: z.enum(LOCATION_SEARCH_SCOPE_VALUES),
    default: () => "selected_only" as const,
    parse: parseLocationSearchScopeOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  locationMatchStrictness: {
    kind: "typed" as const,
    schema: z.enum(LOCATION_MATCH_STRICTNESS_VALUES),
    default: () => "exact_only" as const,
    parse: parseLocationMatchStrictnessOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  jobspyResultsWanted: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(1000),
    default: (): number =>
      parseInt(
        typeof process !== "undefined"
          ? process.env.JOBSPY_RESULTS_WANTED || "200"
          : "200",
        10,
      ),
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  jobspyCountryIndeed: {
    kind: "typed" as const,
    schema: z.string().trim().max(100),
    default: (): string =>
      typeof process !== "undefined"
        ? process.env.JOBSPY_COUNTRY_INDEED || ""
        : "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  showSponsorInfo: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => true,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  renderMarkdownInJobDescriptions: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => true,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  autoTailorOnManualImport: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => true,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  chatStyleTone: {
    kind: "typed" as const,
    schema: z.string().trim().max(100),
    default: (): string =>
      typeof process !== "undefined"
        ? process.env.CHAT_STYLE_TONE || "professional"
        : "professional",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  chatStyleFormality: {
    kind: "typed" as const,
    schema: z.string().trim().max(100),
    default: (): string =>
      typeof process !== "undefined"
        ? process.env.CHAT_STYLE_FORMALITY || "medium"
        : "medium",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  chatStyleConstraints: {
    kind: "typed" as const,
    schema: z.string().trim().max(4000),
    default: (): string =>
      typeof process !== "undefined"
        ? process.env.CHAT_STYLE_CONSTRAINTS || ""
        : "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  chatStyleDoNotUse: {
    kind: "typed" as const,
    schema: z.string().trim().max(1000),
    default: (): string =>
      typeof process !== "undefined"
        ? process.env.CHAT_STYLE_DO_NOT_USE || ""
        : "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value ?? null,
  },
  chatStyleSummaryMaxWords: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(500).nullable(),
    default: (): number | null => null,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  chatStyleMaxKeywordsPerSkill: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(50).nullable(),
    default: (): number | null => null,
    parse: parseIntOrNull,
    serialize: serializeNullableNumber,
  },
  chatStyleLanguageMode: {
    kind: "typed" as const,
    schema: z.enum(CHAT_STYLE_LANGUAGE_MODE_VALUES),
    default: (): ChatStyleLanguageMode =>
      parseChatStyleLanguageModeOrNull(
        typeof process !== "undefined"
          ? process.env.CHAT_STYLE_LANGUAGE_MODE
          : undefined,
      ) ?? "manual",
    parse: parseChatStyleLanguageModeOrNull,
    serialize: (
      value: ChatStyleLanguageMode | null | undefined,
    ): string | null => value ?? null,
  },
  chatStyleManualLanguage: {
    kind: "typed" as const,
    schema: z.enum(CHAT_STYLE_MANUAL_LANGUAGE_VALUES),
    default: (): ChatStyleManualLanguage =>
      parseChatStyleManualLanguageOrNull(
        typeof process !== "undefined"
          ? process.env.CHAT_STYLE_MANUAL_LANGUAGE
          : undefined,
      ) ?? "english",
    parse: parseChatStyleManualLanguageOrNull,
    serialize: (
      value: ChatStyleManualLanguage | null | undefined,
    ): string | null => value ?? null,
  },
  backupEnabled: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => false,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  backupHour: {
    kind: "typed" as const,
    schema: z.number().int().min(0).max(23),
    default: (): number => 2,
    parse: (raw: string | undefined): number | null => {
      const parsed = raw ? parseInt(raw, 10) : NaN;
      if (Number.isNaN(parsed)) return null;
      return Math.min(23, Math.max(0, parsed));
    },
    serialize: serializeNullableNumber,
  },
  backupMaxCount: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(5),
    default: (): number => 5,
    parse: (raw: string | undefined): number | null => {
      const parsed = raw ? parseInt(raw, 10) : NaN;
      if (Number.isNaN(parsed)) return null;
      return Math.min(5, Math.max(1, parsed));
    },
    serialize: serializeNullableNumber,
  },
  // --- Scheduled runs and the run digest ---
  // Admin-only, unavailable in hosted and demo mode. The time is "HH:MM" in
  // the IANA time zone; the scheduler re-checks the zone, since a stored
  // value can stop being valid after a runtime upgrade.
  scheduleEnabled: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => false,
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  scheduleTime: {
    kind: "typed" as const,
    schema: z.string().trim().refine(isValidScheduleTime, {
      message: "Use a 24-hour time such as 08:00",
    }),
    default: (): string => DEFAULT_SCHEDULE_TIME,
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value?.trim() || null,
  },
  scheduleTimeZone: {
    kind: "typed" as const,
    schema: z.string().trim().max(100).refine(isValidTimeZone, {
      message: "Use a time zone name such as Asia/Jakarta",
    }),
    default: (): string => DEFAULT_SCHEDULE_TIME_ZONE,
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value?.trim() || null,
  },
  scheduleWeekdays: {
    kind: "typed" as const,
    schema: z.array(z.enum(SCHEDULE_WEEKDAY_VALUES)).min(1).max(7),
    default: (): ScheduleWeekday[] => [...SCHEDULE_WEEKDAY_VALUES],
    parse: parseScheduleWeekdaysOrNull,
    serialize: (value: ScheduleWeekday[] | null | undefined): string | null =>
      value && value.length > 0
        ? JSON.stringify(
            SCHEDULE_WEEKDAY_VALUES.filter((day) => value.includes(day)),
          )
        : null,
  },
  // How late a missed run may still start, e.g. after a restart.
  scheduleCatchUpMinutes: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(MAX_SCHEDULE_CATCH_UP_MINUTES),
    default: (): number => DEFAULT_SCHEDULE_CATCH_UP_MINUTES,
    parse: (raw: string | undefined): number | null =>
      parseBoundedIntOrNull(raw, 1, MAX_SCHEDULE_CATCH_UP_MINUTES),
    serialize: serializeNullableNumber,
  },
  // Saved search to run; empty means the most recently used saved search.
  scheduleSearchPresetId: {
    kind: "typed" as const,
    schema: z.string().trim().max(200),
    default: (): string => "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value?.trim() || null,
  },
  digestMode: {
    kind: "typed" as const,
    schema: z.enum(DIGEST_MODE_VALUES),
    default: (): DigestMode => "scheduled",
    parse: parseDigestModeOrNull,
    serialize: (value: DigestMode | null | undefined): string | null =>
      value ?? null,
  },
  digestMaxJobs: {
    kind: "typed" as const,
    schema: z.number().int().min(1).max(MAX_DIGEST_MAX_JOBS),
    default: (): number => DEFAULT_DIGEST_MAX_JOBS,
    parse: (raw: string | undefined): number | null =>
      parseBoundedIntOrNull(raw, 1, MAX_DIGEST_MAX_JOBS),
    serialize: serializeNullableNumber,
  },
  // Where the digest goes. Not a secret, but it says where data is sent.
  telegramChatId: {
    kind: "typed" as const,
    schema: z
      .string()
      .trim()
      .refine((value) => value === "" || TELEGRAM_CHAT_ID_PATTERN.test(value), {
        message: "Use a numeric chat id such as 123456789, or @channelname",
      }),
    default: (): string => "",
    parse: parseNonEmptyStringOrNull,
    serialize: (value: string | null | undefined): string | null =>
      value?.trim() || null,
  },
  penalizeMissingSalary: {
    kind: "typed" as const,
    schema: z.boolean(),
    default: (): boolean => {
      if (typeof process === "undefined") return false;
      const v = process.env.PENALIZE_MISSING_SALARY || "0";
      return v === "1" || v.toLowerCase() === "true";
    },
    parse: parseBitBoolOrNull,
    serialize: serializeBitBool,
  },
  missingSalaryPenalty: {
    kind: "typed" as const,
    schema: z.number().int().min(0).max(100),
    default: (): number => {
      if (typeof process === "undefined") return 10;
      const raw = process.env.MISSING_SALARY_PENALTY;
      if (!raw) return 10;
      const parsed = parseInt(raw, 10);
      return Number.isNaN(parsed) ? 10 : Math.min(100, Math.max(0, parsed));
    },
    parse: (raw: string | undefined): number | null => {
      const parsed = raw ? parseInt(raw, 10) : NaN;
      return Number.isNaN(parsed) ? null : Math.min(100, Math.max(0, parsed));
    },
    serialize: serializeNullableNumber,
  },
  autoSkipScoreThreshold: {
    kind: "typed" as const,
    schema: z.number().int().min(0).max(100),
    default: (): number | null => null,
    parse: (raw: string | undefined): number | null => {
      if (!raw || raw === "null" || raw === "") return null;
      const parsed = parseInt(raw, 10);
      return Number.isNaN(parsed) ? null : Math.min(100, Math.max(0, parsed));
    },
    serialize: (value: number | null | undefined): string | null => {
      return value === null || value === undefined ? null : String(value);
    },
  },

  // --- Model Variants ---
  modelScorer: {
    kind: "model" as const,
    schema: z.string().trim().max(200),
  },
  modelTailoring: {
    kind: "model" as const,
    schema: z.string().trim().max(200),
  },
  modelProjectSelection: {
    kind: "model" as const,
    schema: z.string().trim().max(200),
  },

  // --- Simple Strings ---
  rxresumeBaseResumeId: {
    kind: "string" as const,
    schema: z.string().trim().max(200),
  },
  rxresumeUrl: {
    kind: "string" as const,
    envKey: "RXRESUME_URL",
    schema: z.preprocess(
      (value) => (value === "" ? null : value),
      z.string().trim().url().max(2000).nullable(),
    ),
  },
  ukvisajobsEmail: {
    kind: "string" as const,
    envKey: "UKVISAJOBS_EMAIL",
    schema: z.string().trim().max(200),
  },
  adzunaAppId: {
    kind: "string" as const,
    envKey: "ADZUNA_APP_ID",
    schema: z.string().trim().max(200),
  },

  // --- Secrets ---
  llmApiKey: {
    kind: "secret" as const,
    envKey: "LLM_API_KEY",
    schema: z.string().trim().max(2000),
  },
  llmPurposeApiKeys: {
    kind: "secret" as const,
    schema: llmPurposeApiKeysSchema,
    parse: (raw: string | undefined): LlmPurposeApiKeys | null =>
      parseLlmPurposeApiKeys(raw),
    serialize: (value: LlmPurposeApiKeys | null | undefined): string | null => {
      const normalized = normalizeLlmPurposeApiKeys(value);
      return normalized ? JSON.stringify(normalized) : null;
    },
  },
  rxresumeApiKey: {
    kind: "secret" as const,
    envKey: "RXRESUME_API_KEY",
    schema: z.string().trim().max(2000),
  },
  ukvisajobsPassword: {
    kind: "secret" as const,
    envKey: "UKVISAJOBS_PASSWORD",
    schema: z.string().trim().max(2000),
  },
  adzunaAppKey: {
    kind: "secret" as const,
    envKey: "ADZUNA_APP_KEY",
    schema: z.string().trim().max(2000),
  },
  apifyToken: {
    kind: "secret" as const,
    envKey: "APIFY_TOKEN",
    schema: z.string().trim().max(2000),
  },
  webhookSecret: {
    kind: "secret" as const,
    envKey: "WEBHOOK_SECRET",
    schema: z.string().trim().max(2000),
  },

  telegramBotToken: {
    kind: "secret" as const,
    envKey: "TELEGRAM_BOT_TOKEN",
    schema: z
      .string()
      .trim()
      .max(200)
      .refine(
        (value) => value === "" || TELEGRAM_BOT_TOKEN_PATTERN.test(value),
        { message: "A bot token looks like 123456789:AAH... (from BotFather)" },
      ),
  },

  // --- Aliases ---
  jobspyLocation: {
    kind: "alias" as const,
    schema: z.string().trim().max(100),
    target: "searchCities" as const,
  },
} as const;

export type SettingsRegistry = typeof settingsRegistry;
export type SettingsRegistryKey = keyof SettingsRegistry;
