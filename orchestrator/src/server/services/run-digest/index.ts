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
import { buildDigestMessage, type DigestMessageInput } from "./format";
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
};

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
      const matcher = rows.length > 0 ? await loadTargetCompanyMatcher() : null;
      return {
        kind: "completed",
        trigger: event.trigger,
        counts: {
          found: event.jobsFound,
          new: rows.length,
          scored: event.jobsScored,
          tailored: event.jobsTailored,
        },
        jobs: rows.map((row) => ({
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

  const credentials = await getTelegramCredentials();
  if (!credentials) {
    logger.debug("Run digest skipped: Telegram is not set up", {
      tenantId,
      kind: event.kind,
    });
    return "skipped_not_configured";
  }

  const maxJobs =
    settingsRegistry.digestMaxJobs.parse(rawMaxJobs ?? undefined) ??
    settingsRegistry.digestMaxJobs.default();
  const text = buildDigestMessage(await toMessageInput(event, maxJobs));
  if (!text) return "skipped_nothing_new";

  const result = await sendTelegramMessage({
    botToken: credentials.botToken,
    chatId: credentials.chatId,
    text,
    fetchImpl: deps.fetchImpl,
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
      kind: event.kind,
      status: result.status,
      error: result.error,
    });
    return "failed";
  }
  logger.info("Run digest sent", { tenantId, kind: event.kind });
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
    void sendRunDigest(event, deps).catch((error: unknown) => {
      logger.warn("Run digest failed", {
        tenantId,
        kind: event.kind,
        error: sanitizeUnknown(
          error instanceof Error ? error.message : String(error),
        ),
      });
    });
  } catch (error) {
    logger.warn("Run digest failed", {
      tenantId,
      kind: event.kind,
      error: sanitizeUnknown(
        error instanceof Error ? error.message : String(error),
      ),
    });
  }
}
