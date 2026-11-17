import { describe, expect, it } from "vitest";
import { isHttpUrlWhenParseable, isPublicLookingHttpUrl } from "./http-url";

describe("isHttpUrlWhenParseable", () => {
  it.each([
    ["https://example.com/jobs/1", true],
    ["http://example.com", true],
    ["javascript:alert(1)", false],
    ["data:text/html,<script>alert(1)</script>", false],
    ["mailto:someone@example.com", false],
    // Unparseable values are left to zod's own `.url()` issue.
    ["/relative/path", true],
    ["", true],
  ])("%j -> %j", (value, expected) => {
    expect(isHttpUrlWhenParseable(value)).toBe(expected);
  });
});

describe("isPublicLookingHttpUrl", () => {
  it.each([
    ["https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/jobs/jobs", true],
    ["https://boards.greenhouse.io/acme", true],
    ["http://169.254.169.254/wday/cxs/a/b/jobs", false],
    ["http://127.0.0.1:8080/wday/cxs/a/b/jobs", false],
    ["http://[::1]/wday/cxs/a/b/jobs", false],
    ["http://[::ffff:127.0.0.1]/x", false],
    ["http://localhost/x", false],
    ["http://intranet/x", false],
    ["http://db.internal/x", false],
    ["http://printer.local/x", false],
    ["http://127.1/x", false],
    ["http://2130706433/x", false],
    ["http://0x7f000001/x", false],
    ["https://user:pass@example.com/x", false],
    ["ftp://example.com/x", false],
    ["javascript:alert(1)", false],
  ])("%j -> %j", (value, expected) => {
    expect(isPublicLookingHttpUrl(value)).toBe(expected);
  });
});
