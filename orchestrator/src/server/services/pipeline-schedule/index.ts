/**
 * Scheduled pipeline runs.
 *
 * An in-process timer ticks once a minute. Each tick finds the tenants with
 * a schedule switched on and, for each, starts a run with the tenant's saved
 * search when the schedule is due:
 *
 * - Single fire: a run starts only after `claimScheduledOccurrence` moves the
 *   tenant's last fired occurrence and its local date forward in the
 *   database, so there is at most one scheduled run per local calendar day,
 *   even with two ticks in a minute, a restart, or a time edited after the
 *   day's run.
 * - Catch-up: after downtime a missed occurrence still fires when it is at
 *   most `scheduleCatchUpMinutes` old (default 15); older ones are skipped.
 *   Times before the schedule was last saved never fire, so turning the
 *   schedule on or moving the time does not start a run straight away.
 * - Skip, never queue: when a run is already active the occurrence is used
 *   up and recorded as skipped.
 * - Each scheduled run runs as the user who last saved the schedule, or the
 *   tenant's earliest active system admin (see `findScheduleRunAsUser`).
 *
 * Not started in hosted or demo mode. Every tick and every tenant is wrapped:
 * nothing here can take the server down or stop another tenant's schedule.
 */
import { randomUUID } from "node:crypto";
import { AppError } from "@infra/errors";
import { logger } from "@infra/logger";
import { runWithRequestContext } from "@infra/request-context";
import { sanitizeUnknown } from "@infra/sanitize";
import { getJobOpsAppConfig } from "@server/config/app-mode";
import { isDemoMode } from "@server/config/demo";
import * as pipelineRepo from "@server/repositories/pipeline";
import {
  claimScheduledOccurrence,
  findScheduleRunAsUser,
  getPipelineScheduleState,
  listTenantsWithScheduleEnabled,
  markInvalidTimeZoneReported,
  type PipelineScheduleStateRow,
  recordScheduleAttempt,
} from "@server/repositories/pipeline-schedule";
import * as settingsRepo from "@server/repositories/settings";
import {
  getDigestBaseUrl,
  getTelegramCredentials,
  queueRunDigest,
  sanitizeDigestReason,
} from "@server/services/run-digest";
import { getActiveTenantId } from "@server/tenancy/context";
import { isValidTimeZone } from "@shared/pipeline-schedule";
import { settingsRegistry } from "@shared/settings-registry";
import type {
  PipelineScheduleStatus,
  ScheduleAttemptOutcome,
} from "@shared/types";
import { resolvePipelineRunConfig } from "../pipeline-run";
import type { StartPipelineRunConfig } from "../pipeline-search-config";
import {
  type DailySchedule,
  findDueOccurrence,
  findNextOccurrence,
  type ScheduleFiredState,
} from "./due-time";

export {
  type DailySchedule,
  findDueOccurrence,
  findNextOccurrence,
  listOccurrences,
  type Occurrence,
  type ScheduleFiredState,
} from "./due-time";

const MINUTE_MS = 60_000;
/** Ticks land this long after each minute starts. */
const TICK_OFFSET_MS = 2_000;

export type ScheduleSettings = DailySchedule & {
  enabled: boolean;
  catchUpMinutes: number;
  searchPresetId: string;
};

/** The current tenant's schedule settings, with defaults applied. */
export async function loadScheduleSettings(): Promise<ScheduleSettings> {
  const stored = await settingsRepo.getAllSettings();
  const registry = settingsRegistry;
  return {
    enabled:
      registry.scheduleEnabled.parse(stored.scheduleEnabled) ??
      registry.scheduleEnabled.default(),
    time:
      registry.scheduleTime.parse(stored.scheduleTime) ??
      registry.scheduleTime.default(),
    timeZone:
      registry.scheduleTimeZone.parse(stored.scheduleTimeZone) ??
      registry.scheduleTimeZone.default(),
    weekdays:
      registry.scheduleWeekdays.parse(stored.scheduleWeekdays) ??
      registry.scheduleWeekdays.default(),
    catchUpMinutes:
      registry.scheduleCatchUpMinutes.parse(stored.scheduleCatchUpMinutes) ??
      registry.scheduleCatchUpMinutes.default(),
    searchPresetId:
      registry.scheduleSearchPresetId.parse(stored.scheduleSearchPresetId) ??
      registry.scheduleSearchPresetId.default(),
  };
}

/** What has fired and when the schedule was saved, from the tenant's row. */
function firedStateOf(
  state: PipelineScheduleStateRow | null,
): ScheduleFiredState {
  const parse = (iso: string | null | undefined): number | null => {
    const ms = iso ? Date.parse(iso) : Number.NaN;
    return Number.isNaN(ms) ? null : ms;
  };
  return {
    lastFiredMs: parse(state?.lastFiredOccurrence),
    lastFiredLocalDate: state?.lastFiredLocalDate ?? null,
    notBeforeMs: parse(state?.settingsSavedAt),
  };
}

/**
 * When the schedule next starts a run (ISO), or null when it is off,
 * unavailable on this server or has an unknown time zone.
 */
function nextRunAt(
  schedule: ScheduleSettings,
  state: PipelineScheduleStateRow | null,
  now: Date,
): string | null {
  if (getScheduleUnavailableReason()) return null;
  if (!schedule.enabled || !isValidTimeZone(schedule.timeZone)) return null;
  const next = findNextOccurrence({
    schedule,
    nowMs: now.getTime(),
    catchUpMs: schedule.catchUpMinutes * MINUTE_MS,
    ...firedStateOf(state),
  });
  return next === null ? null : new Date(next.instantMs).toISOString();
}

export type StartScheduledRun = (args: {
  /** Already resolved from the chosen saved search; not resolved again. */
  config: StartPipelineRunConfig;
  configResolved: true;
  trigger: "schedule";
  requestOrigin: null;
}) => Promise<unknown>;

export type ScheduleTickDeps = {
  now: () => Date;
  /** `startPipelineRun`; injected so tests never start a real run. */
  startRun: StartScheduledRun;
};

export type TenantTickResult =
  | { status: "disabled" | "invalid_time_zone" | "not_due" | "already_fired" }
  | {
      status: ScheduleAttemptOutcome;
      occurrence: string;
      detail: string | null;
    }
  | { status: "error" };

async function runTenantScheduleTick(
  tenantId: string,
  deps: ScheduleTickDeps,
): Promise<TenantTickResult> {
  const now = deps.now();
  const nowIso = now.toISOString();
  return runWithRequestContext(
    { requestId: `schedule-${randomUUID()}`, tenantId },
    async (): Promise<TenantTickResult> => {
      const schedule = await loadScheduleSettings();
      if (!schedule.enabled) return { status: "disabled" };
      if (!isValidTimeZone(schedule.timeZone)) {
        // Logged once per zone value; the mark lives in the tenant's row.
        const timeZone = schedule.timeZone.slice(0, 100);
        if (
          await markInvalidTimeZoneReported({ tenantId, timeZone, now: nowIso })
        ) {
          logger.warn("Scheduled runs paused: unknown time zone", {
            tenantId,
            timeZone,
          });
        }
        return { status: "invalid_time_zone" };
      }

      const state = await getPipelineScheduleState(tenantId);
      const due = findDueOccurrence({
        schedule,
        nowMs: now.getTime(),
        catchUpMs: schedule.catchUpMinutes * MINUTE_MS,
        ...firedStateOf(state),
      });
      if (due === null) return { status: "not_due" };

      const occurrence = new Date(due.instantMs).toISOString();
      const claimed = await claimScheduledOccurrence({
        tenantId,
        occurrence,
        localDate: due.localDate,
        now: nowIso,
      });
      if (!claimed) return { status: "already_fired" };

      const record = async (
        outcome: ScheduleAttemptOutcome,
        detail: string | null,
      ): Promise<TenantTickResult> => {
        await recordScheduleAttempt({
          tenantId,
          attemptedAt: nowIso,
          outcome,
          detail,
        });
        return { status: outcome, occurrence, detail };
      };

      const user = await findScheduleRunAsUser(
        tenantId,
        state?.ownerUserId ?? null,
      );
      if (!user) {
        logger.warn("Scheduled run skipped: no active user in the workspace", {
          tenantId,
          occurrence,
        });
        return record(
          "skipped_no_user",
          "No active user in this workspace to run as.",
        );
      }

      return runWithRequestContext(
        {
          userId: user.id,
          username: user.username,
          isSystemAdmin: user.isSystemAdmin,
        },
        async () => {
          try {
            // Resolved once, here: the chosen saved search, else the most
            // recently used one, else the stored search settings. Every
            // field comes from that one search; startPipelineRun does not
            // resolve it again.
            const { config } = await resolvePipelineRunConfig(
              {},
              { savedSearchId: schedule.searchPresetId || null },
            );
            await deps.startRun({
              config,
              configResolved: true,
              trigger: "schedule",
              requestOrigin: null,
            });
            logger.info("Scheduled pipeline run started", {
              tenantId,
              occurrence,
            });
            return await record("started", null);
          } catch (error) {
            if (error instanceof AppError && error.status === 409) {
              logger.info("Scheduled run skipped: a run was already active", {
                tenantId,
                occurrence,
              });
              return await record(
                "skipped_active",
                "A run was already active.",
              );
            }
            const reason = sanitizeDigestReason(
              error instanceof Error ? error.message : String(error),
            );
            logger.warn("Scheduled run could not start", {
              tenantId,
              occurrence,
              error: reason,
            });
            queueRunDigest({ kind: "start_failed", error: reason });
            return await record("failed_to_start", reason);
          }
        },
      );
    },
  );
}

/**
 * One scheduler tick over every tenant with a schedule. A failure in one
 * tenant is logged with its id and does not stop the others.
 */
export async function runScheduleTick(
  deps: ScheduleTickDeps,
): Promise<Record<string, TenantTickResult>> {
  const results: Record<string, TenantTickResult> = {};
  let tenantIds: string[];
  try {
    tenantIds = await listTenantsWithScheduleEnabled();
  } catch (error) {
    logger.error("Scheduler tick failed to list schedules", {
      error: sanitizeUnknown(error),
    });
    return results;
  }

  for (const tenantId of tenantIds) {
    try {
      results[tenantId] = await runTenantScheduleTick(tenantId, deps);
    } catch (error) {
      results[tenantId] = { status: "error" };
      logger.error("Scheduler tick failed for a workspace", {
        tenantId,
        error: sanitizeUnknown(error),
      });
    }
  }
  return results;
}

/** Why scheduled runs are unavailable on this server, or null. */
export function getScheduleUnavailableReason(): string | null {
  if (isDemoMode()) return "Scheduled runs are off in the public demo.";
  if (getJobOpsAppConfig().appMode === "hosted") {
    return "Scheduled runs are not available in hosted mode.";
  }
  return null;
}

export type PipelineSchedulerHandle = { stop: () => void };

/**
 * Starts the minute timer. Returns a no-op handle in hosted and demo mode.
 * A tick still running when the next is due is not overlapped; the database
 * claim covers any other overlap.
 */
export function startPipelineScheduler(
  deps: ScheduleTickDeps,
): PipelineSchedulerHandle {
  const unavailable = getScheduleUnavailableReason();
  if (unavailable) {
    logger.info("Pipeline scheduler not started", { reason: unavailable });
    return { stop: () => {} };
  }

  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const scheduleNext = () => {
    if (stopped) return;
    const nowMs = deps.now().getTime();
    const delay = MINUTE_MS - (nowMs % MINUTE_MS) + TICK_OFFSET_MS;
    timer = setTimeout(tick, delay);
    timer.unref?.();
  };

  const tick = () => {
    if (stopped) return;
    if (!running) {
      running = true;
      void runScheduleTick(deps)
        .catch((error) => {
          logger.error("Scheduler tick failed", {
            error: sanitizeUnknown(error),
          });
        })
        .finally(() => {
          running = false;
        });
    }
    scheduleNext();
  };

  logger.info("Pipeline scheduler started");
  // First check right away, so a run missed during a restart is caught up.
  tick();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * Schedule and digest status for the current tenant, for the Settings page.
 * Contains no credentials: only whether Telegram is set up.
 */
export async function getPipelineScheduleStatus(
  now: Date = new Date(),
): Promise<PipelineScheduleStatus> {
  const tenantId = getActiveTenantId();
  const [schedule, state, lastScheduledRun, credentials, rawDigestMode] =
    await Promise.all([
      loadScheduleSettings(),
      getPipelineScheduleState(tenantId),
      pipelineRepo.getLatestPipelineRunByTrigger("schedule"),
      getTelegramCredentials(),
      settingsRepo.getSetting("digestMode"),
    ]);
  const unavailableReason = getScheduleUnavailableReason();
  const timeZoneValid = isValidTimeZone(schedule.timeZone);
  const runAs = await findScheduleRunAsUser(
    tenantId,
    state?.ownerUserId ?? null,
  );

  return {
    available: unavailableReason === null,
    unavailableReason,
    enabled: schedule.enabled,
    timeZone: schedule.timeZone,
    timeZoneValid,
    nextRunAt: nextRunAt(schedule, state, now),
    runAsUsername: runAs?.username ?? null,
    lastAttempt:
      state?.lastFiredOccurrence && state.lastAttemptAt && state.lastOutcome
        ? {
            occurrence: state.lastFiredOccurrence,
            attemptedAt: state.lastAttemptAt,
            outcome: state.lastOutcome,
            detail: state.lastOutcomeDetail,
          }
        : null,
    lastScheduledRun,
    digest: {
      mode:
        settingsRegistry.digestMode.parse(rawDigestMode ?? undefined) ??
        settingsRegistry.digestMode.default(),
      telegramConfigured: credentials !== null,
      linksAvailable: getDigestBaseUrl() !== null,
      lastSentAt: state?.lastDigestAt ?? null,
      lastStatus: state?.lastDigestStatus ?? null,
      lastDetail: state?.lastDigestDetail ?? null,
    },
  };
}

/**
 * When the current tenant's schedule next starts a run (ISO), or null when
 * scheduling is off, unavailable or misconfigured.
 */
export async function getNextScheduledRunAt(
  now: Date = new Date(),
): Promise<string | null> {
  if (getScheduleUnavailableReason()) return null;
  const [schedule, state] = await Promise.all([
    loadScheduleSettings(),
    getPipelineScheduleState(getActiveTenantId()),
  ]);
  return nextRunAt(schedule, state, now);
}
