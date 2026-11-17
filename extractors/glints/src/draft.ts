import {
  asNumber,
  asRecord,
  asString,
  type UnknownRecord,
} from "@shared/extractors/indonesia/index.js";

/** Thrown when a description is not readable Draft.js JSON. */
export class DraftJsParseError extends Error {
  constructor() {
    super("Glints job description is not valid Draft.js JSON");
    this.name = "DraftJsParseError";
  }
}

const BLOCK_TAGS: Record<string, string> = {
  unstyled: "p",
  paragraph: "p",
  "header-one": "h1",
  "header-two": "h2",
  "header-three": "h3",
  "header-four": "h4",
  "header-five": "h5",
  "header-six": "h6",
  blockquote: "blockquote",
  "code-block": "pre",
};

const LIST_TAGS: Record<string, "ul" | "ol"> = {
  "unordered-list-item": "ul",
  "ordered-list-item": "ol",
};

const STYLE_TAGS: Record<string, string> = {
  BOLD: "strong",
  ITALIC: "em",
  UNDERLINE: "u",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeLinkUrl(value: unknown): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return ["http:", "https:", "mailto:"].includes(url.protocol)
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function ranges(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((range): range is UnknownRecord => !!range)
    : [];
}

/**
 * Renders one block's text with its inline styles and links. Draft.js
 * offsets count Unicode code points, so the text is split the same way.
 */
function renderInline(block: UnknownRecord, entityMap: UnknownRecord): string {
  const chars = Array.from(typeof block.text === "string" ? block.text : "");
  if (chars.length === 0) return "";
  const styles: Array<Set<string>> = chars.map(() => new Set());
  const links: Array<string | undefined> = chars.map(() => undefined);
  const spans = (range: UnknownRecord) => {
    const offset = Math.max(0, asNumber(range.offset) ?? 0);
    const end = Math.min(chars.length, offset + (asNumber(range.length) ?? 0));
    return { offset, end };
  };

  for (const range of ranges(block.inlineStyleRanges)) {
    const tag = STYLE_TAGS[asString(range.style) ?? ""];
    if (!tag) continue;
    const { offset, end } = spans(range);
    for (let index = offset; index < end; index += 1) styles[index].add(tag);
  }
  for (const range of ranges(block.entityRanges)) {
    const entity = asRecord(entityMap[String(range.key)]);
    if (asString(entity?.type)?.toUpperCase() !== "LINK") continue;
    const data = asRecord(entity?.data);
    const url = safeLinkUrl(data?.url) ?? safeLinkUrl(data?.href);
    if (!url) continue;
    const { offset, end } = spans(range);
    for (let index = offset; index < end; index += 1) links[index] = url;
  }

  let html = "";
  let start = 0;
  for (let index = 1; index <= chars.length; index += 1) {
    const same =
      index < chars.length &&
      links[index] === links[start] &&
      styles[index].size === styles[start].size &&
      [...styles[index]].every((tag) => styles[start].has(tag));
    if (same) continue;
    let run = escapeHtml(chars.slice(start, index).join("")).replace(
      /\n/g,
      "<br>",
    );
    for (const tag of Object.values(STYLE_TAGS)) {
      if (styles[start].has(tag)) run = `<${tag}>${run}</${tag}>`;
    }
    if (links[start]) {
      run = `<a href="${escapeHtml(links[start] as string)}">${run}</a>`;
    }
    html += run;
    start = index;
  }
  return html;
}

/**
 * Converts a Draft.js description (Glints' `descriptionJsonString`) into
 * simple HTML: paragraphs, headings, nested bullet and numbered lists, bold,
 * italic, underline and http(s)/mailto links. Unknown block types become
 * plain paragraphs and blank blocks are dropped. Throws `DraftJsParseError`
 * when the input is not Draft.js JSON.
 */
export function draftJsToHtml(value: string): string {
  let raw: UnknownRecord | null;
  try {
    raw = asRecord(JSON.parse(value));
  } catch {
    throw new DraftJsParseError();
  }
  if (!raw || !Array.isArray(raw.blocks)) throw new DraftJsParseError();
  const entityMap = asRecord(raw.entityMap) ?? {};

  const out: string[] = [];
  // Open lists, outermost first; each `<li>` stays open for nested lists.
  const openLists: Array<"ul" | "ol"> = [];
  const closeListsTo = (depth: number) => {
    while (openLists.length > depth) {
      out.push(`</li></${openLists.pop()}>`);
    }
  };

  for (const block of raw.blocks.map(asRecord)) {
    if (!block) continue;
    const type = asString(block.type) ?? "unstyled";
    const html = renderInline(block, entityMap);
    const listTag = LIST_TAGS[type];

    if (listTag) {
      if (!html.trim()) continue;
      const depth = Math.min(
        Math.max(0, Math.floor(asNumber(block.depth) ?? 0)),
        openLists.length,
      );
      closeListsTo(depth + 1);
      if (openLists.length === depth + 1 && openLists[depth] !== listTag) {
        closeListsTo(depth);
      }
      if (openLists.length === depth + 1) {
        out.push(`</li><li>${html}`);
      } else {
        out.push(`<${listTag}><li>${html}`);
        openLists.push(listTag);
      }
      continue;
    }

    closeListsTo(0);
    if (!html.trim()) continue;
    const tag = BLOCK_TAGS[type] ?? "p";
    out.push(`<${tag}>${html}</${tag}>`);
  }
  closeListsTo(0);
  // One block per line; closing list tags stay on the line they close.
  return out.join("\n").replace(/\n<\/li>/g, "</li>");
}
