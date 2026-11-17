function normalizeBaseUrl(baseUrl: string | null | undefined): string {
  return (baseUrl ?? "").trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * Whether two provider configurations point at the same endpoint. A fallback
 * that is the same endpoint as the primary cannot help, so it is ignored.
 * Two OpenAI-compatible endpoints at different base URLs are different.
 */
export function isSameLlmEndpoint(
  a: { provider: string; baseUrl: string | null | undefined },
  b: { provider: string; baseUrl: string | null | undefined },
): boolean {
  return (
    a.provider === b.provider &&
    normalizeBaseUrl(a.baseUrl) === normalizeBaseUrl(b.baseUrl)
  );
}

export { normalizeBaseUrl as normalizeLlmBaseUrl };
