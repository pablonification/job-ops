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

/**
 * What a call may do, plus the breaker generation it was admitted under.
 * Results are only applied when they belong to the current generation, so a
 * call that started before the breaker opened (or before a probe began)
 * cannot close or re-open it.
 */
export type LlmBreakerGate =
  /** Call the primary normally. */
  | { skipPrimary: false; probe: false; generation: number }
  /** Cool-down is over: this call is the single trial of the primary. */
  | { skipPrimary: false; probe: true; generation: number }
  /** Breaker is open (or another call is probing): go straight to the fallback. */
  | { skipPrimary: true; probe: false; generation: number };

export type LlmFailoverOutcome = "succeeded" | "failed";

export type LlmLastFailover = {
  at: number;
  reason: string;
  outcome: LlmFailoverOutcome;
};

export type LlmBreakerSnapshot = {
  tripped: boolean;
  openUntil: number | null;
  consecutiveFailures: number;
  lastFailover: LlmLastFailover | null;
};

type BreakerEntry = {
  /** Bumped on every state change: open, probe start, close. */
  generation: number;
  consecutiveFailures: number;
  openUntil: number | null;
  probeStartedAt: number | null;
  /** The kind of the failure that last counted against the primary. */
  lastFailureKind: LlmFailureKind | null;
  lastFailover: LlmLastFailover | null;
  lastActivityAt: number;
};

/** Entries kept at most; closed, idle ones are dropped first. */
export const LLM_BREAKER_MAX_ENTRIES = 500;
/** Closed entries idle for longer than this are dropped. */
export const LLM_BREAKER_IDLE_TTL_MS = 24 * 60 * 60_000;

/**
 * Circuit breaker for the primary LLM provider. Process state, keyed by the
 * caller (see `buildLlmBreakerKey`): one entry per tenant and primary
 * endpoint, so one tenant's rejected key never makes another tenant skip a
 * healthy provider.
 *
 * closed → (threshold consecutive provider-side failures) → open
 * open → (cool-down elapsed) → half-open: one call probes the primary while
 * the others keep using the fallback. Only the probe's result changes state:
 * success closes the breaker, failure opens it for another cool-down.
 */
export class LlmCircuitBreaker {
  private readonly entries = new Map<string, BreakerEntry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly limits = {
      maxEntries: LLM_BREAKER_MAX_ENTRIES,
      idleTtlMs: LLM_BREAKER_IDLE_TTL_MS,
    },
  ) {}

  private entry(key: string): BreakerEntry {
    let entry = this.entries.get(key);
    if (!entry) {
      this.prune();
      entry = {
        generation: 0,
        consecutiveFailures: 0,
        openUntil: null,
        probeStartedAt: null,
        lastFailureKind: null,
        lastFailover: null,
        lastActivityAt: this.now(),
      };
      this.entries.set(key, entry);
    }
    entry.lastActivityAt = this.now();
    return entry;
  }

  /** Drop closed entries idle past the TTL, then the oldest closed ones over the cap. */
  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (
        entry.openUntil === null &&
        now - entry.lastActivityAt > this.limits.idleTtlMs
      ) {
        this.entries.delete(key);
      }
    }
    if (this.entries.size < this.limits.maxEntries) return;
    const byAge = [...this.entries.entries()].sort(
      (a, b) =>
        Number(a[1].openUntil !== null) - Number(b[1].openUntil !== null) ||
        a[1].lastActivityAt - b[1].lastActivityAt,
    );
    for (const [key] of byAge) {
      if (this.entries.size < this.limits.maxEntries) break;
      this.entries.delete(key);
    }
  }

  acquire(key: string, policy: LlmBreakerPolicy): LlmBreakerGate {
    const entry = this.entries.get(key);
    if (!entry || entry.openUntil === null) {
      return {
        skipPrimary: false,
        probe: false,
        generation: entry?.generation ?? 0,
      };
    }
    entry.lastActivityAt = this.now();
    const now = this.now();
    if (now < entry.openUntil) {
      return { skipPrimary: true, probe: false, generation: entry.generation };
    }

    // Half-open. A probe that never reported back (should not happen, every
    // call has a timeout) stops blocking new probes after one cool-down.
    if (
      entry.probeStartedAt !== null &&
      now - entry.probeStartedAt < policy.cooldownMs
    ) {
      return { skipPrimary: true, probe: false, generation: entry.generation };
    }
    entry.probeStartedAt = now;
    entry.generation += 1;
    return { skipPrimary: false, probe: true, generation: entry.generation };
  }

  private isCurrent(entry: BreakerEntry, gate: LlmBreakerGate): boolean {
    return entry.generation === gate.generation;
  }

  recordSuccess(key: string, gate: LlmBreakerGate): void {
    const entry = this.entries.get(key);
    if (!entry || !this.isCurrent(entry, gate)) return;
    entry.lastActivityAt = this.now();
    if (entry.openUntil !== null) {
      // Only the probe can be current while the breaker is not closed.
      entry.generation += 1;
      entry.openUntil = null;
      entry.probeStartedAt = null;
    }
    entry.consecutiveFailures = 0;
    entry.lastFailureKind = null;
  }

  /**
   * Record a provider-side failure. Returns true when this failure opened
   * (or re-opened) the breaker. Stale results (from a call admitted under an
   * earlier generation) are ignored.
   */
  recordFailure(
    key: string,
    policy: LlmBreakerPolicy,
    gate: LlmBreakerGate,
    kind: LlmFailureKind,
  ): boolean {
    const existing = this.entries.get(key);
    if (existing && !this.isCurrent(existing, gate)) return false;
    if (!existing && gate.generation !== 0) return false;
    const entry = this.entry(key);
    entry.consecutiveFailures += 1;
    entry.lastFailureKind = kind;
    if (gate.probe || entry.consecutiveFailures >= policy.threshold) {
      entry.generation += 1;
      entry.openUntil = this.now() + policy.cooldownMs;
      entry.probeStartedAt = null;
      return true;
    }
    return false;
  }

  /** A probe ended without saying anything about provider health. */
  releaseProbe(key: string, gate: LlmBreakerGate): void {
    const entry = this.entries.get(key);
    if (entry && gate.probe && this.isCurrent(entry, gate)) {
      entry.probeStartedAt = null;
    }
  }

  /** Why the primary is being skipped, while the breaker is not closed. */
  openReason(key: string): LlmFailureKind | null {
    const entry = this.entries.get(key);
    return entry?.openUntil !== null ? (entry?.lastFailureKind ?? null) : null;
  }

  noteFailover(
    key: string,
    reason: LlmFailureKind | string,
    outcome: LlmFailoverOutcome,
  ): void {
    this.entry(key).lastFailover = { at: this.now(), reason, outcome };
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

  size(): number {
    return this.entries.size;
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
