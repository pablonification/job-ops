import type { LocationWorkplaceType } from "../../location-domain";
import type { CreateJobInput } from "../../types/jobs";

export const INDONESIA_COUNTRY_KEY = "indonesia";
export const INDONESIA_COUNTRY_NAME = "Indonesia";
export const INDONESIA_SUPPORTED_COUNTRY_KEYS = [INDONESIA_COUNTRY_KEY];

interface IndonesianPlace {
  /** Indonesian name used as the canonical city in location evidence. */
  name: string;
  /** English names and common short forms that boards and users also use. */
  aliases: readonly string[];
  /** City to send to server-side location filters (districts use their city). */
  searchCity: string;
}

// Only places whose names differ between boards need an entry; other cities
// (Bandung, Surabaya, Medan, ...) are spelled the same everywhere and still
// match after "Kota"/"Kabupaten" prefixes are removed.
const INDONESIAN_PLACES: readonly IndonesianPlace[] = [
  {
    name: "Jakarta",
    aliases: ["DKI Jakarta", "Jakarta Raya", "Daerah Khusus Ibukota Jakarta"],
    searchCity: "Jakarta",
  },
  {
    name: "Jakarta Selatan",
    aliases: ["South Jakarta", "Jaksel"],
    searchCity: "Jakarta",
  },
  {
    name: "Jakarta Utara",
    aliases: ["North Jakarta", "Jakut"],
    searchCity: "Jakarta",
  },
  {
    name: "Jakarta Barat",
    aliases: ["West Jakarta", "Jakbar"],
    searchCity: "Jakarta",
  },
  {
    name: "Jakarta Timur",
    aliases: ["East Jakarta", "Jaktim"],
    searchCity: "Jakarta",
  },
  {
    name: "Jakarta Pusat",
    aliases: ["Central Jakarta", "Jakpus"],
    searchCity: "Jakarta",
  },
  {
    name: "Kepulauan Seribu",
    aliases: ["Thousand Islands"],
    searchCity: "Jakarta",
  },
  {
    name: "Tangerang Selatan",
    aliases: ["South Tangerang", "Tangsel"],
    searchCity: "Tangerang",
  },
  {
    name: "Yogyakarta",
    aliases: [
      "Jogja",
      "Jogjakarta",
      "Yogya",
      "DI Yogyakarta",
      "Daerah Istimewa Yogyakarta",
      "Special Region of Yogyakarta",
    ],
    searchCity: "Yogyakarta",
  },
  { name: "Surakarta", aliases: ["Solo"], searchCity: "Surakarta" },
];

const ADMIN_PREFIX =
  /^(kota administrasi|kota adm|kota|kabupaten|kab|city of)\s+/;

function normalizePlace(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(ADMIN_PREFIX, "");
}

const PLACE_BY_KEY = new Map<string, IndonesianPlace>(
  INDONESIAN_PLACES.flatMap((place) =>
    [place.name, ...place.aliases].map(
      (alias) => [normalizePlace(alias), place] as const,
    ),
  ),
);

function findPlace(name: string | null | undefined) {
  return PLACE_BY_KEY.get(normalizePlace(name));
}

/** Canonical (Indonesian) name for a place: "South Jakarta" -> "Jakarta Selatan". */
export function canonicalIndonesianPlaceName(name: string): string {
  return findPlace(name)?.name ?? name.replace(/\s+/g, " ").trim();
}

/** Every known name of a place, canonical first; just the input when unknown. */
export function indonesianPlaceNames(name: string): string[] {
  const place = findPlace(name);
  return place ? [place.name, ...place.aliases] : [name.trim()];
}

/** City to send to a server-side location filter ("Jakarta Selatan" -> "Jakarta"). */
export function indonesianSearchCity(name: string): string {
  return findPlace(name)?.searchCity ?? name.replace(/\s+/g, " ").trim();
}

function placeKey(name: string | null | undefined): string {
  const place = findPlace(name);
  return place ? normalizePlace(place.name) : normalizePlace(name);
}

/**
 * True when a job place lies within the requested place, across English and
 * Indonesian names: "South Jakarta" is within "Jakarta" and "Jakarta Selatan",
 * but "Jakarta" is not within "Jakarta Selatan".
 */
export function matchesIndonesianPlace(
  jobPlace: string | null | undefined,
  requestedPlace: string,
): boolean {
  const job = placeKey(jobPlace).split(" ").filter(Boolean);
  const requested = placeKey(requestedPlace).split(" ").filter(Boolean);
  if (job.length === 0 || requested.length === 0) return false;
  for (let start = 0; start + requested.length <= job.length; start += 1) {
    if (requested.every((token, index) => job[start + index] === token)) {
      return true;
    }
  }
  return false;
}

/**
 * Client-side city filter, applied before a job counts toward a per-term cap.
 * No requested cities, or a remote job, always matches (the shared location
 * filter makes the final remote decision).
 */
export function jobMatchesIndonesianCities(
  job: Pick<CreateJobInput, "location" | "locationEvidence" | "isRemote">,
  cities: readonly string[],
): boolean {
  if (cities.length === 0 || job.isRemote === true) return true;
  const evidence = job.locationEvidence;
  const places = [
    evidence?.city,
    ...(evidence?.regionHints ?? []),
    ...(job.location?.split(",") ?? []),
  ].filter((place): place is string => typeof place === "string");
  return cities.some((city) =>
    places.some((place) => matchesIndonesianPlace(place, city)),
  );
}

function cleanPart(value: string | null | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed : undefined;
}

export interface IndonesianLocationInput {
  /** Source city as published, e.g. "Jakarta Selatan" or "Central Jakarta". */
  city?: string | null;
  /** Province or region, e.g. "DKI Jakarta". */
  region?: string | null;
  /** Country name from the source; defaults to Indonesia. */
  country?: string | null;
  workplaceType?: LocationWorkplaceType | null;
  source: string;
}

export interface IndonesianLocation {
  location: string;
  locationEvidence: NonNullable<CreateJobInput["locationEvidence"]>;
}

/**
 * Builds a display location that always names the country ("Jakarta Selatan,
 * Indonesia") plus structured evidence, so jobs from city-only source
 * locations survive the shared country/city location filter. The evidence
 * city is the canonical Indonesian name and the evidence location lists the
 * other names, so a filter for "South Jakarta" or "Jakarta Selatan" keeps the
 * job whichever spelling the board used.
 */
export function buildIndonesianLocation(
  input: IndonesianLocationInput,
): IndonesianLocation {
  const country = cleanPart(input.country) ?? INDONESIA_COUNTRY_NAME;
  const city = cleanPart(input.city);
  const region = cleanPart(input.region);
  const parts: string[] = [];
  const has = (list: readonly string[], value: string) =>
    list.some((existing) => existing.toLowerCase() === value.toLowerCase());
  for (const part of [city, region, country]) {
    if (part && !has(parts, part)) parts.push(part);
  }
  const location = parts.join(", ");
  const alternates = city
    ? indonesianPlaceNames(city).filter((name) => !has(parts, name))
    : [];
  const workplaceType = input.workplaceType ?? null;

  return {
    location,
    locationEvidence: {
      location:
        alternates.length > 0
          ? `${location} (${alternates.join(", ")})`
          : location,
      country,
      countryKey: country.toLowerCase(),
      city: city ? canonicalIndonesianPlaceName(city) : null,
      regionHints: region ? [region] : null,
      workplaceType,
      isRemote: workplaceType === "remote",
      isHybrid: workplaceType === "hybrid",
      evidenceQuality: city ? "exact" : "approximate",
      source: input.source,
    },
  };
}
