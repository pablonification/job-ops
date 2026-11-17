/**
 * Pipeline pause behaviour with and without a fallback provider. A scoring
 * call that throws `LlmNotConfiguredError` pauses the pipeline; anything else
 * lets the run continue.
 */

import { createJob } from "@shared/testing/factories";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAgentSdkClient } from "./llm/claude-agent-sdk/client";
import { ClaudeAgentSdkError } from "./llm/claude-agent-sdk/errors";
import { LlmCircuitBreaker } from "./llm/failover/breaker";
import type { LlmFallbackConfig } from "./llm/failover/config";
import { PRIMARY_CONFIGURATION_FAILURE_MARKER } from "./llm/policies/configuration-error";
import { LlmService } from "./llm/service";

const {
  getEffectiveSettingsMock,
  getSettingMock,
  resolveLlmModelMock,
  createConfiguredLlmServiceMock,
} = vi.hoisted(() => ({
  getEffectiveSettingsMock: vi.fn(),
  getSettingMock: vi.fn(),
  resolveLlmModelMock: vi.fn(),
  createConfiguredLlmServiceMock: vi.fn(),
}));

vi.mock("./settings", () => ({
  getEffectiveSettings: getEffectiveSettingsMock,
}));

vi.mock("../repositories/settings", () => ({
  getSetting: getSettingMock,
}));

vi.mock("./modelSelection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./modelSelection")>();
  return {
    ...actual,
    resolveLlmModel: resolveLlmModelMock,
    createConfiguredLlmService: createConfiguredLlmServiceMock,
  };
});

import {
  LlmNotConfiguredError,
  ScoringUnavailableError,
  scoreJobSuitability,
} from "./scorer";

const FALLBACK: LlmFallbackConfig = {
  state: "ready",
  forced: false,
  target: {
    provider: "openai_compatible",
    model: "muse-spark-1.2",
    baseUrl: "https://fallback.example/v1",
    apiKey: "fallback-secret-key",
  },
  breaker: { threshold: 3, cooldownMs: 60_000 },
};

function useClaudeSubscription(config: LlmFallbackConfig) {
  createConfiguredLlmServiceMock.mockImplementation(
    async () =>
      new LlmService({
        provider: "claude_agent_sdk",
        failover: { config, breaker: new LlmCircuitBreaker() },
      }),
  );
}

function fallbackAnswers(response: () => Response) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => response());
}

describe("scoring when Claude (subscription) is not authenticated", () => {
  beforeEach(() => {
    getSettingMock.mockResolvedValue(null);
    getEffectiveSettingsMock.mockResolvedValue({
      penalizeMissingSalary: { value: false, default: false, override: null },
      missingSalaryPenalty: { value: 10, default: 10, override: null },
      scoringInstructions: { value: "", default: "", override: null },
      scoringPromptTemplate: { value: "", default: "", override: null },
      rxresumeBaseResumeId: "base-resume-123",
    });
    resolveLlmModelMock.mockResolvedValue("sonnet");
    vi.spyOn(ClaudeAgentSdkClient.prototype, "callJson").mockRejectedValue(
      new ClaudeAgentSdkError("auth", "CLAUDE_CODE_OAUTH_TOKEN is not set"),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("pauses the pipeline when no fallback is configured (as today)", async () => {
    useClaudeSubscription({ state: "absent", forced: false });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      scoreJobSuitability(createJob({ id: "job-a" }), {}),
    ).rejects.toThrow(LlmNotConfiguredError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("scores through the fallback and lets the run continue", async () => {
    useClaudeSubscription(FALLBACK);
    const fetchSpy = fallbackAnswers(
      () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: '{"score": 72, "reason": "Solid fit"}' } },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const result = await scoreJobSuitability(createJob({ id: "job-b" }), {});

    expect(result.score).toBe(72);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it.each([
    [503, "down"],
    [429, "slow down"],
  ])("still pauses when the fallback answers %i, because the primary's credentials are the problem", async (status, message) => {
    useClaudeSubscription(FALLBACK);
    fallbackAnswers(
      () =>
        new Response(JSON.stringify({ error: { message } }), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const error = await scoreJobSuitability(
      createJob({ id: "job-c" }),
      {},
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LlmNotConfiguredError);
    expect(String((error as Error).message)).toContain(
      PRIMARY_CONFIGURATION_FAILURE_MARKER,
    );
  });

  it("pauses when the fallback rejects its credentials too", async () => {
    useClaudeSubscription(FALLBACK);
    fallbackAnswers(
      () =>
        new Response(JSON.stringify({ error: { message: "bad key" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await expect(
      scoreJobSuitability(createJob({ id: "job-d" }), {}),
    ).rejects.toThrow(LlmNotConfiguredError);
  });
});

describe("scoring when Claude (subscription) hits its usage limit", () => {
  beforeEach(() => {
    getSettingMock.mockResolvedValue(null);
    getEffectiveSettingsMock.mockResolvedValue({
      penalizeMissingSalary: { value: false, default: false, override: null },
      missingSalaryPenalty: { value: 10, default: 10, override: null },
      scoringInstructions: { value: "", default: "", override: null },
      scoringPromptTemplate: { value: "", default: "", override: null },
      rxresumeBaseResumeId: "base-resume-123",
    });
    resolveLlmModelMock.mockResolvedValue("sonnet");
    vi.spyOn(ClaudeAgentSdkClient.prototype, "callJson").mockRejectedValue(
      new ClaudeAgentSdkError("usage_limit", "resets 5pm"),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("counts the job as failed, not paused, when the fallback has an outage", async () => {
    useClaudeSubscription(FALLBACK);
    fallbackAnswers(
      () =>
        new Response(JSON.stringify({ error: { message: "down" } }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await expect(
      scoreJobSuitability(createJob({ id: "job-e" }), {}),
    ).rejects.toThrow(ScoringUnavailableError);
  });
});
