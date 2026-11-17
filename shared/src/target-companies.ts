/**
 * Target-company matching, shared by the server (job payloads, scoring, MCP)
 * and the client so both agree on which jobs are at a target company.
 *
 * The `targetCompanies` setting is a list of lines. Each line is one company,
 * optionally with aliases separated by "|", e.g. `GoTo | Gojek | Tokopedia`.
 *
 * Matching rules:
 * - Case, accents and punctuation are ignored; names are compared as words.
 * - Domain endings are dropped ("tiket.com" is "tiket").
 * - Extra words in the employer name never prevent a match ("PT GoTo Gojek
 *   Tokopedia Tbk" contains "Gojek"; "Grab Indonesia" contains "Grab").
 * - A name matches whole words only: "Grab" does not match "Grabango" or
 *   "Telegraph"; "Sea" does not match "Research".
 * - A one-word name also matches the leading part of a CamelCase employer
 *   word ("Grab" matches "GrabTaxi", "Shopee" matches "ShopeePay"), but only
 *   for names of four letters or more, so "Sea" does not match "SeaBank".
 * - A one-word name never matches across separate employer words: "GoTo"
 *   matches "GoTo", "Goto" and "GOTO" but not "Go To Market Agency". A name
 *   typed as several words ("Go To", "SPX Express") matches those words in a
 *   row, or the same letters written as one word.
 * - Legal forms around a name you type are ignored ("PT Tokopedia" is
 *   "Tokopedia"). Other words you type are kept, so "Bank Indonesia" matches
 *   only employers containing both words in a row.
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

/** Legal forms. Ignored around a name the user types. */
const LEGAL_FORM_WORDS = new Set([
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
]);

/**
 * Words too generic to be a target on their own. They are kept inside a
 * longer name ("Bank Indonesia"), but a name made only of them is ignored.
 */
const GENERIC_WORDS = new Set([
  ...LEGAL_FORM_WORDS,
  "holding",
  "holdings",
  "group",
  "indonesia",
  "singapore",
  "malaysia",
  "international",
]);

/** Shortest one-word name allowed to match part of a CamelCase word. */
const MIN_CAMEL_PREFIX_LENGTH = 4;

const DOMAIN_SUFFIX_PATTERN =
  /([\p{L}\p{N}])\.(?:co\.id|com|co|id|io|net|org|ai|app|sg|my)(?![\p{L}\p{N}])/gu;

const ALIAS_SEPARATOR = "|";

/** Words as written (case kept), without accents, apostrophes or domains. */
function splitWords(value: string): string[] {
  return (
    value
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      // "tiket.com" -> "tiket", "Shopee.co.id" -> "Shopee"
      .replace(DOMAIN_SUFFIX_PATTERN, "$1")
      .replace(/['’]/g, "")
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
  );
}

type EmployerWord = {
  /** The whole word, lower-cased. */
  word: string;
  /** Its CamelCase parts, lower-cased ("GrabTaxi" -> ["grab", "taxi"]). */
  camelParts: string[];
};

function toEmployerWords(employer: string): EmployerWord[] {
  return splitWords(employer).map((raw) => ({
    word: raw.toLowerCase(),
    camelParts: raw
      .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
      .toLowerCase()
      .split(" "),
  }));
}

type NameKey = {
  /** The typed words joined without spaces. */
  key: string;
  /** True when the name was typed as more than one word. */
  isPhrase: boolean;
};

/** The comparable form of a name the user typed, or null if unusable. */
function toNameKey(name: string): NameKey | null {
  let words = splitWords(name).map((word) => word.toLowerCase());
  // A name made only of generic words ("PT", "Holdings", "PT Indonesia")
  // would match far too much; ignore it.
  if (words.every((word) => GENERIC_WORDS.has(word))) return null;

  while (words.length > 1 && LEGAL_FORM_WORDS.has(words[0])) {
    words = words.slice(1);
  }
  // Drop trailing legal forms unless that leaves a very short name: "Sea
  // Limited" stays two words so it does not match everything called "Sea".
  let end = words.length;
  while (end > 1 && LEGAL_FORM_WORDS.has(words[end - 1])) end -= 1;
  if (words.slice(0, end).join("").length >= MIN_CAMEL_PREFIX_LENGTH) {
    words = words.slice(0, end);
  }

  const key = words.join("");
  return key ? { key, isPhrase: words.length > 1 } : null;
}

function matchesName(employerWords: EmployerWord[], name: NameKey): boolean {
  const { key, isPhrase } = name;

  // The name is one employer word: "goto" in "PT GoTo Gojek Tokopedia Tbk".
  if (employerWords.some((entry) => entry.word === key)) return true;

  // A one-word name leads a CamelCase word: "grab" in "GrabTaxi".
  if (
    key.length >= MIN_CAMEL_PREFIX_LENGTH &&
    employerWords.some((entry) => leadsCamelWord(entry.camelParts, key))
  ) {
    return true;
  }

  // A name typed as several words matches those words in a row.
  if (!isPhrase) return false;
  for (let start = 0; start < employerWords.length; start += 1) {
    let joined = "";
    for (let end = start; end < employerWords.length; end += 1) {
      joined += employerWords[end].word;
      if (joined === key) return true;
      if (joined.length >= key.length || !key.startsWith(joined)) break;
    }
  }
  return false;
}

/** True when the first CamelCase parts of a word, joined, equal the key. */
function leadsCamelWord(camelParts: string[], key: string): boolean {
  let joined = "";
  // Stop before the last part: the whole word is handled as an exact match.
  for (let index = 0; index < camelParts.length - 1; index += 1) {
    joined += camelParts[index];
    if (joined === key) return true;
    if (joined.length >= key.length) return false;
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
  const compiled: Array<{ group: TargetCompanyGroup; keys: NameKey[] }> = [];

  for (const line of lines ?? []) {
    const names = parseTargetCompanyLine(line);
    const keys = names
      .map(toNameKey)
      .filter((name): name is NameKey => name !== null);
    if (names.length === 0 || keys.length === 0) continue;
    compiled.push({ group: { label: names[0], names }, keys });
  }

  const match = (
    employer: string | null | undefined,
  ): TargetCompanyGroup | null => {
    if (compiled.length === 0 || !employer?.trim()) return null;
    const employerWords = toEmployerWords(employer);
    if (employerWords.length === 0) return null;
    for (const entry of compiled) {
      if (entry.keys.some((name) => matchesName(employerWords, name))) {
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
