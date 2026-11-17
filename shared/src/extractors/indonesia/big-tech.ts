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
 * Reads the stored setting (a JSON array of company ids). A missing or
 * unreadable value means "all companies"; unknown ids are ignored. The result
 * keeps the catalog order and can be empty.
 */
export function parseEnabledIdBigTechCompanies(
  raw: string | null | undefined,
): IdBigTechCompanyId[] {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return [...ID_BIG_TECH_COMPANY_IDS];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [...ID_BIG_TECH_COMPANY_IDS];
  }
  if (!Array.isArray(parsed)) return [...ID_BIG_TECH_COMPANY_IDS];
  const wanted = new Set(parsed.filter(isIdBigTechCompanyId));
  return ID_BIG_TECH_COMPANY_IDS.filter((id) => wanted.has(id));
}
