// Client-side relevance check for boards whose keyword search is loose
// (Kalibrr ranks "Tax & Audit Staff" first for "software engineer").
// A job is relevant when its title contains every significant word of the
// search term, after normalising separators and common tech-role synonyms.
// The description is deliberately ignored: prose mentions too many words.

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "dan",
  "di",
  "for",
  "in",
  "of",
  "or",
  "the",
  "to",
  "untuk",
  "with",
  "yang",
]);

/** Single words mapped to a canonical token. */
const WORD_SYNONYMS: Record<string, string> = {
  engineers: "engineer",
  developer: "engineer",
  developers: "engineer",
  programmer: "engineer",
  programmers: "engineer",
  dev: "engineer",
  devs: "engineer",
  golang: "go",
  test: "qa",
  tester: "qa",
  testers: "qa",
  testing: "qa",
  fe: "frontend",
  be: "backend",
};

/** Two-word phrases (after word synonyms) collapsed into one canonical token. */
const PHRASE_SYNONYMS: ReadonlyArray<readonly [string, string, string]> = [
  ["back", "end", "backend"],
  ["front", "end", "frontend"],
  ["full", "stack", "fullstack"],
  ["dev", "ops", "devops"],
  ["site", "reliability", "sre"],
  ["quality", "assurance", "qa"],
  ["machine", "learning", "ml"],
  ["product", "manager", "pm"],
];

/**
 * In a search term, "software engineer/developer/programmer" means any
 * engineering role, so "Backend Developer" matches "software engineer".
 * Titles keep "software" so the term "software" still matches them.
 */
const TERM_PHRASE_SYNONYMS: ReadonlyArray<readonly [string, string, string]> = [
  ...PHRASE_SYNONYMS,
  ["software", "engineer", "engineer"],
];

/** Canonical tokens of a job title, or of a search term with `asSearchTerm`. */
export function canonicalTitleTokens(
  value: string,
  options: { asSearchTerm?: boolean } = {},
): string[] {
  const phrases = options.asSearchTerm ? TERM_PHRASE_SYNONYMS : PHRASE_SYNONYMS;
  const words = value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}+#]+/u)
    .filter((word) => word.length > 0);

  const canonical = (word: string) => WORD_SYNONYMS[word] ?? word;
  const tokens: string[] = [];
  for (const word of words) {
    const token = canonical(word);
    const previous = tokens.at(-1);
    const phrase =
      previous === undefined
        ? undefined
        : phrases.find(
            ([first, second]) =>
              (second === word || second === token) &&
              (previous === first || previous === canonical(first)),
          );
    if (phrase) tokens[tokens.length - 1] = phrase[2];
    else tokens.push(token);
  }
  return tokens.filter((token) => !STOPWORDS.has(token));
}

/**
 * True when the job title contains every significant word of the search term.
 * A term without significant words matches everything.
 */
export function isRelevantJobTitle(title: string, searchTerm: string): boolean {
  const wanted = canonicalTitleTokens(searchTerm, { asSearchTerm: true });
  if (wanted.length === 0) return true;
  const have = new Set(canonicalTitleTokens(title));
  return wanted.every((token) => have.has(token));
}
