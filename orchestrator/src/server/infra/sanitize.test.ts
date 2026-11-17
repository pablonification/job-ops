import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "./sanitize";

describe("redactSensitiveText", () => {
  it("removes known secrets and secret-shaped text", () => {
    const out = redactSensitiveText(
      "call https://bob:pa55word@proxy.example/v1?key=AIzaSyA1234567890abcdefghij&model=x failed: Bearer abc.def.ghi-jkl, api_key=plain-secret, sk-ant-oat01-abcdefghijklmnop, my-known-secret",
      { secrets: ["my-known-secret"] },
    );
    for (const leaked of [
      "pa55word",
      "AIzaSyA1234567890abcdefghij",
      "abc.def.ghi-jkl",
      "plain-secret",
      "sk-ant-oat01-abcdefghijklmnop",
      "my-known-secret",
    ]) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain("model=x");
  });

  it("truncates long text", () => {
    const out = redactSensitiveText("y".repeat(1_000), { max: 100 });
    expect(out.startsWith("y".repeat(100))).toBe(true);
    expect(out).toContain("truncated 900 chars");
  });
});
