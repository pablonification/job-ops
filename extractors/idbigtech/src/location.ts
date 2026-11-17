import {
  buildIndonesianLocation,
  type IndonesianLocation,
  matchesIndonesianPlace,
} from "@shared/extractors/indonesia/index.js";
import type { LocationWorkplaceType } from "@shared/location-domain";
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

/** Indonesian location evidence for a posting, from one or more city names. */
export function companyLocation(input: {
  cities: readonly (string | null | undefined)[];
  requestedCities: readonly string[];
  region?: string | null;
  workplaceType?: LocationWorkplaceType | null;
}): IndonesianLocation {
  return buildIndonesianLocation({
    city: pickCity(input.cities, input.requestedCities),
    region: input.region,
    workplaceType: input.workplaceType ?? null,
    source: ID_BIG_TECH_SOURCE,
  });
}

/** Epoch milliseconds (as sent by Lever and Traveloka) to an ISO date-time. */
export function epochMsToIso(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : undefined;
}
