import {
  buildSalaryFields,
  type NormalizedSalary,
  normalizeSalaryInterval,
} from "@shared/extractors/indonesia/index.js";

// "Rp 20.000.000 – Rp 30.000.000 per month" (Indonesian locale) or
// "Rp 6,000,000 – Rp 7,000,000 per month" (English locale); the upper bound
// and the period are optional.
const SALARY_LABEL =
  /^(?:rp\.?|idr)\s*([\d.,]+)(?:\s*[-–—]\s*(?:rp\.?|idr)?\s*([\d.,]+))?(?:(?:\s+per\s+|\s*\/\s*)([a-z]+))?$/i;
// Whole rupiah amounts, ungrouped or grouped in thousands with dots or commas.
const GROUPED_AMOUNT = /^(?:\d+|\d{1,3}(?:\.\d{3})+|\d{1,3}(?:,\d{3})+)$/;

function parseAmount(value: string): number | undefined {
  if (!GROUPED_AMOUNT.test(value)) return undefined;
  const amount = Number(value.replace(/[.,]/g, ""));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : undefined;
}

/**
 * Parses JobStreet's salary label into rupiah amounts and an interval when it
 * has the usual "Rp X – Rp Y per month" form. Any other label (another
 * currency, decimals, "juta", free text) is kept as text only.
 */
export function parseJobStreetSalary(
  label: string | undefined,
): NormalizedSalary {
  const text = label?.replace(/\s+/g, " ").trim();
  if (!text) return {};
  const match = SALARY_LABEL.exec(text);
  if (!match) return { salary: text };

  const [, rawMin, rawMax, rawPeriod] = match;
  const min = parseAmount(rawMin);
  const max = rawMax === undefined ? undefined : parseAmount(rawMax);
  const interval = rawPeriod ? normalizeSalaryInterval(rawPeriod) : undefined;
  if (
    min === undefined ||
    (rawMax !== undefined && max === undefined) ||
    (rawPeriod !== undefined && interval === undefined)
  ) {
    return { salary: text };
  }
  // A single amount is the salary itself, not a lower bound.
  return buildSalaryFields({ min, max: max ?? min, currency: "IDR", interval });
}
