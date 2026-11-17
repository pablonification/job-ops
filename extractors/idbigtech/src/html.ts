/** Small HTML helpers for career-site payloads (no DOM parser needed). */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decodes HTML character references in one pass (`&amp;lt;` becomes `&lt;`). */
export function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(#\d+|#x[0-9a-f]+|[a-z]+);/gi,
    (match, entity: string) => {
      if (entity[0] === "#") {
        const code =
          entity[1] === "x" || entity[1] === "X"
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    },
  );
}

/**
 * Greenhouse (`content=true`) and Blibli (SharePoint rich text) send job
 * descriptions as HTML whose markup is itself entity-escaped. Blibli also
 * wraps it in a real `<div class="ExternalClass…">`. Returns plain HTML.
 */
export function unescapeHtmlDescription(value: string): string {
  const trimmed = value.trim();
  const opening = trimmed.match(/^<div class="ExternalClass[^"]*">/i);
  const inner = opening
    ? trimmed.slice(opening[0].length).replace(/<\/div>\s*$/i, "")
    : trimmed;
  return decodeHtmlEntities(inner).trim();
}

/** Strips tags for "is there any real text?" checks. */
export function htmlToPlainText(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Returns the inner HTML of the first `<tagName …>` element starting at or
 * after `fromIndex`, balancing nested elements of the same tag.
 */
export function innerHtmlOfNext(
  html: string,
  tagName: string,
  fromIndex: number,
): string | undefined {
  const open = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  open.lastIndex = fromIndex;
  const first = open.exec(html);
  if (!first) return undefined;
  const contentStart = first.index + first[0].length;
  const tags = new RegExp(`<(/?)${tagName}\\b[^>]*>`, "gi");
  tags.lastIndex = contentStart;
  let depth = 1;
  for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
    depth += tag[1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(contentStart, tag.index);
  }
  return undefined;
}
