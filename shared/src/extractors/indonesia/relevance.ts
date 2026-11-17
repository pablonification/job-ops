// Client-side relevance check for job titles, used where a board's keyword
// search is loose (Kalibrr ranks "Tax & Audit Staff" first for "software
// engineer") or missing (company career sites listed whole).
//
// A search term is read as up to two parts, each optional:
// - a level ("intern", "new grad", "junior"), matched by family, and
// - a role ("software engineer", "mobile developer", "data scientist").
// A title matches when it carries every level of the term and the role.
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
  // Engineer family: every word form and the usual abbreviations.
  engineers: "engineer",
  engineering: "engineer",
  developer: "engineer",
  developers: "engineer",
  programmer: "engineer",
  programmers: "engineer",
  dev: "engineer",
  devs: "engineer",
  sde: "engineer",
  sdes: "engineer",
  swe: "engineer",
  swes: "engineer",
  // Levels.
  interns: "intern",
  internship: "intern",
  internships: "intern",
  magang: "intern",
  trainee: "intern",
  trainees: "intern",
  apprentice: "intern",
  apprentices: "intern",
  apprenticeship: "intern",
  graduates: "graduate",
  grad: "graduate",
  grads: "graduate",
  campus: "graduate",
  jr: "junior",
  associate: "junior",
  associates: "junior",
  // Specialisations.
  golang: "go",
  test: "qa",
  tester: "qa",
  testers: "qa",
  testing: "qa",
  fe: "frontend",
  be: "backend",
  managers: "manager",
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
  ["react", "native", "reactnative"],
  ["new", "graduate", "graduate"],
  ["fresh", "graduate", "graduate"],
  ["early", "career", "graduate"],
  ["entry", "level", "graduate"],
];

/**
 * In a search term, "software engineer/developer/programmer" means any
 * software role, so "Backend Developer" matches "software engineer".
 * Titles keep "software" so the term "software" still matches them.
 */
const TERM_PHRASE_SYNONYMS: ReadonlyArray<readonly [string, string, string]> = [
  ...PHRASE_SYNONYMS,
  ["software", "engineer", "engineer"],
];

const LEVELS = new Set(["intern", "graduate", "junior"]);

/** Term tokens that a title satisfies with any of these tokens. */
const ROLE_FAMILIES: Record<string, readonly string[]> = {
  mobile: [
    "mobile",
    "android",
    "ios",
    "flutter",
    "reactnative",
    "kotlin",
    "swift",
  ],
};

/** Titles with these words are management roles, a family of their own. */
const MANAGEMENT = new Set([
  "manager",
  "management",
  "head",
  "director",
  "vp",
  "chief",
  "cto",
]);

/** Words in a search term that ask for a software role. */
const SOFTWARE_TERM_WORDS = new Set([
  "software",
  "developer",
  "developers",
  "programmer",
  "programmers",
  "dev",
  "devs",
  "sde",
  "swe",
  "coder",
]);

/** Engineering fields outside software ("Project Engineer", "ME Engineer"). */
const NON_SOFTWARE_FIELDS = new Set([
  "project",
  "projects",
  "civil",
  "mechanical",
  "electrical",
  "me",
  "mep",
  "maintenance",
  "facility",
  "facilities",
  "property",
  "sales",
  "presales",
  "field",
  "process",
  "sap",
  "structural",
  "chemical",
  "industrial",
  "hvac",
  "construction",
  "site",
  "mining",
  "manufacturing",
  "logistics",
  "warehouse",
  "plant",
  "piping",
  "geotechnical",
  "environmental",
  "safety",
  "hse",
  "commissioning",
  "building",
  "production",
]);

/** Words that make an engineer title a software one despite a field word. */
const SOFTWARE_QUALIFIERS = new Set([
  "software",
  "backend",
  "frontend",
  "fullstack",
  "platform",
  "data",
  "ml",
  "ai",
  "qa",
  "sre",
  "devops",
  "security",
  "cybersecurity",
  "infrastructure",
  "infra",
  "embedded",
  "cloud",
  "web",
  "api",
  "systems",
  "network",
  "automation",
  "application",
  "applications",
  "go",
  "java",
  "python",
  "javascript",
  "typescript",
  "node",
  "react",
  "php",
  "ruby",
  "rust",
  "database",
  "distributed",
  ...ROLE_FAMILIES.mobile,
]);

function words(value: string): string[] {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}+#]+/u)
    .filter((word) => word.length > 0);
}

/** Canonical tokens of a job title, or of a search term with `asSearchTerm`. */
export function canonicalTitleTokens(
  value: string,
  options: { asSearchTerm?: boolean } = {},
): string[] {
  const phrases = options.asSearchTerm ? TERM_PHRASE_SYNONYMS : PHRASE_SYNONYMS;
  const canonical = (word: string) => WORD_SYNONYMS[word] ?? word;
  const tokens: string[] = [];
  for (const word of words(value)) {
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

/** Equal, or the same word in singular and plural form. */
function sameWord(left: string, right: string): boolean {
  return (
    left === right ||
    left === `${right}s` ||
    right === `${left}s` ||
    left === `${right}es` ||
    right === `${left}es`
  );
}

function titleHas(titleTokens: readonly string[], termToken: string): boolean {
  const accepted = ROLE_FAMILIES[termToken] ?? [termToken];
  return titleTokens.some((token) =>
    accepted.some((wanted) => sameWord(token, wanted)),
  );
}

const hasAny = (tokens: readonly string[], set: ReadonlySet<string>) =>
  tokens.some((token) => set.has(token));

/**
 * True when the job title carries every level of the search term and its
 * role. A term without significant words matches everything.
 */
export function isRelevantJobTitle(title: string, searchTerm: string): boolean {
  const termTokens = canonicalTitleTokens(searchTerm, { asSearchTerm: true });
  if (termTokens.length === 0) return true;
  const titleTokens = canonicalTitleTokens(title);

  const termLevels = termTokens.filter((token) => LEVELS.has(token));
  if (!termLevels.every((level) => titleTokens.includes(level))) return false;

  const role = termTokens.filter((token) => !LEVELS.has(token));
  if (role.length === 0) return true;
  if (!role.every((token) => titleHas(titleTokens, token))) return false;

  // "Engineering Manager" is not a "software engineer" job.
  if (hasAny(titleTokens, MANAGEMENT) && !hasAny(role, MANAGEMENT)) {
    return false;
  }

  // "Project Engineer" is not a "software engineer" job, but "Engineer",
  // "Data Engineer" and "Security Engineer" are.
  const asksForSoftware = words(searchTerm).some((word) =>
    SOFTWARE_TERM_WORDS.has(word),
  );
  if (
    asksForSoftware &&
    hasAny(titleTokens, NON_SOFTWARE_FIELDS) &&
    !hasAny(titleTokens, SOFTWARE_QUALIFIERS)
  ) {
    return false;
  }
  return true;
}
