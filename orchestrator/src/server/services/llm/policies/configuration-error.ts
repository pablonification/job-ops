/**
 * Leads the error returned when the primary provider failed for a
 * configuration reason (rejected or missing credentials) and the fallback
 * provider could not cover for it either. The pipeline must still pause.
 */
export const PRIMARY_CONFIGURATION_FAILURE_MARKER =
  "Primary LLM provider is misconfigured or not authenticated";

/**
 * Failures that mean the LLM integration itself is misconfigured: a missing
 * API key, credentials the provider rejects, or a CLI provider that is not
 * logged in. These are the only failures worth pausing a run over and sending
 * the user to Settings → Integrations; every other failure is a per-request
 * fault (provider blip, malformed completion, rate limit) that changing
 * settings cannot fix.
 */
export function isConfigurationFailure(message: string): boolean {
  return (
    message.includes(PRIMARY_CONFIGURATION_FAILURE_MARKER) ||
    message.includes("not configured") ||
    /LLM API error: 40[13]\b/.test(message) ||
    /not (authenticated|logged in)/i.test(message)
  );
}
