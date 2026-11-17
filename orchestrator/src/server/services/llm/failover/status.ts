import type { LlmFallbackStatus } from "@shared/types";
import { createFallbackLlmService, LlmService } from "../service";
import { type LlmCircuitBreaker, llmCircuitBreaker } from "./breaker";
import { type LlmFallbackConfig, resolveLlmFallbackConfig } from "./config";
import { isSameLlmEndpoint } from "./endpoint";
import { getLlmBreakerKeyForPrimary } from "./runner";

function toIso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * Fallback status for the Settings API, relative to the given primary (the
 * tenant's default provider). Breaker state is the current tenant's.
 */
export function describeLlmFallbackStatus(args: {
  primaryProvider: string | null;
  primaryBaseUrl: string | null;
  config?: LlmFallbackConfig;
  breaker?: LlmCircuitBreaker;
}): LlmFallbackStatus {
  const config = args.config ?? resolveLlmFallbackConfig();
  const base: LlmFallbackStatus = {
    configured: false,
    active: false,
    provider: null,
    model: null,
    forced: false,
    tripped: false,
    trippedUntil: null,
    inactiveReason: null,
    lastFailover: null,
  };

  if (config.state === "absent") return base;
  if (config.state === "invalid") {
    return {
      ...base,
      provider: config.provider,
      model: config.model,
      inactiveReason: config.reason,
    };
  }

  const primary = new LlmService({
    provider: args.primaryProvider,
    baseUrl: args.primaryBaseUrl,
    allowEnvironmentCredentials: false,
    failover: false,
  });
  const fallback = createFallbackLlmService(config.target);
  const configured: LlmFallbackStatus = {
    ...base,
    configured: true,
    provider: fallback.getProvider(),
    model: config.target.model,
    forced: config.forced,
  };

  if (
    isSameLlmEndpoint(
      { provider: primary.getProvider(), baseUrl: primary.getBaseUrl() },
      { provider: fallback.getProvider(), baseUrl: fallback.getBaseUrl() },
    )
  ) {
    return {
      ...configured,
      forced: false,
      inactiveReason:
        "The fallback is the same provider and endpoint as the primary, so it is ignored.",
    };
  }

  const snapshot = (args.breaker ?? llmCircuitBreaker).snapshot(
    getLlmBreakerKeyForPrimary({
      provider: primary.getProvider(),
      baseUrl: primary.getBaseUrl(),
    }),
  );
  return {
    ...configured,
    active: true,
    tripped: snapshot.tripped,
    trippedUntil: snapshot.tripped ? toIso(snapshot.openUntil) : null,
    lastFailover: snapshot.lastFailover
      ? {
          at: new Date(snapshot.lastFailover.at).toISOString(),
          reason: snapshot.lastFailover.reason,
        }
      : null,
  };
}
