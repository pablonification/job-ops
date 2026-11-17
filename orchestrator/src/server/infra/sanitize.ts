const REDACTED = "[REDACTED]";

const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|password|pass|secret|token|api.?key|credential|set-cookie|proxy-authorization|x-api-key)/i;

const DEFAULT_MAX_STRING = 800;
const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_ITEMS = 30;

export function redactString(value: string, max = DEFAULT_MAX_STRING): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…(truncated ${value.length - max} chars)`;
}

export function sanitizeUnknown(
  value: unknown,
  options: { depth?: number; maxItems?: number; maxString?: number } = {},
): unknown {
  const depth = options.depth ?? DEFAULT_MAX_DEPTH;
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxString = options.maxString ?? DEFAULT_MAX_STRING;

  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value, maxString);
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }

  if (value instanceof Error) {
    return sanitizeError(value);
  }

  if (depth <= 0) {
    return "[TRUNCATED_DEPTH]";
  }

  if (Array.isArray(value)) {
    const limited = value.slice(0, maxItems);
    const out = limited.map((item) =>
      sanitizeUnknown(item, {
        depth: depth - 1,
        maxItems,
        maxString,
      }),
    );
    if (value.length > maxItems) {
      out.push(`[TRUNCATED_ITEMS ${value.length - maxItems}]`);
    }
    return out;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [index, [key, entryValue]] of entries.entries()) {
      if (index >= maxItems) {
        out.__truncatedKeys = entries.length - maxItems;
        break;
      }

      if (SENSITIVE_KEY_PATTERN.test(key)) {
        out[key] = REDACTED;
        continue;
      }

      out[key] = sanitizeUnknown(entryValue, {
        depth: depth - 1,
        maxItems,
        maxString,
      });
    }
    return out;
  }

  return String(value);
}

export function sanitizeError(error: Error): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: error.name,
    message: redactString(error.message),
  };

  const maybe = error as Error & {
    status?: number;
    body?: string;
    details?: unknown;
    cause?: unknown;
  };
  if (typeof maybe.status === "number") out.status = maybe.status;
  if (maybe.details !== undefined) out.details = sanitizeUnknown(maybe.details);
  if (maybe.cause !== undefined) out.cause = sanitizeUnknown(maybe.cause);
  if (maybe.body !== undefined) out.body = REDACTED;
  if (error.stack) out.stack = redactString(error.stack, 1200);
  return out;
}

export function sanitizeWebhookPayload(
  payload: unknown,
): Record<string, unknown> {
  const raw = sanitizeUnknown(payload, {
    depth: 4,
    maxItems: 20,
    maxString: 300,
  });
  return (raw && typeof raw === "object" ? raw : { value: raw }) as Record<
    string,
    unknown
  >;
}

const TEXT_SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Authorization header values echoed back.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`],
  // Credentials in URLs: https://user:pass@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
  // Secret-looking query string or key=value pairs.
  [
    /([?&\s,;{"']|^)((?:api[_-]?key|key|token|access[_-]?token|secret|password|auth|signature|sig)\s*["']?\s*[=:]\s*["']?)[^\s&"',;}]+/gi,
    `$1$2${REDACTED}`,
  ],
  // Common provider key shapes (sk-..., sk-ant-..., AIza..., jo_pat_...).
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, REDACTED],
  [/\bjo_pat_[A-Za-z0-9_]{8,}/g, REDACTED],
];

/**
 * Redact secrets inside free text (error messages, upstream detail) and
 * truncate it. `secrets` are exact values known to the caller (for example
 * the API keys a request used); everything shaped like a bearer token, URL
 * credentials, a secret query parameter or a provider key is removed too.
 */
export function redactSensitiveText(
  value: string,
  options: { secrets?: Array<string | null | undefined>; max?: number } = {},
): string {
  let out = value;
  for (const secret of options.secrets ?? []) {
    if (secret && secret.length >= 6) out = out.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of TEXT_SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return redactString(out, options.max ?? DEFAULT_MAX_STRING);
}
