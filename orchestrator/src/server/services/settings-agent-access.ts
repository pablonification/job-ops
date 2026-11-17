/**
 * What an agent (MCP access token) may see and change in the settings.
 *
 * Every registry setting is classified here. Anything not classified, and
 * every `kind: "secret"` setting whatever its entry says, is hidden (set /
 * not set only) and web-app only, so a setting added to the registry later
 * stays hidden until someone classifies it.
 *
 * Agents read untrusted text (job descriptions, fetched pages, emails), so
 * settings that decide where data goes or hold credentials stay web-only:
 * LLM provider and endpoints, webhooks, Reactive Resume connection, source
 * logins and backups.
 */
import { getJobOpsAppConfig } from "@server/config/app-mode";
import {
  getSettingsPresence,
  type SettingPresence,
} from "@server/services/envSettings";
import { getEffectiveSettings } from "@server/services/settings";
import {
  type SettingsRegistryKey,
  settingsRegistry,
} from "@shared/settings-registry";
import type { AppSettings } from "@shared/types";

/**
 * - `visible`: the value as stored.
 * - `url`: URLs without user info, query string or fragment.
 * - `host`: only the host of each URL (webhook URLs carry their own secret).
 * - `hidden`: only whether it is set.
 */
export type AgentSettingRead = "visible" | "url" | "host" | "hidden";

export type AgentSettingPolicy = {
  read: AgentSettingRead;
  /** Whether `update_settings` over MCP may change it. */
  agentEditable: boolean;
};

const AGENT_EDITABLE: AgentSettingPolicy = {
  read: "visible",
  agentEditable: true,
};
const VISIBLE_WEB_ONLY: AgentSettingPolicy = {
  read: "visible",
  agentEditable: false,
};
const URL_WEB_ONLY: AgentSettingPolicy = { read: "url", agentEditable: false };
const HOST_WEB_ONLY: AgentSettingPolicy = {
  read: "host",
  agentEditable: false,
};
const HIDDEN_WEB_ONLY: AgentSettingPolicy = {
  read: "hidden",
  agentEditable: false,
};

/** Explicit classification of every non-secret registry setting. */
export const AGENT_SETTING_POLICIES: Partial<
  Record<SettingsRegistryKey, AgentSettingPolicy>
> = {
  // LLM: models are preferences; provider and endpoints decide where the
  // resume is sent.
  model: AGENT_EDITABLE,
  modelScorer: AGENT_EDITABLE,
  modelTailoring: AGENT_EDITABLE,
  modelProjectSelection: AGENT_EDITABLE,
  llmProvider: VISIBLE_WEB_ONLY,
  llmBaseUrl: URL_WEB_ONLY,
  llmPurposeOverrides: URL_WEB_ONLY,

  // Webhooks: the URL is the credential.
  pipelineWebhookUrl: HOST_WEB_ONLY,
  jobCompleteWebhookUrl: HOST_WEB_ONLY,

  // Reactive Resume connection and source logins.
  rxresumeUrl: URL_WEB_ONLY,
  rxresumeBaseResumeId: VISIBLE_WEB_ONLY,
  ukvisajobsEmail: HIDDEN_WEB_ONLY,
  adzunaAppId: HIDDEN_WEB_ONLY,

  // Backups and app-internal onboarding state.
  backupEnabled: VISIBLE_WEB_ONLY,
  backupHour: VISIBLE_WEB_ONLY,
  backupMaxCount: VISIBLE_WEB_ONLY,
  onboardingProfileCompleted: VISIBLE_WEB_ONLY,
  onboardingLlmCompleted: VISIBLE_WEB_ONLY,
  onboardingResumeConfirmedSource: VISIBLE_WEB_ONLY,
  onboardingLegacyMigrationPending: VISIBLE_WEB_ONLY,

  // Search.
  searchTerms: AGENT_EDITABLE,
  workplaceTypes: AGENT_EDITABLE,
  searchCities: AGENT_EDITABLE,
  jobspyLocation: AGENT_EDITABLE,
  locationSearchMode: AGENT_EDITABLE,
  locationLatitude: AGENT_EDITABLE,
  locationLongitude: AGENT_EDITABLE,
  locationRadiusMiles: AGENT_EDITABLE,
  locationSearchScope: AGENT_EDITABLE,
  locationMatchStrictness: AGENT_EDITABLE,
  jobspyResultsWanted: AGENT_EDITABLE,
  jobspyCountryIndeed: AGENT_EDITABLE,
  ukvisajobsMaxJobs: AGENT_EDITABLE,
  adzunaMaxJobsPerTerm: AGENT_EDITABLE,
  gradcrackerMaxJobsPerTerm: AGENT_EDITABLE,
  startupjobsMaxJobsPerTerm: AGENT_EDITABLE,
  seekMaxJobsPerTerm: AGENT_EDITABLE,
  naukriMaxJobsPerTerm: AGENT_EDITABLE,
  jobindexMaxJobsPerTerm: AGENT_EDITABLE,
  blockedCompanyKeywords: AGENT_EDITABLE,

  // Scoring.
  scoringInstructions: AGENT_EDITABLE,
  penalizeMissingSalary: AGENT_EDITABLE,
  missingSalaryPenalty: AGENT_EDITABLE,
  autoSkipScoreThreshold: AGENT_EDITABLE,

  // Tailoring, prompts and writing style.
  resumeProjects: AGENT_EDITABLE,
  autoTailorOnManualImport: AGENT_EDITABLE,
  scoringPromptTemplate: AGENT_EDITABLE,
  tailoringPromptTemplate: AGENT_EDITABLE,
  roleCvPromptTemplate: AGENT_EDITABLE,
  ghostwriterSystemPromptTemplate: AGENT_EDITABLE,
  ghostwriterStopSlopEnabled: AGENT_EDITABLE,
  chatStyleTone: AGENT_EDITABLE,
  chatStyleFormality: AGENT_EDITABLE,
  chatStyleConstraints: AGENT_EDITABLE,
  chatStyleDoNotUse: AGENT_EDITABLE,
  chatStyleSummaryMaxWords: AGENT_EDITABLE,
  chatStyleMaxKeywordsPerSkill: AGENT_EDITABLE,
  chatStyleLanguageMode: AGENT_EDITABLE,
  chatStyleManualLanguage: AGENT_EDITABLE,

  // PDF and display.
  pdfRenderer: AGENT_EDITABLE,
  typstTheme: AGENT_EDITABLE,
  pdfPaperSize: AGENT_EDITABLE,
  showSponsorInfo: AGENT_EDITABLE,
  renderMarkdownInJobDescriptions: AGENT_EDITABLE,
};

/** Effective-settings fields that are not registry settings but are safe. */
const AGENT_VISIBLE_DERIVED_FIELDS = ["profileProjects"] as const;

function isRegistryKey(key: string): key is SettingsRegistryKey {
  return Object.hasOwn(settingsRegistry, key);
}

/** True when the setting has its own entry (secrets count as classified). */
export function isAgentSettingClassified(key: string): boolean {
  if (!isRegistryKey(key)) return false;
  return (
    settingsRegistry[key].kind === "secret" ||
    AGENT_SETTING_POLICIES[key] !== undefined
  );
}

export function getAgentSettingPolicy(key: string): AgentSettingPolicy {
  if (!isRegistryKey(key) || settingsRegistry[key].kind === "secret") {
    return HIDDEN_WEB_ONLY;
  }
  return AGENT_SETTING_POLICIES[key] ?? HIDDEN_WEB_ONLY;
}

export function listAgentWebOnlySettings(): string[] {
  return Object.keys(settingsRegistry)
    .filter((key) => !getAgentSettingPolicy(key).agentEditable)
    .sort();
}

const REDACTED = "[redacted]";

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Drops user info, query string and fragment from URL-looking strings. */
function stripUrl(value: string): string {
  if (!value.includes("://")) {
    // Not a URL; anything that could carry credentials is withheld.
    return /[@?#]/.test(value) ? REDACTED : value;
  }
  const url = parseUrl(value);
  if (!url) return REDACTED;
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function hostOnly(value: string): string {
  if (!value.trim()) return value;
  return parseUrl(value)?.host || REDACTED;
}

function mapStrings(value: unknown, map: (input: string) => string): unknown {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, map));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mapStrings(item, map)]),
    );
  }
  return value;
}

export type AgentSettingsView = {
  /** Visible settings, and reduced ones (see `reduced`). */
  settings: Record<string, unknown>;
  /** Settings shown in reduced form: URLs stripped, or webhook hosts only. */
  reduced: string[];
  /** Settings shown only as set / not set (credentials, logins, secrets). */
  hidden: Record<string, SettingPresence>;
  /** Settings the agent cannot change; they are changed in the web app. */
  webOnly: string[];
};

/** Builds the agent view of already-resolved effective settings. */
export async function toAgentSettingsView(
  effective: AppSettings,
): Promise<AgentSettingsView> {
  const source = effective as unknown as Record<string, unknown>;
  const settings: Record<string, unknown> = {};
  const reduced: string[] = [];
  const hiddenKeys: string[] = [];

  for (const key of Object.keys(settingsRegistry)) {
    const { read } = getAgentSettingPolicy(key);
    if (read === "hidden") {
      hiddenKeys.push(key);
      continue;
    }
    if (!Object.hasOwn(source, key)) continue;
    if (read === "visible") {
      settings[key] = source[key];
    } else {
      settings[key] = mapStrings(
        source[key],
        read === "host" ? hostOnly : stripUrl,
      );
      reduced.push(key);
    }
  }
  for (const field of AGENT_VISIBLE_DERIVED_FIELDS) {
    if (Object.hasOwn(source, field)) settings[field] = source[field];
  }

  const hidden = await getSettingsPresence(hiddenKeys, undefined, {
    // In hosted mode the environment LLM key belongs to the platform, not
    // the user, so only the user's own keys count as set.
    allowLlmEnvironmentCredentials: getJobOpsAppConfig().appMode !== "hosted",
  });
  return { settings, reduced, hidden, webOnly: listAgentWebOnlySettings() };
}

export async function getAgentSettingsView(): Promise<AgentSettingsView> {
  return toAgentSettingsView(await getEffectiveSettings());
}
