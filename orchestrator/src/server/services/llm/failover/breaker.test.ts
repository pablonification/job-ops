import { describe, expect, it } from "vitest";
import { buildLlmBreakerKey, LlmCircuitBreaker } from "./breaker";

const POLICY = { threshold: 3, cooldownMs: 10_000 };

function setup(limits?: { maxEntries: number; idleTtlMs: number }) {
  let now = 0;
  const breaker = new LlmCircuitBreaker(() => now, limits);
  return {
    breaker,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function failTimes(breaker: LlmCircuitBreaker, key: string, times: number) {
  for (let i = 0; i < times; i++) {
    const gate = breaker.acquire(key, POLICY);
    breaker.recordFailure(key, POLICY, gate, "upstream");
  }
}

describe("LlmCircuitBreaker", () => {
  it("opens after the threshold of consecutive failures", () => {
    const { breaker } = setup();
    failTimes(breaker, "k", 2);
    expect(breaker.acquire("k", POLICY).skipPrimary).toBe(false);
    const gate = breaker.acquire("k", POLICY);
    expect(breaker.recordFailure("k", POLICY, gate, "upstream")).toBe(true);
    expect(breaker.acquire("k", POLICY)).toMatchObject({
      skipPrimary: true,
      probe: false,
    });
    expect(breaker.snapshot("k")).toMatchObject({
      tripped: true,
      openUntil: 10_000,
    });
    expect(breaker.openReason("k")).toBe("upstream");
  });

  it("a success resets the failure count", () => {
    const { breaker } = setup();
    failTimes(breaker, "k", 2);
    breaker.recordSuccess("k", breaker.acquire("k", POLICY));
    failTimes(breaker, "k", 1);
    expect(breaker.acquire("k", POLICY).skipPrimary).toBe(false);
  });

  it("allows one probe after the cool-down and closes when it succeeds", () => {
    const { breaker, advance } = setup();
    failTimes(breaker, "k", 3);
    advance(10_000);
    const probe = breaker.acquire("k", POLICY);
    expect(probe).toMatchObject({ skipPrimary: false, probe: true });
    // Concurrent calls keep using the fallback while the probe runs.
    expect(breaker.acquire("k", POLICY)).toMatchObject({
      skipPrimary: true,
      probe: false,
    });
    breaker.recordSuccess("k", probe);
    expect(breaker.acquire("k", POLICY)).toMatchObject({
      skipPrimary: false,
      probe: false,
    });
    expect(breaker.snapshot("k").tripped).toBe(false);
  });

  it("re-opens for a full cool-down when the probe fails", () => {
    const { breaker, advance } = setup();
    failTimes(breaker, "k", 3);
    advance(10_000);
    const probe = breaker.acquire("k", POLICY);
    expect(breaker.recordFailure("k", POLICY, probe, "timeout")).toBe(true);
    advance(9_999);
    expect(breaker.acquire("k", POLICY).skipPrimary).toBe(true);
    advance(1);
    expect(breaker.acquire("k", POLICY).probe).toBe(true);
  });

  it("frees the probe slot when a probe ends without a verdict", () => {
    const { breaker, advance } = setup();
    failTimes(breaker, "k", 3);
    advance(10_000);
    const probe = breaker.acquire("k", POLICY);
    expect(probe.probe).toBe(true);
    breaker.releaseProbe("k", probe);
    expect(breaker.acquire("k", POLICY).probe).toBe(true);
  });

  it("ignores results from calls admitted before the breaker opened", () => {
    const { breaker, advance } = setup();
    // Four calls start while the breaker is closed.
    const early = Array.from({ length: 4 }, () => breaker.acquire("k", POLICY));
    // Three fail and open the breaker.
    for (const gate of early.slice(0, 3)) {
      breaker.recordFailure("k", POLICY, gate, "upstream");
    }
    expect(breaker.snapshot("k").tripped).toBe(true);

    // The cool-down passes and a probe starts.
    advance(10_000);
    const probe = breaker.acquire("k", POLICY);
    expect(probe.probe).toBe(true);

    // The slow fourth call finishes now: neither its success nor a failure
    // may close or re-open the breaker.
    breaker.recordSuccess("k", early[3]);
    expect(breaker.snapshot("k").tripped).toBe(true);
    expect(breaker.recordFailure("k", POLICY, early[3], "upstream")).toBe(
      false,
    );
    expect(breaker.snapshot("k").openUntil).toBe(10_000);

    // Only the probe decides.
    breaker.recordSuccess("k", probe);
    expect(breaker.snapshot("k").tripped).toBe(false);
  });

  it("ignores a late failure from a call that started before a probe closed the breaker", () => {
    const { breaker, advance } = setup();
    failTimes(breaker, "k", 3);
    advance(10_000);
    const probe = breaker.acquire("k", POLICY);
    breaker.recordSuccess("k", probe);
    // A call admitted under the old (open) generation reports late.
    expect(breaker.recordFailure("k", POLICY, probe, "upstream")).toBe(false);
    expect(breaker.snapshot("k")).toMatchObject({
      tripped: false,
      consecutiveFailures: 0,
    });
  });

  it("keeps keys independent", () => {
    const { breaker } = setup();
    failTimes(breaker, "a", 3);
    expect(breaker.acquire("a", POLICY).skipPrimary).toBe(true);
    expect(breaker.acquire("b", POLICY).skipPrimary).toBe(false);
  });

  it("records the last failover with its outcome", () => {
    const { breaker, advance } = setup();
    advance(42);
    breaker.noteFailover("k", "usage_limit", "failed");
    expect(breaker.snapshot("k").lastFailover).toEqual({
      at: 42,
      reason: "usage_limit",
      outcome: "failed",
    });
  });

  it("drops closed entries that have been idle past the TTL", () => {
    const { breaker, advance } = setup({ maxEntries: 100, idleTtlMs: 1_000 });
    breaker.noteFailover("old", "timeout", "succeeded");
    failTimes(breaker, "open", 3);
    advance(1_001);
    breaker.noteFailover("new", "timeout", "succeeded");
    expect(breaker.snapshot("old").lastFailover).toBeNull();
    // Open entries are never evicted for idleness.
    expect(breaker.snapshot("open").tripped).toBe(true);
    expect(breaker.size()).toBe(2);
  });

  it("caps the number of entries, evicting the oldest closed ones first", () => {
    const { breaker, advance } = setup({
      maxEntries: 3,
      idleTtlMs: 60_000,
    });
    failTimes(breaker, "open", 3);
    for (const key of ["a", "b", "c", "d"]) {
      advance(1);
      breaker.noteFailover(key, "timeout", "succeeded");
    }
    expect(breaker.size()).toBeLessThanOrEqual(3);
    expect(breaker.snapshot("open").tripped).toBe(true);
    expect(breaker.snapshot("d").lastFailover).not.toBeNull();
    expect(breaker.snapshot("a").lastFailover).toBeNull();
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
