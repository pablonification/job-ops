import { badRequest } from "@infra/errors";
import { defineTool, defineToolGroup } from "@server/mcp/kit";
import { updateSettingsForCaller } from "@server/services/settings-edit";
import {
  getRedactedSettings,
  isSecretDerivedSettingField,
  redactSettings,
  SECRET_SETTING_KEYS,
} from "@server/services/settings-redaction";
import {
  getWatchlistSources,
  replaceWatchlistSources,
  updateWatchlistSelectionsSchema,
} from "@server/watchlist/selections";
import { settingsRegistry } from "@shared/settings-registry";
import { updateSettingsSchema } from "@shared/settings-schema";
import { z } from "zod";

const SETTING_KEYS = Object.keys(settingsRegistry);

function pick<T>(source: Record<string, T>, keys: readonly string[]) {
  return Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(source, key))
      .map((key) => [key, source[key]]),
  );
}

const getSettingsTool = defineTool({
  name: "get_settings",
  title: "Get settings",
  description:
    "The user's JobOps settings: search terms and locations, per-source limits, scoring and tailoring options, LLM provider and models, and more. Most entries are { value, default, override }. Secret values (API keys, passwords, tokens) are never returned; the secrets field says only whether each one is set.",
  scope: "read",
  maxResultSizeChars: 200_000,
  input: z
    .object({
      keys: z
        .array(z.string().trim().min(1).max(100))
        .max(200)
        .optional()
        .describe(
          "Only these setting keys, e.g. ['searchTerms', 'llmProvider']. Default: all.",
        ),
    })
    .strict(),
  handler: async ({ keys }) => {
    const { settings, secrets } = await getRedactedSettings();
    if (!keys) return { settings, secrets };
    return { settings: pick(settings, keys), secrets: pick(secrets, keys) };
  },
});

const updateSettingsTool = defineTool({
  name: "update_settings",
  title: "Update settings",
  description:
    "Change settings, e.g. { updates: { searchTerms: ['backend engineer'], searchCities: 'Jakarta' } }. Same validation and permissions as the Settings page: users who are not system admins may change only search settings. Set a key to null to reset it to the default. Secret values can be written but are never returned.",
  scope: "write",
  idempotent: true,
  input: z
    .object({
      updates: z
        .record(z.string(), z.unknown())
        .refine((value) => Object.keys(value).length > 0, {
          message: "Provide at least one setting to change",
        })
        .describe(
          "Setting key to new value. Keys are the ones get_settings returns.",
        ),
    })
    .strict(),
  handler: async ({ updates }) => {
    const unknownKeys = Object.keys(updates).filter(
      (key) => !SETTING_KEYS.includes(key),
    );
    if (unknownKeys.length > 0) {
      throw badRequest(`Unknown setting keys: ${unknownKeys.join(", ")}`, {
        unknownKeys,
      });
    }
    const input = updateSettingsSchema.parse(updates);
    const { settings, updatedSettingKeys } = await updateSettingsForCaller(
      input,
      { route: "MCP update_settings" },
    );
    const redacted = await redactSettings(settings);
    const requestedKeys = Object.keys(updates);
    return {
      updatedSettingKeys,
      settings: pick(
        redacted.settings,
        requestedKeys.filter((key) => !isSecretDerivedSettingField(key)),
      ),
      secrets: pick(
        redacted.secrets,
        requestedKeys.filter((key) => SECRET_SETTING_KEYS.includes(key)),
      ),
    };
  },
});

const getWatchlistSourcesTool = defineTool({
  name: "get_watchlist_sources",
  title: "Get Watchlist sources",
  description:
    "Company career pages the Watchlist checks for new jobs: the user's selected sources, the built-in catalog of companies, and the source types that accept custom URLs.",
  scope: "read",
  input: z.object({}).strict(),
  handler: async () => ({ ...(await getWatchlistSources()) }),
});

const setWatchlistSourcesTool = defineTool({
  name: "set_watchlist_sources",
  title: "Replace Watchlist sources",
  description:
    "Replace the full list of Watchlist sources. Pass every source to keep: catalog entries as { catalogSourceId, sourceType, careersUrl } copied from get_watchlist_sources, custom pages as { sourceType, careersUrl, label? }. Sources left out are removed.",
  scope: "write",
  destructive: true,
  idempotent: true,
  openWorld: true,
  input: updateWatchlistSelectionsSchema.strict(),
  handler: async ({ selections }) => ({
    ...(await replaceWatchlistSources(selections)),
  }),
});

export const settingsToolGroup = defineToolGroup({
  id: "settings",
  tools: [
    getSettingsTool,
    updateSettingsTool,
    getWatchlistSourcesTool,
    setWatchlistSourcesTool,
  ],
});
