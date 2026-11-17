/**
 * Target-company matching, shared by the server (job payloads, scoring, MCP)
 * and the client so both agree on which jobs are at a target company.
 *
 * The `targetCompanies` setting is a list of lines. Each line is one company,
 * optionally with aliases separated by "|", e.g. `GoTo | Gojek | Tokopedia`.
 *
 * Matching rules:
 * - Case, accents and punctuation are ignored; names are compared as words.
 *   CamelCase counts as a word break ("GrabTaxi" is "Grab Taxi").
 * - Domain endings are dropped ("tiket.com" is "tiket").
 * - Legal and regional affixes at the start or end of a name you type are
 *   ignored ("PT Shopee Indonesia" is "Shopee"). Extra words in the employer
 *   name never prevent a match ("PT GoTo Gojek Tokopedia Tbk" contains
 *   "Gojek").
 * - A name matches only on whole words: "Grab" matches "GrabTaxi Holdings"
 *   but not "Grabango" or "Telegraph"; "Sea" does not match "Research".
 * - Spacing inside a name does not matter: "GoTo" matches "Go To" and the
 *   reverse.
 */

/** One target company: a display label plus every name that counts for it. */
export type TargetCompanyGroup = {
  /** The first name on the line, as typed. */
  label: string;
  /** Every name on the line, as typed (label first). */
  names: string[];
};

export type TargetCompanyMatcher = {
  groups: TargetCompanyGroup[];
  /** True when no usable target company is configured. */
  isEmpty: boolean;
  /** The group whose name appears in the employer name, or null. */
  match: (employer: string | null | undefined) => TargetCompanyGroup | null;
  /** Shorthand for `match(employer) !== null`. */
  matches: (employer: string | null | undefined) => boolean;
};

/** Words that describe a legal form or region rather than the company. */
const AFFIX_WORDS = new Set([
  "pt",
  "tbk",
  "persero",
  "cv",
  "pte",
  "ltd",
  "limited",
  "inc",
  "incorporated",
  "llc",
  "llp",
  "plc",
  "corp",
  "corporation",
  "co",
  "company",
  "gmbh",
  "bv",
  "sdn",
  "bhd",
  "holding",
  "holdings",
  "group",
  "indonesia",
  "singapore",
  "malaysia",
  "international",
]);

const DOMAIN_SUFFIX_PATTERN =
  /([\p{L}\p{N}])\.(?:co\.id|com|co|id|io|net|org|ai|app|sg|my)(?![\p{L}\p{N}])/gu;

const ALIAS_SEPARATOR = "|";

function tokenize(value: string): string[] {
  return (
    value
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      // "tiket.com" -> "tiket", "Shopee.co.id" -> "Shopee"
      .replace(DOMAIN_SUFFIX_PATTERN, "$1")
      // "GrabTaxi" -> "Grab Taxi", "TikTok" -> "Tik Tok"
      .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
      .replace(/['’]/g, "")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
  );
}

/** Drop affix words from both ends, keeping at least one word. */
function stripEdgeAffixes(tokens: string[]): string[] {
  let start = 0;
  let end = tokens.length;
  while (end - start > 1 && AFFIX_WORDS.has(tokens[start])) start += 1;
  while (end - start > 1 && AFFIX_WORDS.has(tokens[end - 1])) end -= 1;
  return tokens.slice(start, end);
}

/** The comparable form of a name the user typed, or null if unusable. */
function toNameKey(name: string): string | null {
  const tokens = stripEdgeAffixes(tokenize(name));
  if (tokens.length === 0) return null;
  // A name made only of affix words ("PT", "Holdings") would match far too
  // much; ignore it.
  if (tokens.length === 1 && AFFIX_WORDS.has(tokens[0])) return null;
  return tokens.join("");
}

/**
 * True when some run of whole employer words, joined without spaces, equals
 * the key. Runs start and end on word boundaries, so a key never matches
 * inside a word.
 */
function containsKey(employerTokens: string[], key: string): boolean {
  for (let start = 0; start < employerTokens.length; start += 1) {
    let joined = "";
    for (let end = start; end < employerTokens.length; end += 1) {
      joined += employerTokens[end];
      if (joined.length > key.length) break;
      if (!key.startsWith(joined)) break;
      if (joined === key) return true;
    }
  }
  return false;
}

/** Split one setting line into its names (aliases). */
export function parseTargetCompanyLine(line: string): string[] {
  return line
    .split(ALIAS_SEPARATOR)
    .map((name) => name.trim())
    .filter(Boolean);
}

/**
 * Build a matcher from the `targetCompanies` setting value. Build it once per
 * request and reuse it for every job.
 */
export function createTargetCompanyMatcher(
  lines: readonly string[] | null | undefined,
): TargetCompanyMatcher {
  const compiled: Array<{ group: TargetCompanyGroup; keys: string[] }> = [];

  for (const line of lines ?? []) {
    const names = parseTargetCompanyLine(line);
    const keys = [
      ...new Set(
        names
          .map(toNameKey)
          .filter((key): key is string => key !== null && key.length > 0),
      ),
    ];
    if (names.length === 0 || keys.length === 0) continue;
    compiled.push({ group: { label: names[0], names }, keys });
  }

  const match = (
    employer: string | null | undefined,
  ): TargetCompanyGroup | null => {
    if (compiled.length === 0 || !employer?.trim()) return null;
    const employerTokens = tokenize(employer);
    if (employerTokens.length === 0) return null;
    for (const entry of compiled) {
      if (entry.keys.some((key) => containsKey(employerTokens, key))) {
        return entry.group;
      }
    }
    return null;
  };

  return {
    groups: compiled.map((entry) => entry.group),
    isEmpty: compiled.length === 0,
    match,
    matches: (employer) => match(employer) !== null,
  };
}

/**
 * Trim lines, drop blank ones and exact duplicates (case-insensitive).
 * Used when saving the setting.
 */
export function normalizeTargetCompanyLines(
  lines: readonly string[] | null | undefined,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of lines ?? []) {
    const line = parseTargetCompanyLine(raw).join(" | ");
    if (!line) continue;
    const dedupeKey = line.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    result.push(line);
  }
  return result;
}
