import { logger } from "@infra/logger";
import { getOriginalEnvValue } from "@server/services/envSettings";
import { mapGlmProviderAlias } from "@shared/settings-registry";
import { toStringOrNull } from "@shared/utils/type-conversion";
import { strategies } from "./providers";
import type { LlmProvider } from "./types";

export type LlmEndpoint = { provider: LlmProvider; baseUrl: string };

/**
 * The provider and base URL a service built from these options talks to.
 * `LlmService` uses this for its own endpoint, so anything comparing
 * endpoints (fallback eligibility, breaker keys, status) agrees with it.
 */
export function resolveLlmEndpoint(options: {
  provider?: string | null;
  baseUrl?: string | null;
  allowEnvironmentCredentials?: boolean;
}): LlmEndpoint {
  const normalizedBaseUrl =
    toStringOrNull(options.baseUrl) ||
    (options.allowEnvironmentCredentials === false
      ? null
      : toStringOrNull(getOriginalEnvValue("LLM_BASE_URL"))) ||
    null;
  const provider = normalizeProvider(
    options.provider ?? getOriginalEnvValue("LLM_PROVIDER") ?? null,
    normalizedBaseUrl,
  );
  const strategy = strategies[provider];
  const baseUrl = providerUsesConfiguredBaseUrl(provider)
    ? normalizedBaseUrl || strategy.defaultBaseUrl
    : strategy.defaultBaseUrl;
  return { provider, baseUrl };
}

export function normalizeProvider(
  raw: string | null,
  baseUrl: string | null,
): LlmProvider {
  const normalized = normalizeProviderName(raw);
  if (normalized === "openai_compatible") {
    if (
      baseUrl?.includes("localhost:1234") ||
      baseUrl?.includes("127.0.0.1:1234")
    ) {
      return "lmstudio";
    }
    return "openai_compatible";
  }
  if (normalized === "openai") return "openai";
  if (normalized === "atlascloud" || normalized === "atlas_cloud") {
    return "atlascloud";
  }
  if (normalized === "litellm" || normalized === "litellm_proxy") {
    return "litellm";
  }
  if (normalized === "anthropic" || normalized === "claude") {
    return "anthropic";
  }
  if (normalized === "glm") return "glm";
  if (normalized === "gemini") return "gemini";
  if (normalized === "gemini_cli") return "gemini_cli";
  if (normalized === "claude_cli") return "claude_cli";
  if (normalized === "claude_agent_sdk") return "claude_agent_sdk";
  if (normalized === "lmstudio") return "lmstudio";
  if (normalized === "ollama") return "ollama";
  if (normalized === "codex") return "codex";
  if (normalized === "requesty") return "requesty";
  if (normalized === "api_route") return "api_route";
  if (normalized === "orcarouter") return "orcarouter";
  if (normalized && normalized !== "openrouter") {
    logger.warn("Unknown LLM provider, defaulting to openrouter", {
      normalized,
    });
  }
  return "openrouter";
}

function normalizeProviderName(raw: string | null): string | undefined {
  const normalized = raw?.trim().toLowerCase().replace(/[-.]/g, "_");
  if (!normalized) return normalized;
  return mapGlmProviderAlias(normalized);
}

function providerUsesConfiguredBaseUrl(provider: LlmProvider): boolean {
  return (
    provider === "litellm" ||
    provider === "lmstudio" ||
    provider === "ollama" ||
    provider === "openai_compatible" ||
    provider === "glm"
  );
}
