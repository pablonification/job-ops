/**
 * Readers for list fields stored as text on jobs and Role CVs: JSON arrays
 * (tailored skills, sponsor match names) and comma-separated ids (selected
 * project ids).
 */

/** The parsed array, or null when the value is empty or not a JSON array. */
export function parseJsonArray(
  value: string | null | undefined,
): unknown[] | null {
  if (!value?.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Splits a comma-separated id list, dropping blanks. */
export function splitIdList(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}
