import { describe, expect, it } from "vitest";
import { getHttpHref } from "./safe-href";

describe("getHttpHref", () => {
  it("keeps http and https links", () => {
    expect(getHttpHref("https://example.com/jobs/1")).toBe(
      "https://example.com/jobs/1",
    );
    expect(getHttpHref("http://example.com")).toBe("http://example.com");
  });

  it.each([
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "/relative",
    "",
    null,
    undefined,
  ])("drops %j", (value) => {
    expect(getHttpHref(value)).toBeNull();
  });
});
