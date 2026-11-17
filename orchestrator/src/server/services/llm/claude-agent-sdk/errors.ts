import { truncate } from "../utils/string";

/**
 * Why a Claude (subscription) call failed. Callers outside this module (the
 * pipeline pause logic, a future failover layer) only ever see the error
 * message string returned by `LlmService.callJson`, so the classification
 * works on strings and every error this provider throws carries a stable
 * marker phrase.
 */
export type ClaudeAgentSdkFailureKind =
  | "auth"
  | "usage_limit"
  | "rate_limit"
  | "upstream"
  | "timeout"
  | "aborted"
  | "other";

const PROVIDER_LABEL = "Claude (subscription)";

/**
 * Marker phrases. `AUTH` deliberately contains "not authenticated" so
 * `isConfigurationFailure` pauses the pipeline instead of failing every job.
 */
const MARKERS = {
  auth: `${PROVIDER_LABEL} is not authenticated`,
  usage_limit: `${PROVIDER_LABEL} usage limit reached`,
  rate_limit: `${PROVIDER_LABEL} rate limit reached`,
  upstream: `${PROVIDER_LABEL} upstream error`,
  timeout: `${PROVIDER_LABEL} timed out`,
  aborted: `${PROVIDER_LABEL} request was aborted`,
  other: `${PROVIDER_LABEL} request failed`,
} as const satisfies Record<ClaudeAgentSdkFailureKind, string>;

const AUTH_PATTERNS: RegExp[] = [
  /not (authenticated|logged in)/i,
  /authentication[_ ]?(failed|error)/i,
  /invalid (api[_ ]?key|bearer token|x-api-key|oauth|token|authentication)/i,
  /oauth token (has )?(expired|been revoked|is invalid)/i,
  /(login|token) (has )?expired/i,
  /please run \/login/i,
  /oauth_org_not_allowed|account_on_hold|verification_required/i,
  /\b401\b/,
  /\b403\b.*(forbidden|permission|oauth|token)/i,
];

const USAGE_LIMIT_PATTERNS: RegExp[] = [
  /usage limit/i,
  /hit your [a-z ]*limit/i,
  /(session|weekly|daily|monthly|5-hour) limit/i,
  /limit (will )?resets?\b/i,
  /billing[_ ]error/i,
  /credit balance is too low/i,
  /out of (extra )?usage/i,
];

const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate[_ -]?limit/i,
  /\b429\b/,
  /too many requests/i,
  /temporarily limiting requests/i,
];

const UPSTREAM_PATTERNS: RegExp[] = [
  /overloaded/i,
  /\b5(00|02|03|04|29)\b/,
  /server[_ ]error/i,
  /internal (server )?error/i,
  /service unavailable/i,
];

/**
 * Classify a failure message from this provider (or a raw SDK/CLI error
 * message) into a failure kind. Marker phrases win over pattern matching so
 * re-classifying an already wrapped message is stable.
 */
export function classifyClaudeAgentSdkError(
  message: string,
): ClaudeAgentSdkFailureKind {
  for (const kind of Object.keys(MARKERS) as ClaudeAgentSdkFailureKind[]) {
    if (kind !== "other" && message.includes(MARKERS[kind])) return kind;
  }
  if (USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(message))) {
    return "usage_limit";
  }
  if (RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(message))) {
    return "rate_limit";
  }
  if (AUTH_PATTERNS.some((pattern) => pattern.test(message))) {
    return "auth";
  }
  if (UPSTREAM_PATTERNS.some((pattern) => pattern.test(message))) {
    return "upstream";
  }
  if (/timed out|timeout/i.test(message)) return "timeout";
  return "other";
}

/** True when the subscription itself is exhausted or throttled. */
export function isClaudeAgentSdkLimitError(message: string): boolean {
  const kind = classifyClaudeAgentSdkError(message);
  return kind === "usage_limit" || kind === "rate_limit";
}

const AUTH_HELP =
  "Run `claude setup-token` and set the printed token as CLAUDE_CODE_OAUTH_TOKEN.";

/**
 * Build the user-facing error for a failure kind. Detail text is truncated so
 * no large upstream payload ends up in logs or API error details.
 */
export function buildClaudeAgentSdkErrorMessage(
  kind: ClaudeAgentSdkFailureKind,
  detail?: string | null,
): string {
  const cleanDetail = detail?.replace(/\s+/g, " ").trim();
  const shortDetail = cleanDetail ? truncate(cleanDetail, 300) : "";
  switch (kind) {
    case "auth":
      return shortDetail
        ? `${MARKERS.auth}: ${shortDetail}. ${AUTH_HELP}`
        : `${MARKERS.auth}. ${AUTH_HELP}`;
    case "timeout":
      if (!shortDetail) return `${MARKERS.timeout}.`;
      return /^after\b/i.test(shortDetail)
        ? `${MARKERS.timeout} ${shortDetail}.`
        : `${MARKERS.timeout}: ${shortDetail}`;
    case "aborted":
      return `${MARKERS.aborted}.`;
    default:
      return shortDetail
        ? `${MARKERS[kind]}: ${shortDetail}`
        : `${MARKERS[kind]}.`;
  }
}

export class ClaudeAgentSdkError extends Error {
  readonly kind: ClaudeAgentSdkFailureKind;

  constructor(kind: ClaudeAgentSdkFailureKind, detail?: string | null) {
    super(buildClaudeAgentSdkErrorMessage(kind, detail));
    this.name = "ClaudeAgentSdkError";
    this.kind = kind;
  }

  /** Wrap a raw SDK/CLI message, classifying it by its text. */
  static fromMessage(message: string): ClaudeAgentSdkError {
    return new ClaudeAgentSdkError(
      classifyClaudeAgentSdkError(message),
      message,
    );
  }
}
