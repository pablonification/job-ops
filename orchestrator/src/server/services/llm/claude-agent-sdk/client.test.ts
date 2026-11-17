import { existsSync, readdirSync } from "node:fs";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { isConfigurationFailure } from "@server/services/llm/policies/configuration-error";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonSchemaDefinition, LlmRequestOptions } from "../types";
import {
  buildClaudeAgentSdkEnv,
  ClaudeAgentSdkClient,
  type ClaudeAgentSdkQueryFn,
  clearClaudeAgentSdkValidationCache,
} from "./client";
import { ConcurrencyLimiter } from "./concurrency";
import { classifyClaudeAgentSdkError } from "./errors";

const TOKEN_ENV = {
  PATH: "/usr/bin",
  HOME: "/root",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test",
};

const SCHEMA: JsonSchemaDefinition = {
  name: "score",
  schema: {
    type: "object",
    properties: { score: { type: "number" } },
    required: ["score"],
    additionalProperties: false,
  },
};

type QueryCall = { prompt: unknown; options?: Options };

function successResult(
  structuredOutput: unknown,
  extra: Record<string, unknown> = {},
): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    structured_output: structuredOutput,
    ...extra,
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

function scriptedQuery(
  messages: SDKMessage[],
  options: { throwAfter?: Error } = {},
): { queryFn: ClaudeAgentSdkQueryFn; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const queryFn: ClaudeAgentSdkQueryFn = (args) => {
    calls.push(args);
    return (async function* () {
      for (const message of messages) yield message;
      if (options.throwAfter) throw options.throwAfter;
    })();
  };
  return { queryFn, calls };
}

/** A query that never yields until its abort controller fires. */
function hangingQuery(): {
  queryFn: ClaudeAgentSdkQueryFn;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  const queryFn: ClaudeAgentSdkQueryFn = (args) => {
    calls.push(args);
    const controller = args.options?.abortController;
    return (async function* () {
      await new Promise<void>((_, reject) => {
        controller?.signal.addEventListener("abort", () =>
          reject(new Error("Claude Code process aborted by user")),
        );
      });
      yield successResult({ score: 1 });
    })();
  };
  return { queryFn, calls };
}

function request(
  overrides: Partial<LlmRequestOptions<unknown>> = {},
): LlmRequestOptions<unknown> {
  return {
    model: "sonnet",
    messages: [
      { role: "system", content: "You score jobs." },
      { role: "user", content: "Score this job." },
    ],
    jsonSchema: SCHEMA,
    ...overrides,
  };
}

function newLimiter(limit = 2): ConcurrencyLimiter {
  return new ConcurrencyLimiter(() => limit);
}

describe("ClaudeAgentSdkClient.callJson", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    clearClaudeAgentSdkValidationCache();
  });

  it("sends a locked-down, structured-output query", async () => {
    const { queryFn, calls } = scriptedQuery([successResult({ score: 82 })]);
    const client = new ClaudeAgentSdkClient({
      queryFn,
      env: { ...TOKEN_ENV, ANTHROPIC_API_KEY: "sk-ant-api-should-not-leak" },
      limiter: newLimiter(),
    });

    const result = await client.callJson(request());

    expect(JSON.parse(result.text)).toEqual({ score: 82 });
    expect(calls).toHaveLength(1);
    const { prompt, options } = calls[0];
    expect(prompt).toBe("Score this job.");
    expect(options).toMatchObject({
      model: "sonnet",
      systemPrompt: "You score jobs.",
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      persistSession: false,
      outputFormat: { type: "json_schema", schema: SCHEMA.schema },
    });
    expect(options?.disallowedTools).toEqual(
      expect.arrayContaining(["Bash", "Read", "Write", "WebFetch"]),
    );
    expect(options?.maxTurns).toBeGreaterThan(0);
    expect(options?.abortController).toBeInstanceOf(AbortController);
    expect(options?.env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/root",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    });
    expect(options?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("runs in an empty temporary directory that is removed afterwards", async () => {
    let seenCwd: string | undefined;
    let entriesDuringCall: string[] = [];
    const queryFn: ClaudeAgentSdkQueryFn = (args) => {
      seenCwd = args.options?.cwd;
      entriesDuringCall = seenCwd ? readdirSync(seenCwd) : ["missing"];
      return (async function* () {
        yield successResult({ score: 1 });
      })();
    };
    const client = new ClaudeAgentSdkClient({
      queryFn,
      env: TOKEN_ENV,
      limiter: newLimiter(),
    });

    await client.callJson(request());

    expect(seenCwd).toBeTruthy();
    expect(seenCwd).not.toBe(process.cwd());
    expect(entriesDuringCall).toEqual([]);
    expect(existsSync(seenCwd as string)).toBe(false);
  });

  it("falls back to the default model and system prompt", async () => {
    const { queryFn, calls } = scriptedQuery([successResult({ score: 1 })]);
    const client = new ClaudeAgentSdkClient({
      queryFn,
      env: TOKEN_ENV,
      limiter: newLimiter(),
    });

    await client.callJson(
      request({ model: "", messages: [{ role: "user", content: "Hi" }] }),
    );

    expect(calls[0].options?.model).toBe("sonnet");
    expect(calls[0].options?.systemPrompt).toEqual(expect.any(String));
    expect(String(calls[0].options?.systemPrompt).length).toBeGreaterThan(0);
  });

  it("flattens multi-turn history into a transcript", async () => {
    const { queryFn, calls } = scriptedQuery([successResult({ score: 1 })]);
    const client = new ClaudeAgentSdkClient({
      queryFn,
      env: TOKEN_ENV,
      limiter: newLimiter(),
    });

    await client.callJson(
      request({
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: "First question" },
          { role: "assistant", content: "First answer" },
          { role: "user", content: "Follow-up" },
        ],
      }),
    );

    const prompt = calls[0].prompt as string;
    expect(typeof prompt).toBe("string");
    expect(prompt).toContain("Message 1 (USER):\nFirst question");
    expect(prompt).toContain("Message 2 (ASSISTANT):\nFirst answer");
    expect(prompt).toContain("Message 3 (USER):\nFollow-up");
    expect(prompt).not.toContain("Be brief.");
    expect(calls[0].options?.systemPrompt).toBe("Be brief.");
  });

  it("sends image parts through streaming input", async () => {
    const { queryFn, calls } = scriptedQuery([successResult({ score: 1 })]);
    const client = new ClaudeAgentSdkClient({
      queryFn,
      env: TOKEN_ENV,
      limiter: newLimiter(),
    });

    await client.callJson(
      request({
        messages: [
          { role: "system", content: "Look at the screenshot." },
          {
            role: "user",
            content: [
              { type: "text", text: "What does this show?" },
              {
                type: "image",
                imageUrl: "data:image/png;base64,AAAA",
                mediaType: "image/png",
              },
            ],
          },
        ],
      }),
    );

    const prompt = calls[0].prompt as AsyncIterable<unknown>;
    expect(typeof prompt).not.toBe("string");
    const yielded: unknown[] = [];
    for await (const message of prompt) yielded.push(message);
    expect(yielded).toEqual([
      expect.objectContaining({
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            { type: "text", text: "What does this show?" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AAAA" },
            },
          ],
        },
      }),
    ]);
  });

  it("rejects non-data-URL images before calling the SDK", async () => {
    const { queryFn, calls } = scriptedQuery([successResult({ score: 1 })]);
    const client = new ClaudeAgentSdkClient({
      queryFn,
      env: TOKEN_ENV,
      limiter: newLimiter(),
    });

    await expect(
      client.callJson(
        request({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  imageUrl: "https://example.com/a.png",
                  mediaType: "image/png",
                },
              ],
            },
          ],
        }),
      ),
    ).rejects.toThrow(/base64 data URL/);
    expect(calls).toHaveLength(0);
  });

  it("uses the result text when structured output is absent", async () => {
    const { queryFn } = scriptedQuery([
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: '{"score": 5}',
      } as unknown as SDKMessage,
    ]);
    const client = new ClaudeAgentSdkClient({
      queryFn,
      env: TOKEN_ENV,
      limiter: newLimiter(),
    });

    await expect(client.callJson(request())).resolves.toEqual({
      text: '{"score": 5}',
    });
  });

  it("fails without a token and without calling the SDK", async () => {
    const { queryFn, calls } = scriptedQuery([successResult({ score: 1 })]);
    const client = new ClaudeAgentSdkClient({
      queryFn,
      env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-api" },
      limiter: newLimiter(),
    });

    const error = await client.callJson(request()).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("not authenticated");
    expect(isConfigurationFailure((error as Error).message)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("maps an authentication failure to a not-authenticated error", async () => {
    const { queryFn } = scriptedQuery(
      [
        {
          type: "assistant",
          error: "authentication_failed",
          message: { role: "assistant", content: [] },
        } as unknown as SDKMessage,
        errorResult("success", {
          result: "Invalid bearer token · Please run /login",
        }),
      ],
      { throwAfter: new Error("Claude Code process exited with code 1") },
    );
    const client = new ClaudeAgentSdkClient({
      queryFn,
      env: TOKEN_ENV,
      limiter: newLimiter(),
    });

    const error = (await client
      .callJson(request())
      .catch((e: Error) => e)) as Error;

    expect(error.message).toContain("not authenticated");
    expect(isConfigurationFailure(error.message)).toBe(true);
    expect(classifyClaudeAgentSdkError(error.message)).toBe("auth");
  });

  it("maps a subscription usage limit to a distinct error", async () => {
    const { queryFn } = scriptedQuery([
      errorResult("success", {
        result: "You've hit your session limit · resets 3pm",
      }),
    ]);
    const client = new ClaudeAgentSdkClient({
      queryFn,
      env: TOKEN_ENV,
      limiter: newLimiter(),
    });

    const error = (await client
      .callJson(request())
      .catch((e: Error) => e)) as Error;

    expect(error.message).toContain("usage limit reached");
    expect(classifyClaudeAgentSdkError(error.message)).toBe("usage_limit");
    expect(isConfigurationFailure(error.message)).toBe(false);
  });

  it("maps a rate limit to a distinct error", async () => {
    const { queryFn } = scriptedQuery([
      {
        type: "assistant",
        error: "rate_limit",
        message: { role: "assistant", content: [] },
      } as unknown as SDKMessage,
      errorResult("error_during_execution", { errors: ["API Error: 429"] }),
    ]);
    const client = new ClaudeAgentSdkClient({
      queryFn,
      env: TOKEN_ENV,
      limiter: newLimiter(),
    });

    const error = (await client
      .callJson(request())
      .catch((e: Error) => e)) as Error;

    expect(error.message).toContain("rate limit reached");
    expect(classifyClaudeAgentSdkError(error.message)).toBe("rate_limit");
  });

  it("reports structured-output retry exhaustion", async () => {
    const { queryFn } = scriptedQuery([
      errorResult("error_max_structured_output_retries", {
        errors: ["Output did not match schema"],
      }),
    ]);
    const client = new ClaudeAgentSdkClient({
      queryFn,
      env: TOKEN_ENV,
      limiter: newLimiter(),
    });

    await expect(client.callJson(request())).rejects.toThrow(
      /Claude \(subscription\) request failed: Output did not match schema/,
    );
  });

  it("times out using the configured timeout", async () => {
    const { queryFn, calls } = hangingQuery();
    const client = new ClaudeAgentSdkClient({
      queryFn,
      env: { ...TOKEN_ENV, CLAUDE_AGENT_SDK_REQUEST_TIMEOUT_MS: "20" },
      limiter: newLimiter(),
    });

    const error = (await client
      .callJson(request())
      .catch((e: Error) => e)) as Error;

    expect(error.message).toBe("Claude (subscription) timed out after 20ms.");
    expect(classifyClaudeAgentSdkError(error.message)).toBe("timeout");
    expect(calls[0].options?.abortController?.signal.aborted).toBe(true);
  });

  it("honours the caller's abort signal", async () => {
    const { queryFn, calls } = hangingQuery();
    const client = new ClaudeAgentSdkClient({
      queryFn,
      env: TOKEN_ENV,
      limiter: newLimiter(),
    });
    const controller = new AbortController();

    const pending = client.callJson(request({ signal: controller.signal }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    controller.abort();

    const error = (await pending.catch((e: Error) => e)) as Error;
    expect(error.message).toBe("Claude (subscription) request was aborted.");
    expect(classifyClaudeAgentSdkError(error.message)).toBe("aborted");
    expect(calls[0].options?.abortController?.signal.aborted).toBe(true);
  });

  it("does not start when the signal is already aborted", async () => {
    const { queryFn, calls } = scriptedQuery([successResult({ score: 1 })]);
    const client = new ClaudeAgentSdkClient({
      queryFn,
      env: TOKEN_ENV,
      limiter: newLimiter(),
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.callJson(request({ signal: controller.signal })),
    ).rejects.toThrow(/aborted/);
    expect(calls).toHaveLength(0);
  });

  it("limits concurrent SDK calls", async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const queryFn: ClaudeAgentSdkQueryFn = () =>
      (async function* () {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        yield successResult({ score: 1 });
      })();
    const limiter = newLimiter(2);
    const client = new ClaudeAgentSdkClient({
      queryFn,
      env: TOKEN_ENV,
      limiter,
    });

    const calls = Array.from({ length: 5 }, () => client.callJson(request()));
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(limiter.pendingCount).toBe(3);

    for (let released = 0; released < 5; released++) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
      releases.shift()?.();
    }
    await Promise.all(calls);

    expect(maxActive).toBe(2);
    expect(limiter.activeCount).toBe(0);
  });

  it("reads the default concurrency limit from the environment", async () => {
    vi.stubEnv("CLAUDE_AGENT_SDK_MAX_CONCURRENCY", "1");
    let active = 0;
    let maxActive = 0;
    const queryFn: ClaudeAgentSdkQueryFn = () =>
      (async function* () {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        yield successResult({ score: 1 });
      })();
    const client = new ClaudeAgentSdkClient({ queryFn, env: TOKEN_ENV });

    await Promise.all([
      client.callJson(request()),
      client.callJson(request()),
      client.callJson(request()),
    ]);

    expect(maxActive).toBe(1);
  });
});

describe("ClaudeAgentSdkClient.validateCredentials", () => {
  afterEach(() => {
    clearClaudeAgentSdkValidationCache();
  });

  it("reports a missing token without a model request", async () => {
    const { queryFn, calls } = scriptedQuery([successResult({ ok: true })]);
    const client = new ClaudeAgentSdkClient({
      queryFn,
      env: { PATH: "/usr/bin" },
      limiter: newLimiter(),
    });

    const result = await client.validateCredentials();

    expect(result.valid).toBe(false);
    expect(result.message).toContain("not authenticated");
    expect(result.message).toContain("claude setup-token");
    expect(calls).toHaveLength(0);
  });

  it("caches a successful check so repeat status checks are free", async () => {
    const { queryFn, calls } = scriptedQuery([successResult({ ok: true })]);
    const client = new ClaudeAgentSdkClient({
      queryFn,
      env: TOKEN_ENV,
      limiter: newLimiter(),
    });

    const [first, second] = await Promise.all([
      client.validateCredentials(),
      client.validateCredentials(),
    ]);
    const third = await new ClaudeAgentSdkClient({
      queryFn,
      env: TOKEN_ENV,
      limiter: newLimiter(),
    }).validateCredentials();

    expect(first).toEqual({ valid: true, message: null, username: null });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(calls).toHaveLength(1);
    expect(calls[0].options?.model).toBe("haiku");
  });

  it("re-validates when the token changes", async () => {
    const { queryFn, calls } = scriptedQuery([successResult({ ok: true })]);
    await new ClaudeAgentSdkClient({
      queryFn,
      env: TOKEN_ENV,
      limiter: newLimiter(),
    }).validateCredentials();
    await new ClaudeAgentSdkClient({
      queryFn,
      env: { ...TOKEN_ENV, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-other" },
      limiter: newLimiter(),
    }).validateCredentials();

    expect(calls).toHaveLength(2);
  });

  it("reports a rejected token as not authenticated", async () => {
    const { queryFn } = scriptedQuery([
      errorResult("success", { result: "OAuth token has expired" }),
    ]);
    const client = new ClaudeAgentSdkClient({
      queryFn,
      env: TOKEN_ENV,
      limiter: newLimiter(),
    });

    const result = await client.validateCredentials();

    expect(result.valid).toBe(false);
    expect(result.message).toContain("not authenticated");
  });

  it("treats an exhausted plan as a working token", async () => {
    const { queryFn } = scriptedQuery([
      errorResult("success", { result: "You've hit your weekly limit" }),
    ]);
    const client = new ClaudeAgentSdkClient({
      queryFn,
      env: TOKEN_ENV,
      limiter: newLimiter(),
    });

    const result = await client.validateCredentials();

    expect(result.valid).toBe(true);
    expect(result.message).toContain("usage limit reached");
  });
});

describe("ClaudeAgentSdkClient.listModels", () => {
  it("suggests the model aliases, sonnet first", async () => {
    await expect(new ClaudeAgentSdkClient().listModels()).resolves.toEqual([
      "sonnet",
      "opus",
      "haiku",
    ]);
  });
});

describe("buildClaudeAgentSdkEnv", () => {
  it("passes only allowlisted variables and never API-key credentials", () => {
    const env = buildClaudeAgentSdkEnv({
      PATH: "/usr/bin",
      HOME: "/root",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat",
      ANTHROPIC_API_KEY: "sk-ant-api",
      ANTHROPIC_AUTH_TOKEN: "bearer",
      CLAUDE_CODE_USE_BEDROCK: "1",
      LLM_API_KEY: "sk-other",
      JWT_SECRET: "secret",
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/root",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    });
  });
});
