import type { LlmFailureKind } from "./classification";
import { normalizeLlmBaseUrl } from "./endpoint";

export type LlmBreakerPolicy = {
  /** Consecutive provider-side failures that open the breaker. */
  threshold: number;
  /** How long the primary is skipped once the breaker is open. */
  cooldownMs: number;
};

export const DEFAULT_LLM_BREAKER_POLICY: LlmBreakerPolicy = {
  threshold: 3,
  cooldownMs: 5 * 60_000,
};

export type LlmBreakerGate =
  /** Call the primary normally. */
  | { skipPrimary: false; probe: false }
  /** Cool-down is over: this call is the single trial of the primary. */
  | { skipPrimary: false; probe: true }
  /** Breaker is open (or another call is probing): go straight to the fallback. */
  | { skipPrimary: true; probe: false };

export type LlmBreakerSnapshot = {
  tripped: boolean;
  openUntil: number | null;
  consecutiveFailures: number;
  lastFailover: { at: number; reason: string } | null;
};

type BreakerEntry = {
  consecutiveFailures: number;
  openUntil: number | null;
  probeStartedAt: number | null;
  lastFailover: { at: number; reason: string } | null;
};

/**
 * Circuit breaker for the primary LLM provider. Process state, keyed by the
 * caller (see `buildLlmBreakerKey`): one entry per tenant and primary
 * endpoint, so one tenant's rejected key never makes another tenant skip a
 * healthy provider.
 *
 * closed → (threshold consecutive provider-side failures) → open
 * open → (cool-down elapsed) → half-open: one call probes the primary while
 * the others keep using the fallback. A successful probe closes the breaker;
 * a failed one opens it for another cool-down.
 */
export class LlmCircuitBreaker {
  private readonly entries = new Map<string, BreakerEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  private entry(key: string): BreakerEntry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        consecutiveFailures: 0,
        openUntil: null,
        probeStartedAt: null,
        lastFailover: null,
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  acquire(key: string, policy: LlmBreakerPolicy): LlmBreakerGate {
    const entry = this.entries.get(key);
    if (!entry || entry.openUntil === null) {
      return { skipPrimary: false, probe: false };
    }
    const now = this.now();
    if (now < entry.openUntil) return { skipPrimary: true, probe: false };

    // Half-open. A probe that never reported back (should not happen, every
    // call has a timeout) stops blocking new probes after one cool-down.
    if (
      entry.probeStartedAt !== null &&
      now - entry.probeStartedAt < policy.cooldownMs
    ) {
      return { skipPrimary: true, probe: false };
    }
    entry.probeStartedAt = now;
    return { skipPrimary: false, probe: true };
  }

  recordSuccess(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.consecutiveFailures = 0;
    entry.openUntil = null;
    entry.probeStartedAt = null;
  }

  /**
   * Record a provider-side failure. Returns true when this failure opened
   * (or re-opened) the breaker.
   */
  recordFailure(
    key: string,
    policy: LlmBreakerPolicy,
    wasProbe: boolean,
  ): boolean {
    const entry = this.entry(key);
    entry.consecutiveFailures += 1;
    entry.probeStartedAt = null;
    const alreadyOpen =
      entry.openUntil !== null && this.now() < entry.openUntil;
    if (
      !alreadyOpen &&
      (wasProbe || entry.consecutiveFailures >= policy.threshold)
    ) {
      entry.openUntil = this.now() + policy.cooldownMs;
      return true;
    }
    return false;
  }

  /** A probe ended without saying anything about provider health. */
  releaseProbe(key: string): void {
    const entry = this.entries.get(key);
    if (entry) entry.probeStartedAt = null;
  }

  noteFailover(key: string, reason: LlmFailureKind | string): void {
    this.entry(key).lastFailover = { at: this.now(), reason };
  }

  snapshot(key: string): LlmBreakerSnapshot {
    const entry = this.entries.get(key);
    if (!entry) {
      return {
        tripped: false,
        openUntil: null,
        consecutiveFailures: 0,
        lastFailover: null,
      };
    }
    return {
      // Still tripped while half-open: until a probe succeeds, calls keep
      // going to the fallback.
      tripped: entry.openUntil !== null,
      openUntil: entry.openUntil,
      consecutiveFailures: entry.consecutiveFailures,
      lastFailover: entry.lastFailover,
    };
  }

  reset(): void {
    this.entries.clear();
  }
}

export function buildLlmBreakerKey(args: {
  tenantId: string;
  provider: string;
  baseUrl: string | null | undefined;
}): string {
  return [args.tenantId, args.provider, normalizeLlmBaseUrl(args.baseUrl)].join(
    "|",
  );
}

/** The process-wide breaker used outside tests. */
export const llmCircuitBreaker = new LlmCircuitBreaker();
