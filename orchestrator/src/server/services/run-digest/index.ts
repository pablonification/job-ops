/**
 * Run digest: a short Telegram message after a pipeline run.
 *
 * Called from the pipeline when a run finishes, fails or pauses for the
 * owner (bot check, missing model), and from the scheduler when a scheduled
 * run cannot start. Always called inside the run's tenant context; reads the
 * tenant's digest settings and target companies from there.
 *
 * Delivery never fails or delays a run: `queueRunDigest` returns at once and
 * every error is caught, logged without the bot token, and recorded for the
 * Settings page.
 */
import { logger } from "@infra/logger";
import { sanitizeUnknown } from "@infra/sanitize";
import * as jobsRepo from "@server/repositories/jobs";
import { recordDigestDelivery } from "@server/repositories/pipeline-schedule";
import * as settingsRepo from "@server/repositories/settings";
import { getOriginalEnvValue } from "@server/services/envSettings";
import { loadTargetCompanyMatcher } from "@server/services/target-companies";
import { getActiveTenantId } from "@server/tenancy/context";
import { settingsRegistry } from "@shared/settings-registry";
import type { PipelineRunTrigger } from "@shared/types";
import {
  buildDigestMessage,
  type DigestMessageInput,
  sanitizeDigestReason,
} from "./format";
import { sendTelegramMessage, type TelegramFetch } from "./telegram";

export { buildDigestMessage, sanitizeDigestReason } from "./format";
export { sendTelegramMessage, TELEGRAM_MESSAGE_LIMIT } from "./telegram";

export type RunDigestEvent =
  | {
      kind: "completed";
      pipelineRunId: string;
      trigger: PipelineRunTrigger | null;
      jobsFound: number;
      newJobIds: readonly string[];
      jobsScored: number;
      jobsTailored: number;
    }
  | {
      kind: "failed";
      pipelineRunId: string;
      trigger: PipelineRunTrigger | null;
      error: string;
    }
  | {
      kind: "paused";
      pipelineRunId: string;
      trigger: PipelineRunTrigger | null;
      reason: "challenge" | "configuration";
      sources?: string[];
    }
  | { kind: "start_failed"; error: string };

export type RunDigestOutcome =
  | "sent"
  | "failed"
  | "skipped_off"
  | "skipped_not_configured"
  | "skipped_nothing_new";

export type RunDigestDeps = {
  fetchImpl?: TelegramFetch;
  now?: () => Date;
  /** Wait before the one retry after a 429; injected by tests. */
  sleep?: (ms: number) => Promise<void>;
};

/** Run context for log lines: the run's id, null for a start failure. */
function runIdOf(event: RunDigestEvent): string | null {
  return event.kind === "start_failed" ? null : event.pipelineRunId;
}

/** The public base URL for links, or null (then the digest has no links). */
export function getDigestBaseUrl(): string | null {
  const raw = process.env.JOBOPS_PUBLIC_BASE_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return raw.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** The tenant's bot token and chat id, or null when either is missing. */
export async function getTelegramCredentials(): Promise<{
  botToken: string;
  chatId: string;
} | null> {
  const [storedToken, storedChatId] = await Promise.all([
    settingsRepo.getSetting("telegramBotToken"),
    settingsRepo.getSetting("telegramChatId"),
  ]);
  const botToken = (
    storedToken ??
    getOriginalEnvValue(settingsRegistry.telegramBotToken.envKey) ??
    ""
  ).trim();
  const chatId =
    settingsRegistry.telegramChatId.parse(storedChatId ?? undefined)?.trim() ??
    "";
  return botToken && chatId ? { botToken, chatId } : null;
}

function triggerOf(event: RunDigestEvent): PipelineRunTrigger | null {
  return event.kind === "start_failed" ? "schedule" : event.trigger;
}

async function toMessageInput(
  event: RunDigestEvent,
  maxJobs: number,
): Promise<DigestMessageInput> {
  const baseUrl = getDigestBaseUrl();
  switch (event.kind) {
    case "completed": {
      const rows = await jobsRepo.listJobDigestRowsByIds([...event.newJobIds]);
      // Jobs scoring under the auto-skip threshold are counted, not listed.
      const listed = rows.filter((row) => row.status !== "skipped");
      const matcher =
        listed.length > 0 ? await loadTargetCompanyMatcher() : null;
      return {
        kind: "completed",
        trigger: event.trigger,
        counts: {
          found: event.jobsFound,
          new: rows.length,
          autoSkipped: rows.length - listed.length,
          scored: event.jobsScored,
          tailored: event.jobsTailored,
        },
        jobs: listed.map((row) => ({
          id: row.id,
          title: row.title,
          employer: row.employer,
          score: row.suitabilityScore,
          isTargetCompany: matcher?.matches(row.employer) ?? false,
        })),
        maxJobs,
        baseUrl,
      };
    }
    case "failed":
      return {
        kind: "failed",
        trigger: event.trigger,
        reason: event.error,
        baseUrl,
      };
    case "paused":
      return {
        kind: "paused",
        trigger: event.trigger,
        reason: event.reason,
        sources: event.sources,
        baseUrl,
      };
    case "start_failed":
      return { kind: "start_failed", reason: event.error, baseUrl };
  }
}

/**
 * Sends the digest for one event if the tenant's settings ask for it.
 * Resolves with what happened; does not throw for delivery failures.
 */
export async function sendRunDigest(
  event: RunDigestEvent,
  deps: RunDigestDeps = {},
): Promise<RunDigestOutcome> {
  const now = deps.now ?? (() => new Date());
  const tenantId = getActiveTenantId();
  const [rawMode, rawMaxJobs] = await Promise.all([
    settingsRepo.getSetting("digestMode"),
    settingsRepo.getSetting("digestMaxJobs"),
  ]);
  const mode =
    settingsRegistry.digestMode.parse(rawMode ?? undefined) ??
    settingsRegistry.digestMode.default();
  if (mode === "off") return "skipped_off";
  if (mode === "scheduled" && triggerOf(event) !== "schedule") {
    return "skipped_off";
  }

  const pipelineRunId = runIdOf(event);
  const credentials = await getTelegramCredentials();
  if (!credentials) {
    logger.debug("Run digest skipped: Telegram is not set up", {
      tenantId,
      pipelineRunId,
      kind: event.kind,
    });
    return "skipped_not_configured";
  }

  const maxJobs =
    settingsRegistry.digestMaxJobs.parse(rawMaxJobs ?? undefined) ??
    settingsRegistry.digestMaxJobs.default();
  let text: string | null;
  try {
    text = buildDigestMessage(await toMessageInput(event, maxJobs));
  } catch (error) {
    // For example a database error reading the run's jobs: shown in
    // Settings like a failed send.
    const detail = `Could not prepare the digest: ${sanitizeDigestReason(
      error instanceof Error ? error.message : String(error),
    )}`;
    logger.warn("Run digest could not be prepared", {
      tenantId,
      pipelineRunId,
      kind: event.kind,
      error: detail,
    });
    await recordDigestDelivery({
      tenantId,
      at: now().toISOString(),
      status: "failed",
      detail,
    });
    return "failed";
  }
  if (!text) return "skipped_nothing_new";

  const result = await sendTelegramMessage({
    botToken: credentials.botToken,
    chatId: credentials.chatId,
    text,
    fetchImpl: deps.fetchImpl,
    sleep: deps.sleep,
  });
  const at = now().toISOString();
  await recordDigestDelivery({
    tenantId,
    at,
    status: result.ok ? "sent" : "failed",
    detail: result.ok ? null : result.error,
  });

  if (!result.ok) {
    logger.warn("Run digest delivery failed", {
      tenantId,
      pipelineRunId,
      kind: event.kind,
      status: result.status,
      error: result.error,
    });
    return "failed";
  }
  logger.info("Run digest sent", {
    tenantId,
    pipelineRunId,
    kind: event.kind,
  });
  return "sent";
}

/**
 * Starts sending the digest in the background and returns immediately.
 * Never throws; errors are logged with the tenant, never with the token.
 */
export function queueRunDigest(
  event: RunDigestEvent,
  deps: RunDigestDeps = {},
): void {
  let tenantId: string | null = null;
  try {
    tenantId = getActiveTenantId();
    const activeTenantId = tenantId;
    void sendRunDigest(event, deps).catch(async (error: unknown) => {
      const message = sanitizeDigestReason(
        error instanceof Error ? error.message : String(error),
      );
      logger.warn("Run digest failed", {
        tenantId: activeTenantId,
        pipelineRunId: runIdOf(event),
        kind: event.kind,
        error: message,
      });
      // Shown in Settings like a failed send, when the database allows.
      await recordDigestDelivery({
        tenantId: activeTenantId,
        at: (deps.now ?? (() => new Date()))().toISOString(),
        status: "failed",
        detail: `Could not send the digest: ${message}`,
      }).catch(() => undefined);
    });
  } catch (error) {
    logger.warn("Run digest failed", {
      tenantId,
      pipelineRunId: runIdOf(event),
      kind: event.kind,
      error: sanitizeUnknown(
        error instanceof Error ? error.message : String(error),
      ),
    });
  }
}
