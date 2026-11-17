import {
  LLM_PROVIDER_LABELS,
  type LlmProviderId,
} from "@client/pages/settings/utils";
import type { LlmFallbackStatus } from "@shared/types.js";
import type React from "react";
import { formatDateTime } from "@/lib/utils";

const REASON_LABELS: Record<string, string> = {
  configuration: "the primary was not authenticated or misconfigured",
  usage_limit: "the primary hit a usage limit",
  rate_limit: "the primary was rate limited",
  timeout: "the primary timed out",
  upstream: "the primary had a server error",
  network: "the primary could not be reached",
  subprocess: "the primary's process failed",
  unparseable: "the primary returned unusable output",
  circuit_open: "the primary was being skipped after repeated failures",
};

function providerLabel(provider: string | null): string {
  if (!provider) return "unknown provider";
  return LLM_PROVIDER_LABELS[provider as LlmProviderId] ?? provider;
}

const PURPOSE_LABELS: Record<string, string> = {
  scoring: "scoring",
  tailoring: "tailoring",
  projectSelection: "project selection",
};

/** Names the purposes, or null when only the default provider is involved. */
function describePurposes(purposes: string[]): string | null {
  const named = purposes
    .filter((purpose) => purpose !== "default")
    .map((purpose) => PURPOSE_LABELS[purpose] ?? purpose);
  if (named.length === 0 || purposes.includes("default")) return null;
  return named.join(" and ");
}

function describeTarget(status: LlmFallbackStatus): string {
  const label = providerLabel(status.provider);
  return status.model ? `${label} · ${status.model}` : label;
}

/**
 * One or two lines about the environment-configured fallback model, so the
 * owner can tell which model produced their output. Renders nothing when no
 * fallback is set up.
 */
export const LlmFallbackStatusNote: React.FC<{
  status: LlmFallbackStatus | null | undefined;
}> = ({ status }) => {
  if (!status) return null;

  let headline: string | null = null;
  let detail: string | null = null;

  if (status.inactiveReason) {
    headline = status.configured
      ? `Fallback model ${describeTarget(status)} is not active.`
      : "Fallback model is not active.";
    detail = status.inactiveReason;
  } else if (!status.active) {
    return null;
  } else if (status.forced) {
    headline = `All AI requests are using the fallback model ${describeTarget(status)}.`;
    detail =
      "LLM_FORCE_FALLBACK is on, so the provider selected above is not used.";
  } else if (status.tripped) {
    const until = formatDateTime(status.trippedUntil);
    const scope = describePurposes(status.trippedPurposes);
    const subject = scope ? `AI requests for ${scope}` : "AI requests";
    headline = `${subject} are currently using the fallback model ${describeTarget(status)}.`;
    detail = until
      ? `Their provider failed repeatedly and is skipped until ${until}, then retried.`
      : "Their provider failed repeatedly and is skipped for a cool-down, then retried.";
  } else {
    headline = `Fallback model: ${describeTarget(status)}. It answers automatically when the provider above fails for a provider-side reason.`;
    if (status.lastFailover) {
      const at = formatDateTime(status.lastFailover.at) ?? "recently";
      const why =
        REASON_LABELS[status.lastFailover.reason] ?? status.lastFailover.reason;
      const scope = describePurposes(status.lastFailover.purposes);
      const forScope = scope ? ` for ${scope}` : "";
      detail =
        status.lastFailover.outcome === "succeeded"
          ? `Last stepped in${forScope} ${at} because ${why}.`
          : `Last tried${forScope} ${at} because ${why}, but the fallback failed too.`;
    }
  }

  return (
    <div
      className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
      data-testid="llm-fallback-status"
    >
      <p className="text-foreground">{headline}</p>
      {detail ? <p className="mt-1">{detail}</p> : null}
    </div>
  );
};
