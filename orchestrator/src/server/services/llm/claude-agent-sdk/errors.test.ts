import { isConfigurationFailure } from "@server/services/llm/policies/configuration-error";
import { describe, expect, it } from "vitest";
import {
  buildClaudeAgentSdkErrorMessage,
  ClaudeAgentSdkError,
  classifyClaudeAgentSdkError,
  isClaudeAgentSdkLimitError,
} from "./errors";

describe("classifyClaudeAgentSdkError", () => {
  it.each([
    ["Invalid bearer token · Please run /login", "auth"],
    ["authentication_failed", "auth"],
    ["OAuth token has expired", "auth"],
    ["API Error: 401 Unauthorized", "auth"],
    ["oauth_org_not_allowed", "auth"],
    ["You've hit your session limit · resets 3pm", "usage_limit"],
    ["You've hit your weekly limit", "usage_limit"],
    ["Claude AI usage limit reached|1700000000", "usage_limit"],
    ["billing_error", "usage_limit"],
    ["rate_limit", "rate_limit"],
    ["API Error: 429 Too Many Requests", "rate_limit"],
    ["Server is temporarily limiting requests", "rate_limit"],
    ["overloaded", "upstream"],
    ["API Error: 529", "upstream"],
    ["server_error", "upstream"],
    ["Request timed out", "timeout"],
    ["Output did not match schema", "other"],
  ] as const)("classifies %j as %s", (message, kind) => {
    expect(classifyClaudeAgentSdkError(message)).toBe(kind);
  });

  it("is stable for messages this provider already produced", () => {
    for (const kind of [
      "auth",
      "usage_limit",
      "rate_limit",
      "upstream",
      "timeout",
      "aborted",
    ] as const) {
      const message = buildClaudeAgentSdkErrorMessage(kind, "detail");
      expect(classifyClaudeAgentSdkError(message)).toBe(kind);
    }
  });

  it("only treats authentication failures as configuration failures", () => {
    expect(
      isConfigurationFailure(
        new ClaudeAgentSdkError("auth", "expired").message,
      ),
    ).toBe(true);
    for (const kind of ["usage_limit", "rate_limit", "timeout"] as const) {
      expect(
        isConfigurationFailure(new ClaudeAgentSdkError(kind, "x").message),
      ).toBe(false);
    }
  });

  it("flags usage and rate limits for failover", () => {
    expect(
      isClaudeAgentSdkLimitError(
        new ClaudeAgentSdkError("usage_limit", "weekly").message,
      ),
    ).toBe(true);
    expect(isClaudeAgentSdkLimitError("rate_limit")).toBe(true);
    expect(isClaudeAgentSdkLimitError("authentication_failed")).toBe(false);
  });

  it("truncates long upstream detail", () => {
    const message = new ClaudeAgentSdkError("other", "x".repeat(2000)).message;
    expect(message.length).toBeLessThan(400);
  });
});
