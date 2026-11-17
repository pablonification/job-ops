// Kalibrr's `text` search is loose ("Tax & Audit Staff" ranks first for
// "software engineer"), so results are checked against the term locally.

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

const SHORT_TOKEN_LENGTH = 3;

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

export function htmlToPlainText(value: string | undefined): string {
  if (!value) return "";
  return decodeEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

export function searchTermTokens(searchTerm: string): string[] {
  return normalize(searchTerm)
    .split(/[^\p{L}\p{N}+#]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsToken(text: string, token: string): boolean {
  // Short tokens ("go", "qa", "ui") must be whole words; longer ones may be
  // word prefixes so "engineer" also matches "engineering"/"engineers".
  const suffix = token.length <= SHORT_TOKEN_LENGTH ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(token)}${suffix}`,
    "u",
  ).test(text);
}

/**
 * A job relates to the search term when every significant term word appears
 * in its title, description or qualifications. A term with no significant
 * words matches everything.
 */
export function isRelevantToSearchTerm(
  job: { title: string; description?: string; qualifications?: string },
  searchTerm: string,
): boolean {
  const tokens = searchTermTokens(searchTerm);
  if (tokens.length === 0) return true;
  const text = normalize(
    [
      job.title,
      htmlToPlainText(job.description),
      htmlToPlainText(job.qualifications),
    ].join(" "),
  );
  return tokens.every((token) => containsToken(text, token));
}
