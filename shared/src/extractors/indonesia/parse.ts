import type { LocationWorkplaceType } from "../../location-domain";

/** Defensive readers for untrusted upstream JSON. */

export type UnknownRecord = Record<string, unknown>;

export function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** A string id, or an integer id rendered as a string. */
export function asIdentifier(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return String(value);
  }
  return asString(value);
}

export function asHttpUrl(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

export function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(asString).filter((item): item is string => Boolean(item))
    : [];
}

/** `[{ name: "Go" }, { name: "SQL" }]` -> `["Go", "SQL"]`. */
export function namesOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => asString(asRecord(item)?.name))
        .filter((item): item is string => Boolean(item))
    : [];
}

/** Joins a list for a single text field, or `undefined` when empty. */
export function joinList(values: readonly string[]): string | undefined {
  return values.length > 0 ? values.join(", ") : undefined;
}

const WORKPLACE_TYPES: Record<string, LocationWorkplaceType> = {
  remote: "remote",
  wfh: "remote",
  workfromhome: "remote",
  hybrid: "hybrid",
  onsite: "onsite",
  office: "onsite",
  wfo: "onsite",
};

/** Maps source labels ("on-site", "onSite", "Remote", "WFH") to the app's workplace type. */
export function toWorkplaceType(value: unknown): LocationWorkplaceType | null {
  const key = asString(value)
    ?.toLowerCase()
    .replace(/[^a-z]/g, "");
  return key && Object.hasOwn(WORKPLACE_TYPES, key)
    ? WORKPLACE_TYPES[key]
    : null;
}

/** "1–4 years", "3 years", "100+ employees", "up to 50 employees". */
export function formatRange(
  min: number | undefined,
  max: number | undefined,
  unit: string,
): string | undefined {
  if (min !== undefined && max !== undefined) {
    return min === max ? `${min} ${unit}` : `${min}–${max} ${unit}`;
  }
  if (min !== undefined) return `${min}+ ${unit}`;
  if (max !== undefined) return `up to ${max} ${unit}`;
  return undefined;
}
