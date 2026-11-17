/**
 * Settings for callers that must never see secrets (MCP agents).
 *
 * Which settings are secret comes from the settings registry (`kind:
 * "secret"`), so a secret added to the registry later is redacted without
 * touching this file.
 */
import { getJobOpsAppConfig } from "@server/config/app-mode";
import {
  getSecretSettingsStatus,
  type SecretSettingStatus,
} from "@server/services/envSettings";
import { getEffectiveSettings } from "@server/services/settings";
import { settingsRegistry } from "@shared/settings-registry";
import type { AppSettings } from "@shared/types";

export const SECRET_SETTING_KEYS: readonly string[] = Object.entries(
  settingsRegistry,
)
  .filter(([, definition]) => definition.kind === "secret")
  .map(([key]) => key);

/**
 * True for fields of the effective settings that carry secret material: the
 * secret itself (`llmApiKey`) and its hints (`llmApiKeyHint`,
 * `llmPurposeApiKeyHints`). Hints exist only for secrets, so every
 * `...Hint`/`...Hints` field is dropped as well.
 */
export function isSecretDerivedSettingField(field: string): boolean {
  if (/Hints?$/.test(field)) return true;
  return SECRET_SETTING_KEYS.some(
    (key) => field === key || field === `${key}Hint`,
  );
}

export type RedactedSettings = {
  /** Effective settings with every secret and secret hint removed. */
  settings: Record<string, unknown>;
  /** One entry per secret-kind setting: whether it is set, never the value. */
  secrets: Record<string, SecretSettingStatus>;
};

/** Removes secrets and hints from effective settings and adds set/not-set. */
export async function redactSettings(
  effective: AppSettings,
): Promise<RedactedSettings> {
  const settings = Object.fromEntries(
    Object.entries(effective as unknown as Record<string, unknown>).filter(
      ([field]) => !isSecretDerivedSettingField(field),
    ),
  );
  const secrets = await getSecretSettingsStatus(undefined, {
    // In hosted mode the environment LLM key belongs to the platform, not
    // the user, so only the user's own keys count as set.
    allowLlmEnvironmentCredentials: getJobOpsAppConfig().appMode !== "hosted",
  });
  return { settings, secrets };
}

export async function getRedactedSettings(): Promise<RedactedSettings> {
  return redactSettings(await getEffectiveSettings());
}
