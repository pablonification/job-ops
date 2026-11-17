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

function hasSecretContent(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (value && typeof value === "object") {
    return Object.values(value).some(hasSecretContent);
  }
  return false;
}

export type SecretSettingStatus = {
  /** Whether a value is configured (stored or from the environment). */
  set: boolean;
  /** For object-valued secrets: which parts are set. */
  parts?: Record<string, boolean>;
};

/**
 * Set / not-set status for every secret-kind setting in the registry, without
 * the values. New secret settings are covered automatically.
 */
export async function getSecretSettingsStatus(
  overrides?: SettingsOverrides,
  options?: { allowLlmEnvironmentCredentials?: boolean },
): Promise<Record<string, SecretSettingStatus>> {
  const activeOverrides = overrides || (await settingsRepo.getAllSettings());
  const statuses: Record<string, SecretSettingStatus> = {};

  for (const [key, def] of Object.entries(settingsRegistry)) {
    if (def.kind !== "secret") continue;
    if ("envKey" in def && def.envKey) {
      statuses[key] = {
        set: Boolean(
          resolveEffectiveSecretValue(
            key,
            def.envKey,
            activeOverrides,
            options,
          ),
        ),
      };
      continue;
    }

    const parsed: unknown =
      "parse" in def && typeof def.parse === "function"
        ? def.parse(activeOverrides[key as SettingKey])
        : (activeOverrides[key as SettingKey] ?? null);
    const status: SecretSettingStatus = { set: hasSecretContent(parsed) };
    if (parsed && typeof parsed === "object") {
      status.parts = Object.fromEntries(
        Object.entries(parsed).map(([part, value]) => [
          part,
          hasSecretContent(value),
        ]),
      );
    }
    statuses[key] = status;
  }

  return statuses;
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
