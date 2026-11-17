/**
 * Companies the "Indonesia Big Tech" source can scan, in display and scan
 * order. The ids are stored in the `idbigtechCompanies` setting; the labels
 * are what Settings shows. Adding a company means adding an entry here and a
 * fetcher in `extractors/idbigtech/src/companies/`.
 */
export const ID_BIG_TECH_COMPANIES = [
  { id: "grab", label: "Grab" },
  { id: "goto", label: "GoTo" },
  { id: "tiktok", label: "TikTok & Tokopedia" },
  { id: "shopee", label: "Shopee" },
  { id: "traveloka", label: "Traveloka" },
  { id: "tiket", label: "tiket.com" },
  { id: "blibli", label: "Blibli" },
  { id: "xendit", label: "Xendit" },
] as const;

export type IdBigTechCompanyId = (typeof ID_BIG_TECH_COMPANIES)[number]["id"];

export const ID_BIG_TECH_COMPANY_IDS = ID_BIG_TECH_COMPANIES.map(
  (company) => company.id,
) as [IdBigTechCompanyId, ...IdBigTechCompanyId[]];

const COMPANY_ID_SET = new Set<string>(ID_BIG_TECH_COMPANY_IDS);

export function isIdBigTechCompanyId(
  value: unknown,
): value is IdBigTechCompanyId {
  return typeof value === "string" && COMPANY_ID_SET.has(value);
}

/**
 * Reads the stored setting (a JSON array of company ids) in catalog order,
 * ignoring unknown ids. Returns `null` when nothing usable is stored: a
 * missing, unreadable or empty value, or one with no known id.
 */
export function parseIdBigTechCompanies(
  raw: string | null | undefined,
): IdBigTechCompanyId[] | null {
  if (!raw?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const wanted = new Set(parsed.filter(isIdBigTechCompanyId));
  const companies = ID_BIG_TECH_COMPANY_IDS.filter((id) => wanted.has(id));
  return companies.length > 0 ? companies : null;
}

/** The companies a run scans: the stored list, or all of them when unusable. */
export function parseEnabledIdBigTechCompanies(
  raw: string | null | undefined,
): IdBigTechCompanyId[] {
  return parseIdBigTechCompanies(raw) ?? [...ID_BIG_TECH_COMPANY_IDS];
}
