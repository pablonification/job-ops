import { type LlmEndpoint, resolveLlmEndpoint } from "../provider-endpoint";
import { type LlmFallbackConfig, resolveLlmFallbackConfig } from "./config";
import { isSameLlmEndpoint } from "./endpoint";

export type ReadyLlmFallback = Extract<LlmFallbackConfig, { state: "ready" }>;

export type LlmFallbackEligibility =
  /** No fallback configured (or hosted mode): behave as if the feature did not exist. */
  | { state: "absent" }
  /** Something is configured but cannot be used for this primary. */
  | { state: "inactive"; reason: string; config: LlmFallbackConfig }
  | {
      state: "active";
      config: ReadyLlmFallback;
      primary: LlmEndpoint;
      fallback: LlmEndpoint;
    };

export const SAME_ENDPOINT_REASON =
  "The fallback is the same provider and endpoint as the primary, so it is ignored.";

/** The endpoint fallback calls go to: built from the fallback's own settings only. */
export function resolveFallbackEndpoint(config: ReadyLlmFallback): LlmEndpoint {
  return resolveLlmEndpoint({
    provider: config.target.provider,
    baseUrl: config.target.baseUrl,
    allowEnvironmentCredentials: false,
  });
}

/**
 * The one place that decides whether the configured fallback can serve a
 * given primary. Used by LlmService, resume import and the Settings status.
 */
export function resolveLlmFallbackEligibility(
  primary: LlmEndpoint,
  config: LlmFallbackConfig = resolveLlmFallbackConfig(),
): LlmFallbackEligibility {
  if (config.state === "absent") return { state: "absent" };
  if (config.state === "invalid") {
    return { state: "inactive", reason: config.reason, config };
  }
  const fallback = resolveFallbackEndpoint(config);
  if (isSameLlmEndpoint(primary, fallback)) {
    return { state: "inactive", reason: SAME_ENDPOINT_REASON, config };
  }
  return { state: "active", config, primary, fallback };
}
