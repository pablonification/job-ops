import { logger } from "@infra/logger";
import { redactSensitiveText } from "@infra/sanitize";
import { getActiveTenantId } from "@server/tenancy/context";
import { PRIMARY_CONFIGURATION_FAILURE_MARKER } from "../policies/configuration-error";
import type { LlmProvider } from "../types";
import {
  buildLlmBreakerKey,
  type LlmCircuitBreaker,
  llmCircuitBreaker,
} from "./breaker";
import {
  classifyLlmFailure,
  countsTowardBreaker,
  isFailoverEligible,
  type LlmFailureKind,
} from "./classification";
import type { ReadyLlmFallback } from "./eligibility";

export type FailoverAttemptResult<T> =
  | { success: true; data: T }
  | {
      success: false;
      error: string;
      /** Upstream HTTP status, when the caller knows it. */
      status?: number;
      /** Set when the caller already knows the kind (its own validation). */
      failureKind?: LlmFailureKind;
    };

/** Why the fallback served a call. */
export type LlmFailoverReason = LlmFailureKind | "forced" | "circuit_open";

/** Longest error text logged or returned by the failover layer. */
export const LLM_FAILOVER_ERROR_MAX = 400;

/**
 * The single sanitiser for failover error text, logged or returned: known
 * keys, bearer tokens, URL credentials and secret query parameters are
 * removed, then the text is truncated.
 */
export function sanitizeLlmFailureText(
  message: string,
  secrets: Array<string | null | undefined> = [],
): string {
  return redactSensitiveText(message, {
    secrets,
    max: LLM_FAILOVER_ERROR_MAX,
  });
}

export function getLlmBreakerKeyForPrimary(primary: {
  provider: string;
  baseUrl: string | null | undefined;
}): string {
  return buildLlmBreakerKey({
    tenantId: getActiveTenantId(),
    provider: primary.provider,
    baseUrl: primary.baseUrl,
  });
}

/**
 * The single failover decision. Runs the primary (unless forced or the
 * breaker is open), classifies a failure, and when it is provider-side tries
 * the fallback exactly once. Nothing here loops.
 */
export async function runWithLlmFailover<T>(args: {
  primary: {
    provider: LlmProvider;
    baseUrl: string | null;
    apiKey?: string | null;
  };
  fallback: ReadyLlmFallback;
  operation: string;
  jobId?: string;
  signal?: AbortSignal;
  breaker?: LlmCircuitBreaker;
  callPrimary: () => Promise<FailoverAttemptResult<T>>;
  callFallback: () => Promise<FailoverAttemptResult<T>>;
}): Promise<FailoverAttemptResult<T>> {
  const breaker = args.breaker ?? llmCircuitBreaker;
  const { fallback, primary } = args;
  const policy = fallback.breaker;
  const key = getLlmBreakerKeyForPrimary(primary);
  const secrets = [primary.apiKey, fallback.target.apiKey];
  const clean = (message: string) => sanitizeLlmFailureText(message, secrets);
  // requestId, pipelineRunId and jobId from the request context are added
  // by the shared logger itself.
  const context = {
    operation: args.operation,
    jobId: args.jobId ?? null,
    primaryProvider: primary.provider,
    fallbackProvider: fallback.target.provider,
    fallbackModel: fallback.target.model,
  };

  let reason: LlmFailoverReason;
  /** What the primary's failure (or the open breaker) says about it. */
  let primaryKind: LlmFailureKind | null = null;
  let primaryError: string | null = null;
  let primaryResult: FailoverAttemptResult<T> | null = null;

  if (fallback.forced) {
    reason = "forced";
  } else {
    const gate = breaker.acquire(key, policy);
    if (gate.skipPrimary) {
      reason = "circuit_open";
      primaryKind = breaker.openReason(key);
    } else {
      let verdict = false;
      try {
        primaryResult = await args.callPrimary();
        if (primaryResult.success) {
          verdict = true;
          breaker.recordSuccess(key, gate);
          return primaryResult;
        }
        const kind: LlmFailureKind = args.signal?.aborted
          ? "aborted"
          : (primaryResult.failureKind ??
            classifyLlmFailure({
              provider: primary.provider,
              message: primaryResult.error,
              status: primaryResult.status,
            }));
        if (!isFailoverEligible(kind)) {
          return { ...primaryResult, error: clean(primaryResult.error) };
        }

        reason = kind;
        primaryKind = kind;
        primaryError = clean(primaryResult.error);
        if (countsTowardBreaker(kind)) {
          verdict = true;
          if (breaker.recordFailure(key, policy, gate, kind)) {
            logger.warn("LLM primary provider skipped for a cool-down", {
              ...context,
              reason: kind,
              cooldownMs: policy.cooldownMs,
              threshold: policy.threshold,
            });
          }
        }
      } finally {
        if (gate.probe && !verdict) breaker.releaseProbe(key, gate);
      }
    }
  }

  if (args.signal?.aborted) {
    return primaryResult && !primaryResult.success
      ? { ...primaryResult, error: clean(primaryResult.error) }
      : { success: false, error: "LLM request was aborted." };
  }

  const fallbackResult = await args.callFallback();

  if (fallbackResult.success) {
    if (reason === "forced") {
      logger.debug("LLM request served by forced fallback provider", context);
    } else {
      breaker.noteFailover(key, reason, "succeeded");
      logger.warn("LLM request failed over to fallback provider", {
        ...context,
        reason,
        primaryError,
      });
    }
    return fallbackResult;
  }

  const fallbackError = clean(fallbackResult.error);
  if (args.signal?.aborted) {
    // Cancelled while the fallback was working: not a failover outcome.
    logger.debug("LLM fallback call cancelled by the caller", context);
    return { ...fallbackResult, error: fallbackError };
  }

  if (reason !== "forced") breaker.noteFailover(key, reason, "failed");
  logger.warn(
    reason === "forced"
      ? "Forced fallback LLM provider failed"
      : "LLM fallback provider failed after failover",
    { ...context, reason, primaryError, fallbackError },
  );

  const fallbackPart = `Fallback LLM (${fallback.target.provider}) failed: ${fallbackError}`;
  // A broken primary configuration must still pause the pipeline when the
  // fallback cannot cover for it, so carry that reason explicitly.
  const error =
    primaryKind === "configuration"
      ? sanitizeLlmFailureText(
          `${PRIMARY_CONFIGURATION_FAILURE_MARKER} (${primary.provider}): ${primaryError ?? "skipped after repeated configuration failures"}. ${fallbackPart}`,
          secrets,
        )
      : clean(fallbackPart);
  return {
    success: false,
    error,
    ...(fallbackResult.status !== undefined
      ? { status: fallbackResult.status }
      : {}),
  };
}
