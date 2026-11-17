/**
 * Settings edits made by the current caller: permission rules, validation,
 * save and follow-up work. Shared by `PATCH /api/settings` and the MCP
 * `update_settings` tool so both enforce exactly the same rules.
 */
import {
  AppError,
  badRequest,
  forbidden,
  statusToCode,
  unauthorized,
} from "@infra/errors";
import { logger } from "@infra/logger";
import { getRequestId, getUserId, isSystemAdmin } from "@infra/request-context";
import { getJobOpsAppConfig } from "@server/config/app-mode";
import { setPipelineScheduleOwner } from "@server/repositories/pipeline-schedule";
import { getCurrentAccountEntitlements } from "@server/services/account-entitlements";
import { enqueueAutoPdfRegenerationForSettingsChanges } from "@server/services/auto-pdf-regeneration";
import { setBackupSettings } from "@server/services/backup/index";
import { isHostedLocalProvider } from "@server/services/llm/hosted-policy";
import { clearProfileCache } from "@server/services/profile";
import {
  clearRxResumeResumeCache,
  validateCredentials as validateRxResumeCredentials,
} from "@server/services/rxresume";
import { getEffectiveSettings } from "@server/services/settings";
import { applySettingsUpdates } from "@server/services/settings-update";
import { getActiveTenantId } from "@server/tenancy/context";
import { mapGlmProviderAlias } from "@shared/settings-registry";
import type { UpdateSettingsInput } from "@shared/settings-schema";
import type { AppSettings } from "@shared/types";

const RXRESUME_SAVE_VALIDATION_KEYS: Array<keyof UpdateSettingsInput> = [
  "rxresumeUrl",
  "rxresumeApiKey",
];
const LLM_SETTING_KEYS: Array<keyof UpdateSettingsInput> = [
  "model",
  "modelScorer",
  "modelTailoring",
  "modelProjectSelection",
  "llmProvider",
  "llmBaseUrl",
  "llmApiKey",
  "llmPurposeOverrides",
  "llmPurposeApiKeys",
];
const CLI_PROVIDERS = new Set([
  "codex",
  "gemini_cli",
  "claude_cli",
  "claude_agent_sdk",
]);

// These settings describe an individual search run. They are persisted in the
// settings repository for extractor compatibility, but are not server-level
// maintenance settings and must remain editable by authenticated non-admins.
export const NON_ADMIN_SEARCH_SETTING_KEYS: ReadonlySet<
  keyof UpdateSettingsInput
> = new Set<keyof UpdateSettingsInput>([
  "searchTerms",
  "workplaceTypes",
  "locationSearchScope",
  "locationMatchStrictness",
  "locationSearchMode",
  "locationLatitude",
  "locationLongitude",
  "locationRadiusMiles",
  "jobspyResultsWanted",
  "gradcrackerMaxJobsPerTerm",
  "ukvisajobsMaxJobs",
  "adzunaMaxJobsPerTerm",
  "startupjobsMaxJobsPerTerm",
  "jobindexMaxJobsPerTerm",
  "seekMaxJobsPerTerm",
  "naukriMaxJobsPerTerm",
  "jobspyCountryIndeed",
  "searchCities",
  "jobspyLocation",
  "targetCompanies",
  "dealbreakers",
]);

/**
 * Scheduled runs and the Telegram digest decide when the server does work
 * and where it sends data: admin-only (they are not in the non-admin list
 * above) and unavailable in hosted mode.
 */
export const SCHEDULE_AND_DIGEST_SETTING_KEYS: ReadonlySet<
  keyof UpdateSettingsInput
> = new Set<keyof UpdateSettingsInput>([
  "scheduleEnabled",
  "scheduleTime",
  "scheduleTimeZone",
  "scheduleWeekdays",
  "scheduleCatchUpMinutes",
  "scheduleSearchPresetId",
  "digestMode",
  "digestMaxJobs",
  "telegramBotToken",
  "telegramChatId",
]);

/** Keys that change when or as whom scheduled runs start. */
const SCHEDULE_OWNER_KEYS: ReadonlySet<keyof UpdateSettingsInput> = new Set<
  keyof UpdateSettingsInput
>([
  "scheduleEnabled",
  "scheduleTime",
  "scheduleTimeZone",
  "scheduleWeekdays",
  "scheduleCatchUpMinutes",
  "scheduleSearchPresetId",
]);

/**
 * Hosted mode has no scheduler: refuse turning scheduling or the digest on
 * there. Clearing (null) stays allowed so "reset to defaults" still works.
 */
function assertScheduleSettingsAllowed(input: UpdateSettingsInput): void {
  if (getJobOpsAppConfig().appMode !== "hosted") return;
  const setsValue = Object.entries(input).some(
    ([key, value]) =>
      SCHEDULE_AND_DIGEST_SETTING_KEYS.has(key as keyof UpdateSettingsInput) &&
      value !== null &&
      value !== undefined,
  );
  if (setsValue) {
    throw forbidden(
      "Scheduled runs and the Telegram digest are not available in hosted mode.",
    );
  }
}

/** Hosted users and system admins may edit everything. */
export function canEditAllSettings(): boolean {
  return getJobOpsAppConfig().appMode === "hosted" || isSystemAdmin();
}

/** Throws FORBIDDEN unless the caller may edit every key in `input`. */
export function assertCanEditSettings(input: UpdateSettingsInput): void {
  if (
    canEditAllSettings() ||
    Object.keys(input).every((key) =>
      NON_ADMIN_SEARCH_SETTING_KEYS.has(key as keyof UpdateSettingsInput),
    )
  ) {
    return;
  }
  throw forbidden("System admin access is required");
}

function hasInputKey<K extends keyof UpdateSettingsInput>(
  input: UpdateSettingsInput,
  key: K,
): boolean {
  return Object.hasOwn(input, key);
}

export function normalizeLlmProviderValue(
  provider: string | null | undefined,
): string | undefined {
  if (!provider) return undefined;
  const normalized = provider.trim().toLowerCase().replace(/[-.]/g, "_");
  const mapped = mapGlmProviderAlias(normalized);
  return mapped === "claude" ? "anthropic" : mapped;
}

export async function assertLlmSettingsEditable(): Promise<void> {
  if (getJobOpsAppConfig().appMode !== "hosted") return;
  if (!(await getCurrentAccountEntitlements()).userEditableLlmSettings) {
    throw forbidden("This hosted account uses the included AI provider.");
  }
}

export function assertHostedProviderAllowed(
  provider: string | null | undefined,
): void {
  if (getJobOpsAppConfig().appMode !== "hosted") return;
  if (isHostedLocalProvider(provider)) {
    throw forbidden(
      "Local LLM providers are unavailable in hosted mode. Configure a supported hosted HTTPS provider.",
    );
  }
  if (CLI_PROVIDERS.has(normalizeLlmProviderValue(provider) ?? "")) {
    throw forbidden("CLI LLM providers are unavailable in hosted mode.");
  }
}

function assertHostedBaseUrlAllowed(value: string | null | undefined): void {
  if (getJobOpsAppConfig().appMode === "hosted" && value?.trim()) {
    throw forbidden(
      "Custom LLM base URLs are unavailable in hosted mode. Use a supported provider endpoint.",
    );
  }
}

function assertHostedLlmInputAllowed(input: UpdateSettingsInput): void {
  if (getJobOpsAppConfig().appMode !== "hosted") return;
  assertHostedProviderAllowed(input.llmProvider);
  for (const override of Object.values(input.llmPurposeOverrides ?? {})) {
    assertHostedProviderAllowed(override?.provider);
    assertHostedBaseUrlAllowed(override?.baseUrl);
  }
  assertHostedBaseUrlAllowed(input.llmBaseUrl);
}

function isMissingRxResumeConfigValidationResult(input: {
  status: number;
  message: string;
}): boolean {
  return input.status === 400 && /not configured/i.test(input.message);
}

function buildRxResumeValidationOptions(
  input: UpdateSettingsInput,
): Parameters<typeof validateRxResumeCredentials>[0] {
  return {
    v5: {
      ...(hasInputKey(input, "rxresumeApiKey")
        ? { apiKey: input.rxresumeApiKey }
        : {}),
      ...(hasInputKey(input, "rxresumeUrl")
        ? { baseUrl: input.rxresumeUrl }
        : {}),
    },
  };
}

function toRxResumeValidationAppError(
  status: number,
  message: string,
): AppError {
  if (status === 401) return unauthorized(message);
  if (status === 400) return badRequest(message);
  return new AppError({ status, code: statusToCode(status), message });
}

async function validateRxResumeOnSave(
  input: UpdateSettingsInput,
  route: string,
): Promise<void> {
  if (!RXRESUME_SAVE_VALIDATION_KEYS.some((key) => hasInputKey(input, key))) {
    return;
  }
  const validation = await validateRxResumeCredentials(
    buildRxResumeValidationOptions(input),
  );
  if (validation.ok) return;

  const status = validation.status ?? 0;
  if (
    isMissingRxResumeConfigValidationResult({
      status,
      message: validation.message,
    })
  ) {
    logger.info(
      "Skipping save-time Reactive Resume validation because credentials are incomplete",
      {
        requestId: getRequestId() ?? null,
        route,
        rxresumeMode: validation.mode ?? null,
        status,
      },
    );
  } else if (status >= 400 && status < 500) {
    throw toRxResumeValidationAppError(status, validation.message);
  } else if (status === 0 || status >= 500) {
    logger.warn(
      "Reactive Resume save-time validation could not verify upstream availability",
      {
        requestId: getRequestId() ?? null,
        route,
        rxresumeMode: validation.mode ?? null,
        status,
      },
    );
  }
}

/**
 * Applies a validated settings update for the current caller and returns the
 * effective settings afterwards.
 *
 * Enforces the same rules for every entry point: non-admins outside hosted
 * mode may only change search settings, LLM settings follow the hosted
 * policy, and Reactive Resume credentials are checked before saving. Throws
 * an `AppError` (FORBIDDEN, INVALID_REQUEST, ...) when a rule fails. After
 * saving it clears affected caches, refreshes the backup schedule and queues
 * PDF regeneration for jobs the change affects.
 *
 * `input` must already be parsed with `updateSettingsSchema`.
 */
export async function updateSettingsForCaller(
  input: UpdateSettingsInput,
  options: { route: string },
): Promise<{ settings: AppSettings; updatedSettingKeys: string[] }> {
  assertCanEditSettings(input);
  assertScheduleSettingsAllowed(input);
  if (LLM_SETTING_KEYS.some((key) => hasInputKey(input, key))) {
    await assertLlmSettingsEditable();
    assertHostedLlmInputAllowed(input);
  }
  await validateRxResumeOnSave(input, options.route);

  const plan = await applySettingsUpdates(input);
  if (plan.shouldClearRxResumeCaches) {
    clearRxResumeResumeCache();
    clearProfileCache();
  }

  // Scheduled runs run as whoever last saved the schedule.
  const userId = getUserId();
  if (
    userId &&
    Object.keys(input).some((key) =>
      SCHEDULE_OWNER_KEYS.has(key as keyof UpdateSettingsInput),
    )
  ) {
    // Bookkeeping only: the settings are already saved, so a failure here
    // is logged rather than failing the request.
    await setPipelineScheduleOwner({
      tenantId: getActiveTenantId(),
      userId,
      now: new Date().toISOString(),
    }).catch((error) => {
      logger.warn("Could not record who saved the schedule", {
        route: options.route,
        error,
      });
    });
  }

  const settings = await getEffectiveSettings();
  if (plan.shouldRefreshBackupScheduler) {
    setBackupSettings({
      enabled: settings.backupEnabled.value,
      hour: settings.backupHour.value,
      maxCount: settings.backupMaxCount.value,
    });
  }

  queueMicrotask(() => {
    void enqueueAutoPdfRegenerationForSettingsChanges({
      updatedSettingKeys: plan.updatedSettingKeys,
      requestedBy: "user",
    }).catch((error) => {
      logger.warn("Failed to queue auto PDF regeneration for settings change", {
        route: options.route,
        updatedSettingKeys: plan.updatedSettingKeys,
        error,
      });
    });
  });

  return { settings, updatedSettingKeys: [...plan.updatedSettingKeys] };
}
