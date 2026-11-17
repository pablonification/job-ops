/**
 * Failover decisions driven from real Claude Agent SDK message shapes: the
 * Claude (subscription) client runs for real with a scripted `queryFn`, so
 * the path from SDK result/error to failover decision is exercised end to
 * end. Only the fallback's HTTP endpoint is mocked.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeAgentSdkClient,
  type ClaudeAgentSdkQueryFn,
} from "./claude-agent-sdk/client";
import { ConcurrencyLimiter } from "./claude-agent-sdk/concurrency";
import { LlmCircuitBreaker } from "./failover/breaker";
import type { LlmFallbackConfig } from "./failover/config";
import { LlmService } from "./service";
import type { JsonSchemaDefinition } from "./types";

const FALLBACK_URL = "https://fallback.example/v1";

const SCHEMA: JsonSchemaDefinition = {
  name: "score",
  schema: {
    type: "object",
    properties: { score: { type: "number" } },
    required: ["score"],
    additionalProperties: false,
  },
};

const FALLBACK: LlmFallbackConfig = {
  state: "ready",
  forced: false,
  target: {
    provider: "openai_compatible",
    model: "muse-spark-1.2",
    baseUrl: FALLBACK_URL,
    apiKey: "fallback-secret-key",
  },
  breaker: { threshold: 3, cooldownMs: 60_000 },
};

function assistantError(error: string): SDKMessage {
  return {
    type: "assistant",
    error,
    message: { role: "assistant", content: [] },
  } as unknown as SDKMessage;
}

function errorResult(
  subtype: string,
  fields: Record<string, unknown>,
): SDKMessage {
  return {
    type: "result",
    subtype,
    is_error: true,
    ...fields,
  } as unknown as SDKMessage;
}

function scripted(
  messages: SDKMessage[],
  throwAfter?: Error,
): ClaudeAgentSdkQueryFn {
  return () =>
    (async function* () {
      for (const message of messages) yield message;
      if (throwAfter) throw throwAfter;
    })();
}

function hanging(): ClaudeAgentSdkQueryFn {
  return (args) => {
    const controller = args.options?.abortController;
    return (async function* () {
      await new Promise<void>((_, reject) => {
        controller?.signal.addEventListener("abort", () =>
          reject(new Error("Claude Code process aborted by user")),
        );
      });
      yield errorResult("success", {});
    })();
  };
}

function serviceWith(
  queryFn: ClaudeAgentSdkQueryFn,
  env: Record<string, string> = {},
) {
  return new LlmService({
    provider: "claude_agent_sdk",
    claudeAgentSdkClient: new ClaudeAgentSdkClient({
      queryFn,
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test", ...env },
      limiter: new ConcurrencyLimiter(() => 2),
    }),
    failover: { config: FALLBACK, breaker: new LlmCircuitBreaker() },
  });
}

describe("failover decisions from Claude Agent SDK messages", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"score": 61}' } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const call = (llm: LlmService) =>
    llm.callJson<{ score: number }>({
      model: "sonnet",
      messages: [{ role: "user", content: "Score this job." }],
      jsonSchema: SCHEMA,
    });

  it.each<[string, () => ClaudeAgentSdkQueryFn, Record<string, string>?]>([
    [
      "usage limit",
      () =>
        scripted([
          errorResult("success", {
            result: "You've hit your session limit · resets 3pm",
          }),
        ]),
    ],
    [
      "rate limit",
      () =>
        scripted([
          assistantError("rate_limit"),
          errorResult("error_during_execution", {
            errors: ["API Error: 429"],
            api_error_status: 429,
          }),
        ]),
    ],
    [
      "authentication failure",
      () =>
        scripted(
          [
            assistantError("authentication_failed"),
            errorResult("success", {
              result: "Invalid bearer token · Please run /login",
            }),
          ],
          new Error("Claude Code process exited with code 1"),
        ),
    ],
    [
      "server error",
      () =>
        scripted([
          assistantError("server_error"),
          errorResult("error_during_execution", {
            errors: ["API Error: 529 Overloaded"],
            api_error_status: 529,
          }),
        ]),
    ],
    [
      "process crash",
      () => scripted([], new Error("Claude Code process exited with code 1")),
    ],
    ["timeout", hanging, { CLAUDE_AGENT_SDK_REQUEST_TIMEOUT_MS: "20" }],
  ])("fails over on a %s", async (_label, queryFn, env) => {
    const result = await call(serviceWith(queryFn(), env));

    expect(result).toEqual({ success: true, data: { score: 61 } });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(String(fetchSpy.mock.calls[0][0])).toContain("fallback.example");
  });

  it.each<[string, () => ClaudeAgentSdkQueryFn]>([
    [
      "invalid request (API error 400)",
      () =>
        scripted([
          assistantError("invalid_request"),
          errorResult("error_during_execution", {
            errors: ["messages: text content blocks must be non-empty"],
            api_error_status: 400,
          }),
        ]),
    ],
    [
      "request too large (API error 413)",
      () =>
        scripted([
          errorResult("error_during_execution", {
            errors: ["Request too large"],
            api_error_status: 413,
          }),
        ]),
    ],
    [
      "prompt that is too long",
      () =>
        scripted([errorResult("success", { result: "Prompt is too long" })]),
    ],
  ])("does not fail over on an %s", async (_label, queryFn) => {
    const result = await call(serviceWith(queryFn()));

    expect(result.success).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not open the breaker on repeated invalid requests", async () => {
    const queryFn = scripted([
      assistantError("invalid_request"),
      errorResult("error_during_execution", {
        errors: ["bad"],
        api_error_status: 400,
      }),
    ]);
    const queries = vi.fn(queryFn);
    const llm = new LlmService({
      provider: "claude_agent_sdk",
      claudeAgentSdkClient: new ClaudeAgentSdkClient({
        queryFn: queries,
        env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test" },
        limiter: new ConcurrencyLimiter(() => 2),
      }),
      failover: {
        config: { ...FALLBACK, breaker: { threshold: 1, cooldownMs: 60_000 } },
        breaker: new LlmCircuitBreaker(),
      },
    });

    await call(llm);
    await call(llm);

    expect(queries).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
