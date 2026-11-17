import { describe, expect, it } from "vitest";
import { buildLlmBreakerKey, LlmCircuitBreaker } from "./breaker";

const POLICY = { threshold: 3, cooldownMs: 10_000 };

function setup() {
  let now = 0;
  const breaker = new LlmCircuitBreaker(() => now);
  return {
    breaker,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("LlmCircuitBreaker", () => {
  it("opens after the threshold of consecutive failures", () => {
    const { breaker } = setup();
    expect(breaker.recordFailure("k", POLICY, false)).toBe(false);
    expect(breaker.recordFailure("k", POLICY, false)).toBe(false);
    expect(breaker.acquire("k", POLICY).skipPrimary).toBe(false);
    expect(breaker.recordFailure("k", POLICY, false)).toBe(true);
    expect(breaker.acquire("k", POLICY)).toEqual({
      skipPrimary: true,
      probe: false,
    });
    expect(breaker.snapshot("k")).toMatchObject({
      tripped: true,
      openUntil: 10_000,
    });
  });

  it("a success resets the failure count", () => {
    const { breaker } = setup();
    breaker.recordFailure("k", POLICY, false);
    breaker.recordFailure("k", POLICY, false);
    breaker.recordSuccess("k");
    expect(breaker.recordFailure("k", POLICY, false)).toBe(false);
    expect(breaker.acquire("k", POLICY).skipPrimary).toBe(false);
  });

  it("allows one probe after the cool-down and closes when it succeeds", () => {
    const { breaker, advance } = setup();
    for (let i = 0; i < 3; i++) breaker.recordFailure("k", POLICY, false);
    advance(10_000);
    expect(breaker.acquire("k", POLICY)).toEqual({
      skipPrimary: false,
      probe: true,
    });
    // Concurrent calls keep using the fallback while the probe runs.
    expect(breaker.acquire("k", POLICY)).toEqual({
      skipPrimary: true,
      probe: false,
    });
    breaker.recordSuccess("k");
    expect(breaker.acquire("k", POLICY)).toEqual({
      skipPrimary: false,
      probe: false,
    });
    expect(breaker.snapshot("k").tripped).toBe(false);
  });

  it("re-opens for a full cool-down when the probe fails", () => {
    const { breaker, advance } = setup();
    for (let i = 0; i < 3; i++) breaker.recordFailure("k", POLICY, false);
    advance(10_000);
    const gate = breaker.acquire("k", POLICY);
    expect(breaker.recordFailure("k", POLICY, gate.probe)).toBe(true);
    advance(9_999);
    expect(breaker.acquire("k", POLICY).skipPrimary).toBe(true);
    advance(1);
    expect(breaker.acquire("k", POLICY).probe).toBe(true);
  });

  it("frees the probe slot when a probe ends without a verdict", () => {
    const { breaker, advance } = setup();
    for (let i = 0; i < 3; i++) breaker.recordFailure("k", POLICY, false);
    advance(10_000);
    expect(breaker.acquire("k", POLICY).probe).toBe(true);
    breaker.releaseProbe("k");
    expect(breaker.acquire("k", POLICY).probe).toBe(true);
  });

  it("keeps keys independent", () => {
    const { breaker } = setup();
    for (let i = 0; i < 3; i++) breaker.recordFailure("a", POLICY, false);
    expect(breaker.acquire("a", POLICY).skipPrimary).toBe(true);
    expect(breaker.acquire("b", POLICY).skipPrimary).toBe(false);
  });

  it("records the last failover for status", () => {
    const { breaker, advance } = setup();
    advance(42);
    breaker.noteFailover("k", "usage_limit");
    expect(breaker.snapshot("k").lastFailover).toEqual({
      at: 42,
      reason: "usage_limit",
    });
  });
});

describe("buildLlmBreakerKey", () => {
  it("includes tenant, provider and a normalised base URL", () => {
    expect(
      buildLlmBreakerKey({
        tenantId: "t1",
        provider: "openai_compatible",
        baseUrl: "https://X.example/v1/",
      }),
    ).toBe("t1|openai_compatible|https://x.example/v1");
    expect(
      buildLlmBreakerKey({
        tenantId: "t2",
        provider: "claude_agent_sdk",
        baseUrl: "",
      }),
    ).toBe("t2|claude_agent_sdk|");
  });
});
