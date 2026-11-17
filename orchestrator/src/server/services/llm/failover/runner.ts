import { logger } from "@infra/logger";
import { getActiveTenantId } from "@server/tenancy/context";
import type { LlmProvider } from "../types";
import { truncate } from "../utils/string";
import {
  buildLlmBreakerKey,
  type LlmCircuitBreaker,
  llmCircuitBreaker,
} from "./breaker";
import {
  classifyLlmFailure,
  isFailoverEligible,
  type LlmFailureKind,
} from "./classification";
import type { LlmFallbackConfig } from "./config";

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

type ReadyFallback = Extract<LlmFallbackConfig, { state: "ready" }>;

const REDACTED = "[REDACTED]";

/**
 * Error text can echo request headers or keys back. Strip the two keys this
 * call could have used and anything shaped like a bearer token before the
 * text reaches a log line or the returned error.
 */
function redactSecrets(
  message: string,
  secrets: Array<string | null | undefined>,
): string {
  let out = message;
  for (const secret of secrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join(REDACTED);
  }
  return out.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`);
}

function scrub(message: string, secrets: Array<string | null | undefined>) {
  return truncate(redactSecrets(message, secrets), 300);
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
 * the fallback exactly once. The fallback's own failure is returned as the
 * failure; nothing here loops.
 */
export async function runWithLlmFailover<T>(args: {
  primary: {
    provider: LlmProvider;
    baseUrl: string | null;
    apiKey?: string | null;
  };
  fallback: ReadyFallback;
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
  const context = {
    operation: args.operation,
    jobId: args.jobId ?? null,
    primaryProvider: primary.provider,
    fallbackProvider: fallback.target.provider,
    fallbackModel: fallback.target.model,
  };

  let reason: LlmFailoverReason;
  let primaryError: string | null = null;
  let primaryResult: FailoverAttemptResult<T> | null = null;

  if (fallback.forced) {
    reason = "forced";
  } else {
    const gate = breaker.acquire(key, policy);
    if (gate.skipPrimary) {
      reason = "circuit_open";
    } else {
      let verdict = false;
      try {
        primaryResult = await args.callPrimary();
        if (primaryResult.success) {
          verdict = true;
          breaker.recordSuccess(key);
          return primaryResult;
        }
        const kind = args.signal?.aborted
          ? "aborted"
          : (primaryResult.failureKind ??
            classifyLlmFailure({
              provider: primary.provider,
              message: primaryResult.error,
              status: primaryResult.status,
            }));
        if (!isFailoverEligible(kind)) return primaryResult;

        verdict = true;
        reason = kind;
        primaryError = scrub(primaryResult.error, secrets);
        if (breaker.recordFailure(key, policy, gate.probe)) {
          logger.warn("LLM primary provider skipped for a cool-down", {
            ...context,
            reason: kind,
            cooldownMs: policy.cooldownMs,
            threshold: policy.threshold,
          });
        }
      } finally {
        if (gate.probe && !verdict) breaker.releaseProbe(key);
      }
    }
  }

  if (args.signal?.aborted) {
    return (
      primaryResult ?? { success: false, error: "LLM request was aborted." }
    );
  }

  const fallbackResult = await args.callFallback();
  if (reason !== "forced") breaker.noteFailover(key, reason);

  if (fallbackResult.success) {
    if (reason === "forced") {
      logger.debug("LLM request served by forced fallback provider", context);
    } else {
      logger.warn("LLM request failed over to fallback provider", {
        ...context,
        reason,
        primaryError,
      });
    }
    return fallbackResult;
  }

  const fallbackError = scrub(fallbackResult.error, secrets);
  logger.warn(
    reason === "forced"
      ? "Forced fallback LLM provider failed"
      : "LLM fallback provider failed after failover",
    { ...context, reason, primaryError, fallbackError },
  );
  return {
    success: false,
    error: `Fallback LLM (${fallback.target.provider}) failed: ${redactSecrets(fallbackResult.error, secrets)}`,
    ...(fallbackResult.status !== undefined
      ? { status: fallbackResult.status }
      : {}),
  };
}
