import type { SettingKey } from "@server/repositories/settings";
import * as settingsRepo from "@server/repositories/settings";
import { resolveLlmApiKey } from "@server/services/llm/credentials";
import { settingsRegistry } from "@shared/settings-registry";
import type { AppSettings } from "@shared/types";

const envDefaults: Record<string, string | undefined> = { ...process.env };

export function getOriginalEnvValue(envKey: string): string | undefined {
  const live = process.env[envKey];
  if (live !== undefined) return live;
  return envDefaults[envKey];
}

export function normalizeEnvInput(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function applyStoredEnvOverrides(): Promise<void> {
  // Settings are tenant-scoped. Applying stored overrides to process.env would
  // leak one tenant's credentials into every other tenant in this Node process.
}

type SettingsOverrides = Partial<Record<SettingKey, string>>;

/**
 * Effective value of an env-backed secret setting: the stored override, else
 * the environment (for the LLM key, the provider-specific fallbacks too).
 */
function resolveEffectiveSecretValue(
  key: string,
  envKey: string,
  activeOverrides: SettingsOverrides,
  options?: { allowLlmEnvironmentCredentials?: boolean },
): string | null {
  const override = activeOverrides[key as SettingKey] ?? null;
  if (key === "llmApiKey") {
    return resolveLlmApiKey({
      storedApiKey: override,
      provider:
        normalizeEnvInput(
          activeOverrides.llmProvider ?? getOriginalEnvValue("LLM_PROVIDER"),
        ) ?? null,
      allowEnvironmentCredentials: options?.allowLlmEnvironmentCredentials,
    });
  }
  return normalizeEnvInput(override ?? getOriginalEnvValue(envKey));
}

export function hasSettingContent(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (value && typeof value === "object") {
    return Object.values(value).some(hasSettingContent);
  }
  return false;
}

export type SettingPresence = {
  /** Whether a value is configured (stored or from the environment). */
  set: boolean;
  /** For object-valued settings: which parts are set. */
  parts?: Record<string, boolean>;
};

function toPresence(value: unknown): SettingPresence {
  const presence: SettingPresence = { set: hasSettingContent(value) };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    presence.parts = Object.fromEntries(
      Object.entries(value).map(([part, partValue]) => [
        part,
        hasSettingContent(partValue),
      ]),
    );
  }
  return presence;
}

/**
 * Set / not-set status of the given settings, never their values. Uses each
 * registry entry's own storage rules: the stored override, else the
 * environment variable for env-backed settings (and the provider-specific
 * fallbacks for the LLM key). Unknown keys are left out.
 */
export async function getSettingsPresence(
  keys: readonly string[],
  overrides?: SettingsOverrides,
  options?: { allowLlmEnvironmentCredentials?: boolean },
): Promise<Record<string, SettingPresence>> {
  const activeOverrides = overrides || (await settingsRepo.getAllSettings());
  const statuses: Record<string, SettingPresence> = {};

  for (const key of keys) {
    if (!Object.hasOwn(settingsRegistry, key)) continue;
    const def = settingsRegistry[key as keyof typeof settingsRegistry];
    const override = activeOverrides[key as SettingKey];
    if ("envKey" in def && def.envKey) {
      statuses[key] = {
        set: Boolean(
          def.kind === "secret"
            ? resolveEffectiveSecretValue(
                key,
                def.envKey,
                activeOverrides,
                options,
              )
            : normalizeEnvInput(override ?? getOriginalEnvValue(def.envKey)),
        ),
      };
      continue;
    }
    statuses[key] = toPresence(
      "parse" in def && typeof def.parse === "function"
        ? (def.parse as (raw: string | undefined) => unknown)(override)
        : (override ?? null),
    );
  }

  return statuses;
}

/**
 * Set / not-set status for every secret-kind setting in the registry, without
 * the values. New secret settings are covered automatically.
 */
export async function getSecretSettingsStatus(
  overrides?: SettingsOverrides,
  options?: { allowLlmEnvironmentCredentials?: boolean },
): Promise<Record<string, SettingPresence>> {
  const secretKeys = Object.entries(settingsRegistry)
    .filter(([, def]) => def.kind === "secret")
    .map(([key]) => key);
  return getSettingsPresence(secretKeys, overrides, options);
}

export async function getEnvSettingsData(
  overrides?: SettingsOverrides,
  options?: { allowLlmEnvironmentCredentials?: boolean },
): Promise<Partial<AppSettings>> {
  const activeOverrides = overrides || (await settingsRepo.getAllSettings());
  const values: Partial<AppSettings> = {};

  for (const [key, def] of Object.entries(settingsRegistry)) {
    if (def.kind === "typed") continue;
    if (!("envKey" in def) || !def.envKey) continue;

    const override = activeOverrides[key as SettingKey] ?? null;
    const rawValue = override ?? getOriginalEnvValue(def.envKey);

    if (def.kind === "secret") {
      const hintKey = `${key}Hint` as keyof AppSettings;
      const effectiveSecret = resolveEffectiveSecretValue(
        key,
        def.envKey,
        activeOverrides,
        options,
      );
      if (!effectiveSecret) {
        // biome-ignore lint/suspicious/noExplicitAny: explicit partial assignment
        (values as any)[hintKey] = null;
        continue;
      }
      const hintLength =
        effectiveSecret.length > 4
          ? 4
          : Math.max(effectiveSecret.length - 1, 1);
      // biome-ignore lint/suspicious/noExplicitAny: explicit partial assignment
      (values as any)[hintKey] = effectiveSecret.slice(0, hintLength);
    } else {
      // biome-ignore lint/suspicious/noExplicitAny: explicit partial assignment
      (values as any)[key] = normalizeEnvInput(rawValue);
    }
  }

  return values;
}
