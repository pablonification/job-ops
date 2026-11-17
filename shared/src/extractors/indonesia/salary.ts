export type SalaryInterval =
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly";

const SALARY_INTERVALS: Record<
  SalaryInterval,
  { unit: string; aliases: readonly string[] }
> = {
  hourly: { unit: "hour", aliases: ["hour", "jam"] },
  daily: { unit: "day", aliases: ["day", "hari"] },
  weekly: { unit: "week", aliases: ["week", "minggu"] },
  monthly: { unit: "month", aliases: ["month", "bulan"] },
  yearly: { unit: "year", aliases: ["year", "annual", "annually", "tahun"] },
};

const SALARY_INTERVAL_BY_ALIAS = new Map<string, SalaryInterval>(
  (
    Object.entries(SALARY_INTERVALS) as Array<
      [SalaryInterval, (typeof SALARY_INTERVALS)[SalaryInterval]]
    >
  ).flatMap(([interval, { aliases }]) =>
    [interval, ...aliases].map((alias) => [alias, interval] as const),
  ),
);

/** Maps source period labels ("MONTHLY", "Per Month", "bulan") to the app's interval values. */
export function normalizeSalaryInterval(
  value: string | null | undefined,
): SalaryInterval | undefined {
  const key = value
    ?.trim()
    .toLowerCase()
    .replace(/^(per|a|an|\/)\s*/, "");
  return key ? SALARY_INTERVAL_BY_ALIAS.get(key) : undefined;
}

export interface NormalizedSalary {
  salary?: string;
  salaryMinAmount?: number;
  salaryMaxAmount?: number;
  salaryCurrency?: string;
  salaryInterval?: SalaryInterval;
}

function positiveAmount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/**
 * Builds the job salary fields from a numeric range. Zero or missing amounts
 * mean "not published" on Indonesian boards, so they produce no salary.
 */
export function buildSalaryFields(input: {
  min?: unknown;
  max?: unknown;
  currency?: string | null;
  interval?: string | null;
}): NormalizedSalary {
  let min = positiveAmount(input.min);
  let max = positiveAmount(input.max);
  if (min === undefined && max === undefined) return {};
  if (min !== undefined && max !== undefined && max < min) {
    [min, max] = [max, min];
  }

  const currency = input.currency?.trim().toUpperCase() || undefined;
  const interval = normalizeSalaryInterval(input.interval);
  const format = (value: number) =>
    new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(value);
  const amount =
    min !== undefined && max !== undefined
      ? min === max
        ? format(min)
        : `${format(min)}–${format(max)}`
      : min !== undefined
        ? `from ${format(min)}`
        : `up to ${format(max as number)}`;

  return {
    salary: `${currency ? `${currency} ` : ""}${amount}${
      interval ? ` / ${SALARY_INTERVALS[interval].unit}` : ""
    }`,
    salaryMinAmount: min,
    salaryMaxAmount: max,
    salaryCurrency: currency,
    salaryInterval: interval,
  };
}
