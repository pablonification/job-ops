import { getJobOpsAppConfig } from "@server/config/app-mode";
import { getOriginalEnvValue } from "@server/services/envSettings";
import { LLM_PROVIDER_VALUES } from "@shared/types";
import { strategies } from "../providers";
import type { LlmProvider } from "../types";
import { DEFAULT_LLM_BREAKER_POLICY, type LlmBreakerPolicy } from "./breaker";

export const LLM_FALLBACK_ENV_KEYS = {
  provider: "LLM_FALLBACK_PROVIDER",
  model: "LLM_FALLBACK_MODEL",
  baseUrl: "LLM_FALLBACK_BASE_URL",
  apiKey: "LLM_FALLBACK_API_KEY",
  force: "LLM_FORCE_FALLBACK",
  breakerThreshold: "LLM_FALLBACK_BREAKER_THRESHOLD",
  breakerCooldownMs: "LLM_FALLBACK_BREAKER_COOLDOWN_MS",
} as const;

/** A complete, separate configuration for the fallback call. */
export type LlmFallbackTarget = {
  provider: LlmProvider;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
};

export type LlmFallbackConfig =
  | {
      state: "ready";
      target: LlmFallbackTarget;
      forced: boolean;
      breaker: LlmBreakerPolicy;
    }
  /** Nothing set: behave exactly as if the feature did not exist. */
  | { state: "absent"; forced: boolean }
  /** Something set, but unusable. `reason` is safe to show the owner. */
  | {
      state: "invalid";
      forced: boolean;
      reason: string;
      provider: string | null;
      model: string | null;
    };

type EnvReader = (key: string) => string | undefined;

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function readTrimmed(read: EnvReader, key: string): string | null {
  const value = read(key)?.trim();
  return value ? value : null;
}

function readPositiveInt(
  read: EnvReader,
  key: string,
  fallback: number,
): number {
  const raw = readTrimmed(read, key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Strict provider id parsing: only exact provider ids are accepted (case and
 * `-` versus `_` do not matter). No aliases, so `claude` is not quietly read
 * as the Anthropic API provider.
 */
export function parseFallbackProvider(raw: string): LlmProvider | null {
  const normalized = raw.trim().toLowerCase().replace(/-/g, "_");
  return (LLM_PROVIDER_VALUES as readonly string[]).includes(normalized)
    ? (normalized as LlmProvider)
    : null;
}

function isHostedMode(): boolean | null {
  try {
    return getJobOpsAppConfig().appMode === "hosted";
  } catch {
    return null;
  }
}

/**
 * Read the fallback configuration from the environment. Never throws: a
 * misconfiguration is reported as `invalid` with a reason, so a bad value
 * cannot crash boot or a request.
 */
export function resolveLlmFallbackConfig(
  read: EnvReader = getOriginalEnvValue,
  readHostedMode: () => boolean | null = isHostedMode,
): LlmFallbackConfig {
  const forced = TRUE_VALUES.has(
    (readTrimmed(read, LLM_FALLBACK_ENV_KEYS.force) ?? "").toLowerCase(),
  );
  const rawProvider = readTrimmed(read, LLM_FALLBACK_ENV_KEYS.provider);
  const model = readTrimmed(read, LLM_FALLBACK_ENV_KEYS.model);
  const baseUrl = readTrimmed(read, LLM_FALLBACK_ENV_KEYS.baseUrl);
  const apiKey = readTrimmed(read, LLM_FALLBACK_ENV_KEYS.apiKey);

  const nothingSet = !rawProvider && !model && !baseUrl && !apiKey;
  if (nothingSet && !forced) return { state: "absent", forced };

  // Hosted tenants never use (or see) the operator's fallback. An app mode
  // that cannot be read disables it too.
  if (readHostedMode() !== false) return { state: "absent", forced: false };

  if (nothingSet) {
    return {
      state: "invalid",
      forced,
      reason: `${LLM_FALLBACK_ENV_KEYS.force} is set but no fallback is configured, so every call uses the primary provider.`,
      provider: null,
      model: null,
    };
  }

  const invalid = (reason: string) =>
    ({
      state: "invalid",
      forced,
      reason,
      provider: rawProvider,
      model,
    }) as const;

  if (!rawProvider) {
    return invalid(`${LLM_FALLBACK_ENV_KEYS.provider} is not set.`);
  }
  const provider = parseFallbackProvider(rawProvider);
  if (!provider) {
    return invalid(
      `${LLM_FALLBACK_ENV_KEYS.provider} "${rawProvider}" is not a known provider. Use one of: ${LLM_PROVIDER_VALUES.join(", ")}.`,
    );
  }
  if (!model) {
    return invalid(`${LLM_FALLBACK_ENV_KEYS.model} is not set.`);
  }
  if (provider === "openai_compatible" && !baseUrl) {
    // Without it the call (and the fallback key) would go to api.openai.com.
    return invalid(
      `${LLM_FALLBACK_ENV_KEYS.baseUrl} is required for an OpenAI-compatible fallback.`,
    );
  }
  if (strategies[provider].requiresApiKey && !apiKey) {
    return invalid(
      `${LLM_FALLBACK_ENV_KEYS.apiKey} is required for the ${provider} fallback.`,
    );
  }

  return {
    state: "ready",
    target: { provider, model, baseUrl, apiKey },
    forced,
    breaker: {
      threshold: readPositiveInt(
        read,
        LLM_FALLBACK_ENV_KEYS.breakerThreshold,
        DEFAULT_LLM_BREAKER_POLICY.threshold,
      ),
      cooldownMs: readPositiveInt(
        read,
        LLM_FALLBACK_ENV_KEYS.breakerCooldownMs,
        DEFAULT_LLM_BREAKER_POLICY.cooldownMs,
      ),
    },
  };
}
