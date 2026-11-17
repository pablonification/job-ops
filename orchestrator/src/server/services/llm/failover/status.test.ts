import { runWithRequestContext } from "@infra/request-context";
import { describe, expect, it } from "vitest";
import { buildLlmBreakerKey, LlmCircuitBreaker } from "./breaker";
import type { LlmFallbackConfig } from "./config";
import { describeLlmFallbackStatus, type LlmStatusPrimary } from "./status";

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

const CLAUDE_DEFAULT: LlmStatusPrimary[] = [
  { purpose: "default", provider: "claude_agent_sdk", baseUrl: null },
];

function trip(
  breaker: LlmCircuitBreaker,
  key: string,
  policy = { threshold: 1, cooldownMs: 60_000 },
) {
  breaker.recordFailure(
    key,
    policy,
    breaker.acquire(key, policy),
    "configuration",
  );
}

describe("describeLlmFallbackStatus", () => {
  it("reports nothing when no fallback is configured", () => {
    expect(
      describeLlmFallbackStatus({
        primaries: CLAUDE_DEFAULT,
        config: { state: "absent", forced: false },
      }),
    ).toMatchObject({ configured: false, active: false, inactiveReason: null });
  });

  it("reports an active fallback without its key", () => {
    const status = describeLlmFallbackStatus({
      primaries: CLAUDE_DEFAULT,
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
      trippedPurposes: [],
      inactiveReason: null,
      lastFailover: null,
    });
    expect(JSON.stringify(status)).not.toContain("muse-secret-key");
  });

  it("reports the force flag", () => {
    expect(
      describeLlmFallbackStatus({
        primaries: CLAUDE_DEFAULT,
        config: { ...READY, forced: true },
        breaker: new LlmCircuitBreaker(),
      }),
    ).toMatchObject({ active: true, forced: true });
  });

  it("explains a misconfiguration", () => {
    expect(
      describeLlmFallbackStatus({
        primaries: CLAUDE_DEFAULT,
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
        primaries: [
          {
            purpose: "default",
            provider: "openai_compatible",
            baseUrl: "https://api.meta.ai/v1/",
          },
        ],
        config: READY,
      }),
    ).toMatchObject({
      configured: true,
      active: false,
      inactiveReason: expect.stringContaining("same provider and endpoint"),
    });
  });

  it("reports the current tenant's breaker state and last failover with its outcome", () => {
    let now = Date.parse("2026-11-17T10:00:00.000Z");
    const breaker = new LlmCircuitBreaker(() => now);
    const key = buildLlmBreakerKey({
      tenantId: "tenant-a",
      provider: "claude_agent_sdk",
      baseUrl: "",
    });
    trip(breaker, key);
    breaker.noteFailover(key, "usage_limit", "succeeded");
    now += 1_000;

    const forTenant = (tenantId: string) =>
      runWithRequestContext({ tenantId }, () =>
        describeLlmFallbackStatus({
          primaries: CLAUDE_DEFAULT,
          config: READY,
          breaker,
        }),
      );

    expect(forTenant("tenant-a")).toMatchObject({
      tripped: true,
      trippedUntil: "2026-11-17T10:01:00.000Z",
      trippedPurposes: ["default"],
      lastFailover: {
        at: "2026-11-17T10:00:00.000Z",
        reason: "usage_limit",
        outcome: "succeeded",
        purposes: ["default"],
      },
    });
    expect(forTenant("tenant-b")).toMatchObject({
      tripped: false,
      trippedUntil: null,
      trippedPurposes: [],
      lastFailover: null,
    });
  });

  it("reports tripped when only a purpose override's primary is skipped", () => {
    const breaker = new LlmCircuitBreaker(() => 0);
    const scoringKey = buildLlmBreakerKey({
      tenantId: "tenant-a",
      provider: "openai",
      baseUrl: "https://api.openai.com",
    });
    trip(breaker, scoringKey);

    const status = runWithRequestContext({ tenantId: "tenant-a" }, () =>
      describeLlmFallbackStatus({
        primaries: [
          ...CLAUDE_DEFAULT,
          { purpose: "scoring", provider: "openai", baseUrl: null },
          { purpose: "tailoring", provider: "claude_agent_sdk", baseUrl: null },
        ],
        config: READY,
        breaker,
      }),
    );

    expect(status).toMatchObject({
      active: true,
      tripped: true,
      trippedPurposes: ["scoring"],
    });
  });
});
