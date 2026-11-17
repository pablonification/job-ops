import { describe, expect, it } from "vitest";
import {
  DraftJsParseError,
  draftJsToHtml,
  MAX_DRAFT_BLOCKS,
  MAX_DRAFT_TEXT_LENGTH,
} from "../src/draft";
import detailSample from "./fixtures/detail.json";

function block(text: string, extra: Record<string, unknown> = {}) {
  return {
    key: Math.random().toString(36).slice(2, 7),
    text,
    type: "unstyled",
    depth: 0,
    inlineStyleRanges: [],
    entityRanges: [],
    data: {},
    ...extra,
  };
}

function draft(blocks: unknown[], entityMap: Record<string, unknown> = {}) {
  return JSON.stringify({ blocks, entityMap });
}

describe("Draft.js descriptions", () => {
  it("converts the recorded Glints description to clean HTML", () => {
    const html = draftJsToHtml(
      detailSample.data.getJobById.descriptionJsonString,
    );

    expect(html).toMatch(
      /^<p><strong>AKSION DIGITAL INDONESIA<\/strong> adalah perusahaan/,
    );
    expect(html).toContain(
      "<p><strong>Deskripsi Pekerjaan</strong></p>\n<ul><li>Berpartisipasi aktif",
    );
    expect(html).toContain(
      "aktif dalam perencanaan, pengembangan, dan pemeliharaan antarmuka aplikasi web (UI) yang responsif dan modern di bawah bimbingan tim teknis senior.</li><li>Membantu membangun serta mengintegrasikan komponen frontend dengan REST API pendukung.",
    );
    expect(html).toMatch(
      /Subscription AI \(Claude Code\/Cursor\)<\/li><\/ul>$/,
    );
    // Empty spacer blocks are dropped rather than rendered as empty paragraphs.
    expect(html).not.toContain("<p></p>");
    expect(html.match(/<ul>/g)).toHaveLength(4);
    expect(html.match(/<\/ul>/g)).toHaveLength(4);
  });

  it("renders headings, numbered and nested lists, styles and links", () => {
    const html = draftJsToHtml(
      draft(
        [
          block("Requirements", { type: "header-two" }),
          block("Go or Java", { type: "ordered-list-item" }),
          block("Go preferred", { type: "unordered-list-item", depth: 1 }),
          block("SQL", { type: "ordered-list-item" }),
          block("Apply here now", {
            inlineStyleRanges: [
              { style: "ITALIC", offset: 0, length: 5 },
              { style: "BOLD", offset: 6, length: 4 },
              { style: "STRIKETHROUGH", offset: 0, length: 14 },
            ],
            entityRanges: [{ key: 0, offset: 6, length: 4 }],
          }),
        ],
        {
          0: {
            type: "LINK",
            mutability: "MUTABLE",
            data: { url: "https://glints.com/a?b=1&c=2" },
          },
        },
      ),
    );

    expect(html).toBe(
      [
        "<h2>Requirements</h2>",
        "<ol><li>Go or Java",
        "<ul><li>Go preferred</li></ul></li><li>SQL</li></ol>",
        '<p><em>Apply</em> <a href="https://glints.com/a?b=1&amp;c=2"><strong>here</strong></a> now</p>',
      ].join("\n"),
    );
  });

  it("escapes HTML, keeps line breaks and counts offsets in code points", () => {
    const html = draftJsToHtml(
      draft([
        block("🚀 <script>x</script> & go\nnext", {
          inlineStyleRanges: [{ style: "BOLD", offset: 2, length: 18 }],
        }),
      ]),
    );

    expect(html).toBe(
      "<p>🚀 <strong>&lt;script&gt;x&lt;/script&gt;</strong> &amp; go<br>next</p>",
    );
  });

  it("degrades unknown block types to paragraphs and drops unsafe links", () => {
    const html = draftJsToHtml(
      draft(
        [
          block("Custom", { type: "some-widget" }),
          block("Image", { type: "atomic" }),
          block("click", { entityRanges: [{ key: 0, offset: 0, length: 5 }] }),
        ],
        { 0: { type: "LINK", data: { url: "javascript:alert(1)" } } },
      ),
    );

    expect(html).toBe("<p>Custom</p>\n<p>Image</p>\n<p>click</p>");
  });

  it("switches list types at the same depth", () => {
    expect(
      draftJsToHtml(
        draft([
          block("a", { type: "unordered-list-item" }),
          block("b", { type: "ordered-list-item" }),
        ]),
      ),
    ).toBe("<ul><li>a</li></ul>\n<ol><li>b</li></ol>");
  });

  it("never emits prototype members for block, style or entity names", () => {
    const html = draftJsToHtml(
      draft(
        [
          block("a", { type: "constructor" }),
          block("b", { type: "toString" }),
          block("c", {
            type: "__proto__",
            inlineStyleRanges: [{ style: "constructor", offset: 0, length: 1 }],
            entityRanges: [{ key: "toString", offset: 0, length: 1 }],
          }),
        ],
        {},
      ),
    );

    expect(html).toBe("<p>a</p>\n<p>b</p>\n<p>c</p>");
  });

  it("cuts off a huge description instead of converting all of it", () => {
    const manyBlocks = draftJsToHtml(
      draft(
        Array.from({ length: MAX_DRAFT_BLOCKS + 5 }, (_, n) => block(`b${n}`)),
      ),
    );
    expect(manyBlocks.match(/<p>b\d+<\/p>/g)).toHaveLength(MAX_DRAFT_BLOCKS);
    expect(manyBlocks.endsWith("<p>…</p>")).toBe(true);

    const longText = draftJsToHtml(
      draft([
        block("x".repeat(MAX_DRAFT_TEXT_LENGTH - 2)),
        block("🚀🚀🚀🚀"),
        block("never shown"),
      ]),
    );
    expect(longText).toBe(
      `<p>${"x".repeat(MAX_DRAFT_TEXT_LENGTH - 2)}</p>\n<p>🚀🚀</p>\n<p>…</p>`,
    );

    const exact = draftJsToHtml(draft([block("x".repeat(10))]));
    expect(exact).toBe(`<p>${"x".repeat(10)}</p>`);
  });

  it("throws a parse error for malformed input", () => {
    for (const value of [
      "",
      "not json",
      "{",
      "[]",
      "null",
      JSON.stringify({ entityMap: {} }),
      JSON.stringify({ blocks: "x" }),
    ]) {
      expect(() => draftJsToHtml(value)).toThrow(DraftJsParseError);
    }
  });

  it("returns an empty string for a description without text", () => {
    expect(draftJsToHtml(draft([block(""), block("   ")]))).toBe("");
    expect(draftJsToHtml(draft([]))).toBe("");
  });
});
