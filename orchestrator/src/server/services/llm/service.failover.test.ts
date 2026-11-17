import { logger } from "@infra/logger";
import { runWithRequestContext } from "@infra/request-context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAgentSdkClient } from "./claude-agent-sdk/client";
import { ClaudeAgentSdkError } from "./claude-agent-sdk/errors";
import { ClaudeCliClient } from "./claude-cli/client";
import { LlmCircuitBreaker } from "./failover/breaker";
import type { LlmFallbackConfig } from "./failover/config";
import { LlmService } from "./service";
import type { JsonSchemaDefinition, LlmRequestOptions } from "./types";

const TEST_SCHEMA: JsonSchemaDefinition = {
  name: "test",
  schema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
};

const FALLBACK_URL = "https://fallback.example/v1";

function completionResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function readyFallback(
  overrides: Partial<Extract<LlmFallbackConfig, { state: "ready" }>> = {},
): LlmFallbackConfig {
  return {
    state: "ready",
    target: {
      provider: "openai_compatible",
      model: "muse-spark-1.2",
      baseUrl: FALLBACK_URL,
      apiKey: "fallback-secret-key",
    },
    forced: false,
    breaker: { threshold: 3, cooldownMs: 60_000 },
    ...overrides,
  };
}

function request(
  overrides: Partial<LlmRequestOptions<{ value: string }>> = {},
): LlmRequestOptions<{ value: string }> {
  return {
    model: "opus",
    messages: [{ role: "user", content: "Score this job" }],
    jsonSchema: TEST_SCHEMA,
    jobId: "job-1",
    ...overrides,
  };
}

type FetchCall = { url: string; init: RequestInit };

function mockFetch(handler: (url: string) => Response) {
  const calls: FetchCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url);
  });
  return calls;
}

function fallbackCalls(calls: FetchCall[]) {
  return calls.filter((call) => call.url.startsWith(FALLBACK_URL));
}

function claudeSdkPrimary(
  config: LlmFallbackConfig,
  breaker: LlmCircuitBreaker,
) {
  return new LlmService({
    provider: "claude_agent_sdk",
    failover: { config, breaker },
  });
}

describe("LlmService failover", () => {
  let breaker: LlmCircuitBreaker;
  let now: number;

  beforeEach(() => {
    now = 1_000_000;
    breaker = new LlmCircuitBreaker(() => now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_FALLBACK_PROVIDER;
    delete process.env.LLM_FALLBACK_MODEL;
    delete process.env.LLM_FALLBACK_BASE_URL;
    delete process.env.LLM_FALLBACK_API_KEY;
    delete process.env.JOBOPS_APP_MODE;
    delete process.env.JOBOPS_HOSTED_TENANT_ID;
  });

  describe("triggers", () => {
    it.each([
      [
        "authentication failure",
        new ClaudeAgentSdkError("auth", "CLAUDE_CODE_OAUTH_TOKEN is not set"),
      ],
      ["usage limit", new ClaudeAgentSdkError("usage_limit", "resets 5pm")],
      ["rate limit", new ClaudeAgentSdkError("rate_limit", "429")],
      ["timeout", new ClaudeAgentSdkError("timeout", "after 180000ms")],
      ["upstream error", new ClaudeAgentSdkError("upstream", "overloaded")],
      [
        "subprocess failure",
        new ClaudeAgentSdkError(
          "other",
          "Claude Code process exited with code 1",
        ),
      ],
    ])("fails over on a Claude (subscription) %s", async (_label, error) => {
      vi.spyOn(ClaudeAgentSdkClient.prototype, "callJson").mockRejectedValue(
        error,
      );
      const calls = mockFetch(() => completionResponse('{"value":"muse"}'));

      const result = await claudeSdkPrimary(readyFallback(), breaker).callJson(
        request(),
      );

      expect(result).toEqual({ success: true, data: { value: "muse" } });
      expect(fallbackCalls(calls)).toHaveLength(1);
    });

    it("fails over after retries on unparseable output are exhausted", async () => {
      const primary = vi
        .spyOn(ClaudeAgentSdkClient.prototype, "callJson")
        .mockResolvedValue({ text: "not json at all" });
      const calls = mockFetch(() => completionResponse('{"value":"muse"}'));

      const result = await claudeSdkPrimary(readyFallback(), breaker).callJson(
        request({ maxRetries: 1, retryDelayMs: 1 }),
      );

      expect(primary).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ success: true, data: { value: "muse" } });
      expect(fallbackCalls(calls)).toHaveLength(1);
    });

    it("fails over on an HTTP primary's 5xx", async () => {
      const calls = mockFetch((url) =>
        url.startsWith(FALLBACK_URL)
          ? completionResponse('{"value":"muse"}')
          : errorResponse(503, "Service Unavailable"),
      );
      const llm = new LlmService({
        provider: "openai",
        apiKey: "primary-secret-key",
        failover: { config: readyFallback(), breaker },
      });

      const result = await llm.callJson(request({ model: "gpt-5.4-mini" }));

      expect(result).toEqual({ success: true, data: { value: "muse" } });
      expect(calls[0].url).toContain("api.openai.com");
      expect(fallbackCalls(calls)).toHaveLength(1);
    });

    it("fails over on an HTTP primary's rejected key", async () => {
      const calls = mockFetch((url) =>
        url.startsWith(FALLBACK_URL)
          ? completionResponse('{"value":"muse"}')
          : errorResponse(401, "Invalid API key"),
      );
      const llm = new LlmService({
        provider: "openai",
        apiKey: "primary-secret-key",
        failover: { config: readyFallback(), breaker },
      });

      const result = await llm.callJson(request({ model: "gpt-5.4-mini" }));

      expect(result.success).toBe(true);
      expect(fallbackCalls(calls)).toHaveLength(1);
    });

    it("fails over when a CLI provider's process fails", async () => {
      vi.spyOn(ClaudeCliClient.prototype, "callJson").mockRejectedValue(
        new Error("Claude CLI exited with code 1."),
      );
      const calls = mockFetch(() => completionResponse('{"value":"muse"}'));
      const llm = new LlmService({
        provider: "claude_cli",
        failover: { config: readyFallback(), breaker },
      });

      const result = await llm.callJson(request());

      expect(result.success).toBe(true);
      expect(fallbackCalls(calls)).toHaveLength(1);
    });
  });

  describe("non-triggers", () => {
    it("never fails over when the caller aborts", async () => {
      const controller = new AbortController();
      vi.spyOn(ClaudeAgentSdkClient.prototype, "callJson").mockImplementation(
        async () => {
          controller.abort();
          throw new ClaudeAgentSdkError("aborted");
        },
      );
      const calls = mockFetch(() => completionResponse('{"value":"muse"}'));

      const result = await claudeSdkPrimary(readyFallback(), breaker).callJson(
        request({ signal: controller.signal }),
      );

      expect(result.success).toBe(false);
      expect(calls).toHaveLength(0);
    });

    it("does not fail over when the request itself is rejected (400)", async () => {
      const calls = mockFetch((url) =>
        url.startsWith(FALLBACK_URL)
          ? completionResponse('{"value":"muse"}')
          : errorResponse(400, "maximum context length exceeded"),
      );
      const llm = new LlmService({
        provider: "openai",
        apiKey: "primary-secret-key",
        failover: { config: readyFallback(), breaker },
      });

      const result = await llm.callJson(request({ model: "gpt-5.4-mini" }));

      expect(result.success).toBe(false);
      expect(fallbackCalls(calls)).toHaveLength(0);
    });

    it("does not fail over a Claude (subscription) prompt that is too long", async () => {
      vi.spyOn(ClaudeAgentSdkClient.prototype, "callJson").mockRejectedValue(
        new ClaudeAgentSdkError("other", "Prompt is too long"),
      );
      const calls = mockFetch(() => completionResponse('{"value":"muse"}'));

      const result = await claudeSdkPrimary(readyFallback(), breaker).callJson(
        request(),
      );

      expect(result.success).toBe(false);
      expect(calls).toHaveLength(0);
    });
  });

  describe("fallback configuration", () => {
    it("sends the fallback's own model, base URL and key, never the primary's", async () => {
      process.env.LLM_API_KEY = "primary-env-secret";
      vi.spyOn(ClaudeAgentSdkClient.prototype, "callJson").mockRejectedValue(
        new ClaudeAgentSdkError("usage_limit"),
      );
      const calls = mockFetch(() => completionResponse('{"value":"muse"}'));

      // "claude-opus-override" stands in for a per-purpose model override the
      // caller resolved for the primary.
      await claudeSdkPrimary(readyFallback(), breaker).callJson(
        request({ model: "claude-opus-override" }),
      );

      const [call] = fallbackCalls(calls);
      expect(call.url).toBe(`${FALLBACK_URL}/chat/completions`);
      const body = JSON.parse(String(call.init.body));
      expect(body.model).toBe("muse-spark-1.2");
      expect(JSON.stringify(body)).not.toContain("claude-opus-override");
      const headers = call.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer fallback-secret-key");
      expect(JSON.stringify(headers)).not.toContain("primary-env-secret");
    });

    it("behaves exactly as today with no fallback configured", async () => {
      vi.spyOn(ClaudeAgentSdkClient.prototype, "callJson").mockRejectedValue(
        new ClaudeAgentSdkError("usage_limit", "resets 5pm"),
      );
      const calls = mockFetch(() => completionResponse('{"value":"muse"}'));
      const llm = new LlmService({
        provider: "claude_agent_sdk",
        failover: { config: { state: "absent", forced: false }, breaker },
      });

      const result = await llm.callJson(request());

      expect(result).toEqual({
        success: false,
        error: "Claude (subscription) usage limit reached: resets 5pm",
      });
      expect(calls).toHaveLength(0);
    });

    it("ignores a fallback that is the same endpoint as the primary", async () => {
      const primary = vi
        .spyOn(ClaudeAgentSdkClient.prototype, "callJson")
        .mockRejectedValue(new ClaudeAgentSdkError("usage_limit"));

      const result = await claudeSdkPrimary(
        readyFallback({
          target: {
            provider: "claude_agent_sdk",
            model: "haiku",
            baseUrl: null,
            apiKey: null,
          },
        }),
        breaker,
      ).callJson(request());

      expect(result.success).toBe(false);
      expect(primary).toHaveBeenCalledTimes(1);
    });

    it("tries the fallback once and returns its failure with both reasons logged", async () => {
      vi.spyOn(ClaudeAgentSdkClient.prototype, "callJson").mockRejectedValue(
        new ClaudeAgentSdkError("usage_limit", "resets 5pm"),
      );
      const warn = vi.spyOn(logger, "warn");
      const calls = mockFetch(() => errorResponse(503, "fallback down"));

      const result = await claudeSdkPrimary(readyFallback(), breaker).callJson(
        request(),
      );

      expect(fallbackCalls(calls)).toHaveLength(1);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe(
          "Fallback LLM (openai_compatible) failed: LLM API error: 503 - fallback down",
        );
      }
      const failoverLogs = warn.mock.calls.filter(([message]) =>
        String(message).includes("fallback provider failed"),
      );
      expect(failoverLogs).toHaveLength(1);
      const meta = failoverLogs[0][1] as Record<string, unknown>;
      expect(meta).toMatchObject({
        reason: "usage_limit",
        primaryProvider: "claude_agent_sdk",
        fallbackProvider: "openai_compatible",
        jobId: "job-1",
      });
      expect(String(meta.primaryError)).toContain("usage limit reached");
      expect(String(meta.fallbackError)).toContain("503");
      expect(JSON.stringify(meta)).not.toContain("fallback-secret-key");
      expect(JSON.stringify(meta)).not.toContain("Score this job");
    });

    it("logs a successful failover once with reason and providers", async () => {
      vi.spyOn(ClaudeAgentSdkClient.prototype, "callJson").mockRejectedValue(
        new ClaudeAgentSdkError("rate_limit"),
      );
      const warn = vi.spyOn(logger, "warn");
      mockFetch(() => completionResponse('{"value":"muse"}'));

      await claudeSdkPrimary(readyFallback(), breaker).callJson(request());

      const failoverLogs = warn.mock.calls.filter(([message]) =>
        String(message).includes("failed over"),
      );
      expect(failoverLogs).toHaveLength(1);
      expect(failoverLogs[0][1]).toMatchObject({
        reason: "rate_limit",
        primaryProvider: "claude_agent_sdk",
        fallbackProvider: "openai_compatible",
        fallbackModel: "muse-spark-1.2",
      });
    });

    it("sends every call to the fallback when forced", async () => {
      const primary = vi.spyOn(ClaudeAgentSdkClient.prototype, "callJson");
      const calls = mockFetch(() => completionResponse('{"value":"muse"}'));

      const result = await claudeSdkPrimary(
        readyFallback({ forced: true }),
        breaker,
      ).callJson(request());

      expect(result).toEqual({ success: true, data: { value: "muse" } });
      expect(primary).not.toHaveBeenCalled();
      expect(fallbackCalls(calls)).toHaveLength(1);
    });

    it("ignores the fallback in hosted mode", async () => {
      process.env.JOBOPS_APP_MODE = "hosted";
      process.env.JOBOPS_HOSTED_TENANT_ID = "tenant-hosted";
      process.env.LLM_FALLBACK_PROVIDER = "openai_compatible";
      process.env.LLM_FALLBACK_MODEL = "muse-spark-1.2";
      process.env.LLM_FALLBACK_BASE_URL = FALLBACK_URL;
      process.env.LLM_FALLBACK_API_KEY = "fallback-secret-key";
      const calls = mockFetch(() => errorResponse(503, "primary down"));
      const llm = new LlmService({
        provider: "openrouter",
        apiKey: "tenant-key",
        allowEnvironmentCredentials: false,
        failover: { breaker },
      });

      const result = await llm.callJson(request({ model: "some/model" }));

      expect(result.success).toBe(false);
      expect(fallbackCalls(calls)).toHaveLength(0);
    });

    it("reads the fallback from the environment in local mode", async () => {
      process.env.LLM_FALLBACK_PROVIDER = "openai-compatible";
      process.env.LLM_FALLBACK_MODEL = "muse-spark-1.2";
      process.env.LLM_FALLBACK_BASE_URL = FALLBACK_URL;
      process.env.LLM_FALLBACK_API_KEY = "fallback-secret-key";
      vi.spyOn(ClaudeAgentSdkClient.prototype, "callJson").mockRejectedValue(
        new ClaudeAgentSdkError("auth"),
      );
      const calls = mockFetch(() => completionResponse('{"value":"muse"}'));
      const llm = new LlmService({
        provider: "claude_agent_sdk",
        failover: { breaker },
      });

      const result = await llm.callJson(request());

      expect(result.success).toBe(true);
      expect(fallbackCalls(calls)).toHaveLength(1);
    });
  });

  describe("circuit breaker", () => {
    it("skips the primary after repeated failures, then retries it after the cool-down", async () => {
      const primary = vi
        .spyOn(ClaudeAgentSdkClient.prototype, "callJson")
        .mockRejectedValue(new ClaudeAgentSdkError("usage_limit"));
      const calls = mockFetch(() => completionResponse('{"value":"muse"}'));
      const config = readyFallback({
        breaker: { threshold: 2, cooldownMs: 1_000 },
      });
      const llm = claudeSdkPrimary(config, breaker);

      await llm.callJson(request());
      await llm.callJson(request());
      expect(primary).toHaveBeenCalledTimes(2);

      // Open: the primary is not tried.
      now += 500;
      const skipped = await llm.callJson(request());
      expect(skipped.success).toBe(true);
      expect(primary).toHaveBeenCalledTimes(2);

      // Cool-down over: one probe reaches the primary and it has recovered.
      now += 600;
      primary.mockResolvedValue({ text: '{"value":"claude"}' });
      const probe = await llm.callJson(request());
      expect(probe).toEqual({ success: true, data: { value: "claude" } });
      expect(primary).toHaveBeenCalledTimes(3);

      // Closed again.
      await llm.callJson(request());
      expect(primary).toHaveBeenCalledTimes(4);
      expect(fallbackCalls(calls)).toHaveLength(3);
    });

    it("re-opens for another cool-down when the probe fails", async () => {
      const primary = vi
        .spyOn(ClaudeAgentSdkClient.prototype, "callJson")
        .mockRejectedValue(new ClaudeAgentSdkError("upstream", "overloaded"));
      mockFetch(() => completionResponse('{"value":"muse"}'));
      const llm = claudeSdkPrimary(
        readyFallback({ breaker: { threshold: 1, cooldownMs: 1_000 } }),
        breaker,
      );

      await llm.callJson(request());
      now += 1_001;
      await llm.callJson(request()); // probe fails
      expect(primary).toHaveBeenCalledTimes(2);
      now += 500;
      await llm.callJson(request());
      expect(primary).toHaveBeenCalledTimes(2);
    });

    it("keeps breaker state per tenant", async () => {
      const primary = vi
        .spyOn(ClaudeAgentSdkClient.prototype, "callJson")
        .mockRejectedValue(new ClaudeAgentSdkError("auth"));
      mockFetch(() => completionResponse('{"value":"muse"}'));
      const llm = claudeSdkPrimary(
        readyFallback({ breaker: { threshold: 1, cooldownMs: 60_000 } }),
        breaker,
      );

      await runWithRequestContext({ tenantId: "tenant-a" }, () =>
        llm.callJson(request()),
      );
      await runWithRequestContext({ tenantId: "tenant-a" }, () =>
        llm.callJson(request()),
      );
      expect(primary).toHaveBeenCalledTimes(1);

      await runWithRequestContext({ tenantId: "tenant-b" }, () =>
        llm.callJson(request()),
      );
      expect(primary).toHaveBeenCalledTimes(2);
    });
  });
});
