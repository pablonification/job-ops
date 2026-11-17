import { AppError, badRequest } from "@infra/errors";
import { defineTool, defineToolGroup } from "@server/mcp/kit";
import {
  type AgentSettingsView,
  getAgentSettingPolicy,
  getAgentSettingsView,
  toAgentSettingsView,
} from "@server/services/settings-agent-access";
import { updateSettingsForCaller } from "@server/services/settings-edit";
import {
  getWatchlistSources,
  replaceWatchlistSources,
  updateWatchlistSelectionsSchema,
} from "@server/watchlist/selections";
import { settingsRegistry } from "@shared/settings-registry";
import { updateSettingsSchema } from "@shared/settings-schema";
import { z } from "zod";

function pick<T>(source: Record<string, T>, keys: readonly string[]) {
  return Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(source, key))
      .map((key) => [key, source[key]]),
  );
}

function pickView(view: AgentSettingsView, keys: readonly string[]) {
  return {
    settings: pick(view.settings, keys),
    reduced: view.reduced.filter((key) => keys.includes(key)),
    hidden: pick(view.hidden, keys),
    webOnly: view.webOnly.filter((key) => keys.includes(key)),
  };
}

const getSettingsTool = defineTool({
  name: "get_settings",
  title: "Get settings",
  description:
    "The user's JobOps settings: search terms and locations, per-source limits, scoring and tailoring options, prompt templates, models and more; most entries are { value, default, override }. Credentials are never returned: secrets and logins appear in hidden as set / not set, URLs lose user info and query strings, webhook URLs show only their host. webOnly lists settings only the web app can change.",
  scope: "read",
  maxResultSizeChars: 200_000,
  input: z
    .object({
      keys: z
        .array(z.string().trim().min(1).max(100))
        .max(200)
        .optional()
        .describe(
          "Only these setting keys, e.g. ['searchTerms', 'scoringInstructions']. Default: all.",
        ),
    })
    .strict(),
  handler: async ({ keys }) => {
    const view = await getAgentSettingsView();
    return keys ? pickView(view, keys) : view;
  },
});

const updateSettingsTool = defineTool({
  name: "update_settings",
  title: "Update settings",
  description:
    "Change settings, e.g. { updates: { searchTerms: ['backend engineer'], searchCities: 'Jakarta' } }. Agents may change search, scoring, tailoring, prompt, model and display settings; credentials, the LLM provider and endpoints, webhooks, Reactive Resume connection and backups (get_settings webOnly) are refused with FORBIDDEN and must be changed in the web app. Users who are not system admins may change only search settings. null resets a setting to its default.",
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
    const requestedKeys = Object.keys(updates);
    const unknownKeys = requestedKeys.filter(
      (key) => !Object.hasOwn(settingsRegistry, key),
    );
    if (unknownKeys.length > 0) {
      throw badRequest(`Unknown setting keys: ${unknownKeys.join(", ")}`, {
        unknownKeys,
      });
    }
    const webOnlyKeys = requestedKeys.filter(
      (key) => !getAgentSettingPolicy(key).agentEditable,
    );
    if (webOnlyKeys.length > 0) {
      throw new AppError({
        status: 403,
        code: "FORBIDDEN",
        message: `${webOnlyKeys.join(", ")} can only be changed in the JobOps web app (Settings page), not by an agent. Agents cannot change credentials, the LLM provider or endpoints, webhooks, the Reactive Resume connection or backups.`,
        details: { settings: webOnlyKeys },
      });
    }

    const input = updateSettingsSchema.parse(updates);
    const { settings, updatedSettingKeys } = await updateSettingsForCaller(
      input,
      { route: "MCP update_settings" },
    );
    const view = await toAgentSettingsView(settings);
    return {
      updatedSettingKeys,
      settings: pick(view.settings, requestedKeys),
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
