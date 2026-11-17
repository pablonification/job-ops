import type { LlmFallbackStatus } from "@shared/types";
import { resolveLlmEndpoint } from "../provider-endpoint";
import { type LlmCircuitBreaker, llmCircuitBreaker } from "./breaker";
import { type LlmFallbackConfig, resolveLlmFallbackConfig } from "./config";
import { resolveLlmFallbackEligibility } from "./eligibility";
import { getLlmBreakerKeyForPrimary } from "./runner";

/** One primary configuration in use: the default, or a purpose override. */
export type LlmStatusPrimary = {
  purpose: string;
  provider: string | null;
  baseUrl: string | null;
};

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

const EMPTY: LlmFallbackStatus = {
  configured: false,
  active: false,
  provider: null,
  model: null,
  forced: false,
  tripped: false,
  trippedUntil: null,
  trippedPurposes: [],
  inactiveReason: null,
  lastFailover: null,
};

/**
 * Fallback status for the Settings API. `primaries` lists the default
 * provider first, then any purpose that overrides it; breaker state is the
 * current tenant's. Purposes sharing an endpoint share one breaker entry.
 */
export function describeLlmFallbackStatus(args: {
  primaries: LlmStatusPrimary[];
  config?: LlmFallbackConfig;
  breaker?: LlmCircuitBreaker;
}): LlmFallbackStatus {
  const config = args.config ?? resolveLlmFallbackConfig();
  if (config.state === "absent") return EMPTY;
  if (config.state === "invalid") {
    return {
      ...EMPTY,
      provider: config.provider,
      model: config.model,
      inactiveReason: config.reason,
    };
  }

  const breaker = args.breaker ?? llmCircuitBreaker;
  const configured: LlmFallbackStatus = {
    ...EMPTY,
    configured: true,
    provider: config.target.provider,
    model: config.target.model,
    forced: config.forced,
  };

  // Group purposes by the endpoint (breaker key) they actually use.
  const groups = new Map<
    string,
    { purposes: string[]; active: boolean; inactiveReason: string | null }
  >();
  for (const primary of args.primaries) {
    // Base URLs here are already resolved from settings; do not let the
    // environment's LLM_BASE_URL fill a gap the runtime would not fill.
    const endpoint = resolveLlmEndpoint({
      provider: primary.provider,
      baseUrl: primary.baseUrl,
      allowEnvironmentCredentials: false,
    });
    const eligibility = resolveLlmFallbackEligibility(endpoint, config);
    const key = getLlmBreakerKeyForPrimary(endpoint);
    const group = groups.get(key) ?? {
      purposes: [],
      active: eligibility.state === "active",
      inactiveReason:
        eligibility.state === "inactive" ? eligibility.reason : null,
    };
    group.purposes.push(primary.purpose);
    groups.set(key, group);
  }

  const activeGroups = [...groups.entries()].filter(([, g]) => g.active);
  if (activeGroups.length === 0) {
    const reason = [...groups.values()][0]?.inactiveReason ?? null;
    return { ...configured, forced: false, inactiveReason: reason };
  }

  let trippedUntil: number | null = null;
  const trippedPurposes: string[] = [];
  let lastFailover: LlmFallbackStatus["lastFailover"] = null;
  let lastFailoverAt = -1;
  for (const [key, group] of activeGroups) {
    const snapshot = breaker.snapshot(key);
    if (snapshot.tripped) {
      trippedPurposes.push(...group.purposes);
      if (snapshot.openUntil !== null) {
        trippedUntil = Math.max(trippedUntil ?? 0, snapshot.openUntil);
      }
    }
    if (snapshot.lastFailover && snapshot.lastFailover.at > lastFailoverAt) {
      lastFailoverAt = snapshot.lastFailover.at;
      lastFailover = {
        at: toIso(snapshot.lastFailover.at),
        reason: snapshot.lastFailover.reason,
        outcome: snapshot.lastFailover.outcome,
        purposes: group.purposes,
      };
    }
  }

  return {
    ...configured,
    active: true,
    tripped: trippedPurposes.length > 0,
    trippedUntil:
      trippedPurposes.length > 0 && trippedUntil !== null
        ? toIso(trippedUntil)
        : null,
    trippedPurposes,
    lastFailover,
  };
}
