import { runWithRequestContext } from "@infra/request-context";
import { describe, expect, it } from "vitest";
import { buildLlmBreakerKey, LlmCircuitBreaker } from "./breaker";
import type { LlmFallbackConfig } from "./config";
import { describeLlmFallbackStatus } from "./status";

const READY: LlmFallbackConfig = {
  state: "ready",
  forced: false,
  target: {
    provider: "openai_compatible",
    model: "muse-spark-1.2",
    baseUrl: "https://api.meta.ai/v1",
    apiKey: "muse-secret-key",
  },
  breaker: { threshold: 1, cooldownMs: 60_000 },
};

describe("describeLlmFallbackStatus", () => {
  it("reports nothing when no fallback is configured", () => {
    expect(
      describeLlmFallbackStatus({
        primaryProvider: "claude_agent_sdk",
        primaryBaseUrl: null,
        config: { state: "absent", forced: false },
      }),
    ).toMatchObject({ configured: false, active: false, inactiveReason: null });
  });

  it("reports an active fallback without its key", () => {
    const status = describeLlmFallbackStatus({
      primaryProvider: "claude_agent_sdk",
      primaryBaseUrl: null,
      config: READY,
      breaker: new LlmCircuitBreaker(),
    });
    expect(status).toEqual({
      configured: true,
      active: true,
      provider: "openai_compatible",
      model: "muse-spark-1.2",
      forced: false,
      tripped: false,
      trippedUntil: null,
      inactiveReason: null,
      lastFailover: null,
    });
    expect(JSON.stringify(status)).not.toContain("muse-secret-key");
  });

  it("reports the force flag", () => {
    expect(
      describeLlmFallbackStatus({
        primaryProvider: "claude_agent_sdk",
        primaryBaseUrl: null,
        config: { ...READY, forced: true },
        breaker: new LlmCircuitBreaker(),
      }),
    ).toMatchObject({ active: true, forced: true });
  });

  it("explains a misconfiguration", () => {
    expect(
      describeLlmFallbackStatus({
        primaryProvider: "claude_agent_sdk",
        primaryBaseUrl: null,
        config: {
          state: "invalid",
          forced: false,
          reason: "LLM_FALLBACK_MODEL is not set.",
          provider: "openai_compatible",
          model: null,
        },
      }),
    ).toMatchObject({
      configured: false,
      active: false,
      provider: "openai_compatible",
      inactiveReason: "LLM_FALLBACK_MODEL is not set.",
    });
  });

  it("explains a fallback that is the same endpoint as the primary", () => {
    expect(
      describeLlmFallbackStatus({
        primaryProvider: "openai_compatible",
        primaryBaseUrl: "https://api.meta.ai/v1/",
        config: READY,
      }),
    ).toMatchObject({
      configured: true,
      active: false,
      inactiveReason: expect.stringContaining("same provider and endpoint"),
    });
  });

  it("reports the current tenant's breaker state and last failover", () => {
    let now = Date.parse("2026-11-17T10:00:00.000Z");
    const breaker = new LlmCircuitBreaker(() => now);
    const key = buildLlmBreakerKey({
      tenantId: "tenant-a",
      provider: "claude_agent_sdk",
      baseUrl: "",
    });
    breaker.recordFailure(key, { threshold: 1, cooldownMs: 60_000 }, false);
    breaker.noteFailover(key, "usage_limit");
    now += 1_000;

    const forTenant = (tenantId: string) =>
      runWithRequestContext({ tenantId }, () =>
        describeLlmFallbackStatus({
          primaryProvider: "claude_agent_sdk",
          primaryBaseUrl: null,
          config: READY,
          breaker,
        }),
      );

    expect(forTenant("tenant-a")).toMatchObject({
      tripped: true,
      trippedUntil: "2026-11-17T10:01:00.000Z",
      lastFailover: { at: "2026-11-17T10:00:00.000Z", reason: "usage_limit" },
    });
    expect(forTenant("tenant-b")).toMatchObject({
      tripped: false,
      trippedUntil: null,
      lastFailover: null,
    });
  });
});
