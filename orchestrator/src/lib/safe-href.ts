/**
 * Returns the URL when it is an absolute http or https link, otherwise null.
 * Job links come from scraped pages, imports and agents, so anything else
 * (`javascript:`, `data:`) must never become an `href`.
 */
export function getHttpHref(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}
