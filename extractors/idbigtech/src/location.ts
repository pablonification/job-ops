import {
  buildIndonesianLocation,
  type IndonesianLocation,
  matchesIndonesianPlace,
} from "@shared/extractors/indonesia/index.js";
import type { LocationWorkplaceType } from "@shared/location-domain";
import type { CreateJobInput } from "@shared/types/jobs";
import { ID_BIG_TECH_SOURCE } from "./types";

const ADMIN_PREFIX =
  /^(kota administrasi|kota adm\.?|kota|kabupaten|kab\.?)\s+/i;

/** "Kota Jakarta Pusat" -> "Jakarta Pusat"; trims and collapses spaces. */
export function cleanCityName(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().replace(ADMIN_PREFIX, "");
}

/**
 * Picks the city a multi-city posting is shown under: the first one inside a
 * requested city, otherwise the first one listed.
 */
export function pickCity(
  candidates: readonly (string | null | undefined)[],
  requestedCities: readonly string[],
): string | undefined {
  const cities = candidates.map(cleanCityName).filter(Boolean);
  return (
    cities.find((city) =>
      requestedCities.some((requested) =>
        matchesIndonesianPlace(city, requested),
      ),
    ) ?? cities[0]
  );
}

/**
 * True when a company that only serves the given cities can have results for
 * the run: no requested cities, or a requested place that contains one of
 * them ("Jakarta" for a Jakarta office; not "Jakarta Selatan", because the
 * office's postings only say "Jakarta").
 */
export function servesRequestedCities(
  serviceCities: readonly string[],
  requestedCities: readonly string[],
): boolean {
  return (
    requestedCities.length === 0 ||
    serviceCities.some((city) =>
      requestedCities.some((requested) =>
        matchesIndonesianPlace(city, requested),
      ),
    )
  );
}

/**
 * Splits a "City, Country" place text. "BSD City, Indonesia" gives both;
 * a bare "Indonesia" or "Remote - Indonesia" gives the country only; text
 * without a country ("Headquarters", "2 Locations") gives neither.
 */
export function parsePlaceText(value: string | null | undefined): {
  city?: string;
  country?: string;
} {
  // "Jakarta, Indonesia (Hybrid)": a trailing note is not part of the place.
  const parts = (value ?? "")
    .replace(/\s*\([^()]*\)\s*$/, "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 2) return { city: parts[0], country: parts.at(-1) };
  if (parts.length === 1 && /\bindonesia\b/i.test(parts[0])) {
    return { country: "Indonesia" };
  }
  return {};
}

export function isIndonesia(country: string | null | undefined): boolean {
  return country?.trim().toLowerCase() === "indonesia";
}

/**
 * Location fields for a posting already known to be in Indonesia: display
 * location, evidence (with the country) and the workplace fields. With no
 * usable city the evidence is marked `cityUnknown`, so a city filter keeps
 * the job instead of treating the unknown city as a mismatch.
 */
export function companyLocation(input: {
  cities: readonly (string | null | undefined)[];
  requestedCities: readonly string[];
  region?: string | null;
  workplaceType?: LocationWorkplaceType | null;
}): IndonesianLocation & Pick<CreateJobInput, "isRemote" | "workFromHomeType"> {
  const workplaceType = input.workplaceType ?? null;
  const city = pickCity(input.cities, input.requestedCities);
  const { location, locationEvidence } = buildIndonesianLocation({
    city,
    region: input.region,
    workplaceType,
    source: ID_BIG_TECH_SOURCE,
  });
  return {
    location,
    locationEvidence: city
      ? locationEvidence
      : { ...locationEvidence, cityUnknown: true },
    isRemote: workplaceType === "remote",
    workFromHomeType: workplaceType ?? undefined,
  };
}

/** Epoch milliseconds (as sent by Lever and Traveloka) to an ISO date-time. */
export function epochMsToIso(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : undefined;
}
