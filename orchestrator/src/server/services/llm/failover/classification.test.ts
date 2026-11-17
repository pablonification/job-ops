import { describe, expect, it } from "vitest";
import { buildClaudeAgentSdkErrorMessage } from "../claude-agent-sdk/errors";
import {
  classifyLlmFailure,
  isFailoverEligible,
  type LlmFailureKind,
} from "./classification";

describe("classifyLlmFailure", () => {
  it.each<[string, number | undefined, LlmFailureKind]>([
    ["LLM API error: 401 - Invalid API key", undefined, "configuration"],
    ["LLM API error: 403 - Forbidden", undefined, "configuration"],
    ["LLM API error: 404 - model not found", undefined, "configuration"],
    ["LLM API error: 402 - Payment required", undefined, "usage_limit"],
    ["LLM API error: 408 - Request timeout", undefined, "timeout"],
    ["LLM API error: 429 - Too many requests", undefined, "rate_limit"],
    [
      "LLM API error: 429 - You exceeded your current quota",
      undefined,
      "usage_limit",
    ],
    ["LLM API error: 500 - Internal error", undefined, "upstream"],
    ["LLM API error: 503 - Service Unavailable", undefined, "upstream"],
    [
      "LLM API error: 400 - Invalid schema for response_format",
      undefined,
      "bad_request",
    ],
    [
      "LLM API error: 400 - maximum context length exceeded",
      undefined,
      "bad_request",
    ],
    [
      "LLM API error: 400 - The model `muse-x` does not exist",
      undefined,
      "configuration",
    ],
    ["LLM API error: 413 - Request too large", undefined, "bad_request"],
    ["LLM API error: 422 - Unprocessable", undefined, "bad_request"],
    ["Upstream said no", 502, "upstream"],
    ["Bad input", 400, "bad_request"],
    ["LLM API key not configured", undefined, "configuration"],
    ["All provider modes failed", undefined, "configuration"],
    ["fetch failed", undefined, "network"],
    ["connect ECONNREFUSED 127.0.0.1:443", undefined, "network"],
    ["The operation was aborted due to timeout", undefined, "timeout"],
    ["This operation was aborted", undefined, "aborted"],
    [
      "Failed to parse JSON response: Unexpected token",
      undefined,
      "unparseable",
    ],
    ["No content in response", undefined, "unparseable"],
  ])("HTTP provider: %s → %s", (message, status, expected) => {
    expect(
      classifyLlmFailure({ provider: "openai_compatible", message, status }),
    ).toBe(expected);
  });

  it.each<[string, LlmFailureKind]>([
    [
      "Codex is not authenticated in this container. Run `codex login` and try again.",
      "configuration",
    ],
    [
      "Codex CLI was not found in PATH. Install Codex inside the container and try again.",
      "configuration",
    ],
    ["Claude CLI timed out after 120000ms.", "timeout"],
    ["Codex app-server request timeout (turn/start).", "timeout"],
    ["Claude CLI invocation was aborted.", "aborted"],
    ["Codex request aborted (turn/start).", "aborted"],
    ["Claude CLI exited with code 1.", "subprocess"],
    [
      "Codex app-server exited unexpectedly (code=1 signal=null).",
      "subprocess",
    ],
    [
      "Gemini CLI JSON output did not include a string `response` field.",
      "unparseable",
    ],
    [
      "Failed to parse JSON response: Unexpected end of JSON input",
      "unparseable",
    ],
    ["You've hit your usage limit", "usage_limit"],
    ["429 Too Many Requests", "rate_limit"],
    [
      "Claude CLI image input must be a PNG, JPEG, or WebP base64 data URL.",
      "bad_request",
    ],
  ])("CLI provider: %s → %s", (message, expected) => {
    expect(classifyLlmFailure({ provider: "claude_cli", message })).toBe(
      expected,
    );
  });

  it.each<[string, LlmFailureKind]>([
    [
      buildClaudeAgentSdkErrorMessage(
        "auth",
        "CLAUDE_CODE_OAUTH_TOKEN is not set",
      ),
      "configuration",
    ],
    [
      buildClaudeAgentSdkErrorMessage("usage_limit", "resets 5pm"),
      "usage_limit",
    ],
    [buildClaudeAgentSdkErrorMessage("rate_limit"), "rate_limit"],
    [buildClaudeAgentSdkErrorMessage("upstream", "overloaded"), "upstream"],
    [buildClaudeAgentSdkErrorMessage("timeout", "after 1000ms"), "timeout"],
    [buildClaudeAgentSdkErrorMessage("aborted"), "aborted"],
    [
      buildClaudeAgentSdkErrorMessage(
        "other",
        "Claude Code process exited with code 1",
      ),
      "subprocess",
    ],
    [
      buildClaudeAgentSdkErrorMessage(
        "other",
        "The response did not include structured output",
      ),
      "unparseable",
    ],
    [
      buildClaudeAgentSdkErrorMessage("other", "Prompt is too long"),
      "bad_request",
    ],
    [
      buildClaudeAgentSdkErrorMessage(
        "other",
        "Image input must be a PNG, JPEG, or WebP base64 data URL",
      ),
      "bad_request",
    ],
    ["Failed to parse JSON response: Unexpected token", "unparseable"],
  ])("Claude (subscription): %s → %s", (message, expected) => {
    expect(classifyLlmFailure({ provider: "claude_agent_sdk", message })).toBe(
      expected,
    );
  });

  it("treats a fired caller signal as an abort whatever the message", () => {
    expect(
      classifyLlmFailure({
        provider: "openai",
        message: "LLM API error: 503 - down",
        aborted: true,
      }),
    ).toBe("aborted");
  });

  it("fails over only on provider-side kinds", () => {
    const eligible: LlmFailureKind[] = [
      "configuration",
      "usage_limit",
      "rate_limit",
      "timeout",
      "upstream",
      "network",
      "subprocess",
      "unparseable",
    ];
    for (const kind of eligible) expect(isFailoverEligible(kind)).toBe(true);
    expect(isFailoverEligible("aborted")).toBe(false);
    expect(isFailoverEligible("bad_request")).toBe(false);
  });
});
