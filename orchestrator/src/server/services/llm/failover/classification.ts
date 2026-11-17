import { classifyClaudeAgentSdkError } from "../claude-agent-sdk/errors";
import { EMPTY_RESPONSE_ERROR } from "../policies/retry-policy";
import type { LlmProvider } from "../types";

/**
 * Provider-neutral reason an LLM call failed. Each provider family maps its
 * own error shapes into this one vocabulary so the failover decision never
 * has to know a specific provider's wording.
 */
export type LlmFailureKind =
  /** Missing or rejected credentials, unknown model/endpoint, provider not usable. */
  | "configuration"
  /** Plan, quota or billing exhausted. */
  | "usage_limit"
  /** Throttled (HTTP 429 or equivalent). */
  | "rate_limit"
  | "timeout"
  /** The provider answered with a server-side error (5xx, overloaded). */
  | "upstream"
  /** The provider could not be reached (DNS, refused, reset). */
  | "network"
  /** A CLI/SDK subprocess crashed or exited with an error. */
  | "subprocess"
  /** The provider answered, but not with usable JSON, after all retries. */
  | "unparseable"
  /** The caller cancelled the request. */
  | "aborted"
  /** The request itself is wrong (bad schema, input too long); another provider would be asked the same bad question. */
  | "bad_request";

const FAILOVER_KINDS: ReadonlySet<LlmFailureKind> = new Set<LlmFailureKind>([
  "configuration",
  "usage_limit",
  "rate_limit",
  "timeout",
  "upstream",
  "network",
  "subprocess",
  "unparseable",
]);

/** True when the failure is the provider's problem and a fallback may help. */
export function isFailoverEligible(kind: LlmFailureKind): boolean {
  return FAILOVER_KINDS.has(kind);
}

/**
 * Whether a failure says the primary itself is unhealthy and should count
 * toward opening the circuit breaker. Unusable output still fails over, but
 * a few bad parses in a row do not mean the provider is down.
 */
export function countsTowardBreaker(kind: LlmFailureKind): boolean {
  return isFailoverEligible(kind) && kind !== "unparseable";
}

export type LlmProviderFamily = "http" | "cli" | "claude_agent_sdk";

export function getLlmProviderFamily(provider: LlmProvider): LlmProviderFamily {
  if (provider === "claude_agent_sdk") return "claude_agent_sdk";
  if (
    provider === "codex" ||
    provider === "gemini_cli" ||
    provider === "claude_cli"
  ) {
    return "cli";
  }
  return "http";
}

const ABORT_PATTERN =
  /operation was aborted|invocation was aborted|request was aborted|request aborted|wait aborted|\bAbortError\b/i;

/** Input that is wrong whatever provider receives it. */
const BAD_REQUEST_PATTERNS: RegExp[] = [
  /prompt is too long/i,
  /context[_ ]length/i,
  /maximum context/i,
  /too many tokens/i,
  /request (entity )?too large/i,
  /image input must be/i,
];

const TIMEOUT_PATTERN = /timed out|timeout/i;

const UNPARSEABLE_PATTERNS: RegExp[] = [
  /failed to parse json/i,
  new RegExp(EMPTY_RESPONSE_ERROR, "i"),
  /did not include (a )?(`?result`?|structured output|string `response`)/i,
  /did not include structured output/i,
];

const CONFIGURATION_PATTERNS: RegExp[] = [
  /not configured/i,
  /not (authenticated|logged in)/i,
  /unavailable for this hosted account/i,
  /not found in path/i,
  /\bENOENT\b/,
];

const USAGE_LIMIT_PATTERNS: RegExp[] = [
  /usage limit/i,
  /quota/i,
  /insufficient[_ ](credits?|funds|balance)/i,
  /credit balance/i,
  /billing/i,
  /hit your [a-z ]*limit/i,
];

const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate[_ -]?limit/i,
  /\b429\b/,
  /too many requests/i,
];

/**
 * A 400 that is really a configuration problem, judged only from the start
 * of the provider's own error message (what follows `LLM API error: 400 - `)
 * so echoed request text cannot trigger it.
 */
const MODEL_OR_KEY_PROBLEM_AT_START =
  /^(?:the )?(?:model|deployment)\b[^.\n]{0,80}?\b(?:not found|does not exist|not exist|is unknown|is invalid|not supported|is unsupported|not available)|^(?:invalid|unknown|unsupported) model\b|^no such model\b|^model[_ ]not[_ ]found\b|^(?:invalid|incorrect) api[_ ]?key\b|^api[_ ]?key (?:not valid|is invalid|invalid|missing)\b|^(?:unauthori[sz]ed|authentication (?:failed|required))\b/i;

/** Request-side errors as the Claude Agent SDK reports them. */
const CLAUDE_REQUEST_SIDE_PATTERN =
  /\binvalid_request(?:_error)?\b|\bAPI error:? (?:400|413|422)\b/i;

function providerErrorDetail(message: string): string {
  const match = /LLM API error: \d{3} - ([\s\S]*)$/.exec(message);
  return (match ? match[1] : message).trim();
}

const HTTP_STATUS_IN_MESSAGE = /LLM API error: (\d{3})\b/;

/**
 * Classify why an LLM call failed.
 *
 * `status` is the upstream HTTP status when the caller has it; for the HTTP
 * family it is otherwise read from the `LLM API error: <status>` prefix the
 * LLM service writes. `aborted` is whether the caller's signal fired.
 */
export function classifyLlmFailure(args: {
  provider: LlmProvider;
  message: string;
  status?: number;
  aborted?: boolean;
}): LlmFailureKind {
  const { message } = args;
  if (args.aborted) return "aborted";
  // "The operation was aborted due to timeout" is a timeout, not a cancel.
  if (ABORT_PATTERN.test(message) && !TIMEOUT_PATTERN.test(message)) {
    return "aborted";
  }

  switch (getLlmProviderFamily(args.provider)) {
    case "claude_agent_sdk":
      return classifyClaudeAgentSdkFailure(message);
    case "cli":
      return classifyCliFailure(message);
    default:
      return classifyHttpFailure(message, args.status);
  }
}

function matchesAny(patterns: RegExp[], message: string): boolean {
  return patterns.some((pattern) => pattern.test(message));
}

function classifyClaudeAgentSdkFailure(message: string): LlmFailureKind {
  switch (classifyClaudeAgentSdkError(message)) {
    case "auth":
      return "configuration";
    case "usage_limit":
      return "usage_limit";
    case "rate_limit":
      return "rate_limit";
    case "upstream":
      return "upstream";
    case "timeout":
      return "timeout";
    case "aborted":
      return "aborted";
    default:
      // A malformed request would be just as malformed for the fallback.
      if (
        CLAUDE_REQUEST_SIDE_PATTERN.test(message) ||
        matchesAny(BAD_REQUEST_PATTERNS, message)
      ) {
        return "bad_request";
      }
      if (matchesAny(UNPARSEABLE_PATTERNS, message)) return "unparseable";
      return "subprocess";
  }
}

function classifyCliFailure(message: string): LlmFailureKind {
  if (matchesAny(BAD_REQUEST_PATTERNS, message)) return "bad_request";
  if (matchesAny(CONFIGURATION_PATTERNS, message)) return "configuration";
  if (matchesAny(USAGE_LIMIT_PATTERNS, message)) return "usage_limit";
  if (matchesAny(RATE_LIMIT_PATTERNS, message)) return "rate_limit";
  if (TIMEOUT_PATTERN.test(message)) return "timeout";
  if (matchesAny(UNPARSEABLE_PATTERNS, message)) return "unparseable";
  // Anything else is the CLI process itself failing (non-zero exit,
  // crashed app-server, broken pipe).
  return "subprocess";
}

function classifyHttpFailure(
  message: string,
  explicitStatus: number | undefined,
): LlmFailureKind {
  const statusMatch = HTTP_STATUS_IN_MESSAGE.exec(message);
  const status =
    explicitStatus ?? (statusMatch ? Number(statusMatch[1]) : undefined);

  if (status !== undefined && status >= 400) {
    return classifyHttpStatus(status, message);
  }
  if (
    message.startsWith("CAPABILITY:") ||
    /all provider modes failed/i.test(message)
  ) {
    // The endpoint cannot produce structured output at all.
    return "configuration";
  }
  if (matchesAny(BAD_REQUEST_PATTERNS, message)) return "bad_request";
  if (matchesAny(CONFIGURATION_PATTERNS, message)) return "configuration";
  if (TIMEOUT_PATTERN.test(message)) return "timeout";
  if (matchesAny(UNPARSEABLE_PATTERNS, message)) return "unparseable";
  if (/all retry attempts failed/i.test(message)) return "upstream";
  // What is left was thrown by fetch itself or by reading the body:
  // "fetch failed", ECONNREFUSED, ENOTFOUND, socket resets, HTML error pages.
  return "network";
}

function classifyHttpStatus(status: number, message: string): LlmFailureKind {
  if (status >= 500) return "upstream";
  if (status === 401 || status === 403) return "configuration";
  if (status === 402) return "usage_limit";
  if (status === 408) return "timeout";
  if (status === 429) {
    return matchesAny(USAGE_LIMIT_PATTERNS, message)
      ? "usage_limit"
      : "rate_limit";
  }
  if (status === 400 || status === 413 || status === 422) {
    // These usually mean "your request is wrong", which a fallback cannot
    // fix. Some providers also answer 400 for an unknown model or a bad key;
    // those are configuration problems on the primary.
    if (matchesAny(BAD_REQUEST_PATTERNS, message)) return "bad_request";
    return MODEL_OR_KEY_PROBLEM_AT_START.test(providerErrorDetail(message))
      ? "configuration"
      : "bad_request";
  }
  // 404 (model or endpoint not found), 405, 410, 415 and the like: the
  // primary is pointed at something that does not serve this request.
  return "configuration";
}
