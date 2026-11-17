import type { IdBigTechCompanyId } from "@shared/extractors/indonesia/big-tech.js";
import type {
  ChatStyleLanguageMode,
  ChatStyleManualLanguage,
  LlmFallbackStatus,
  LlmPurposeApiKeyHints,
  LlmPurposeOverrides,
  RoleCvPipelineMode,
} from "@shared/types.js";

export type EffectiveDefault<T> = {
  effective: T;
  default: T;
};

export type ModelValues = EffectiveDefault<string> & {
  scorer: string;
  tailoring: string;
  projectSelection: string;
  llmProvider: string;
  llmBaseUrl: string;
  llmApiKeyHint: string | null;
  llmPurposeOverrides: LlmPurposeOverrides;
  llmPurposeApiKeyHints: LlmPurposeApiKeyHints;
  llmFallback: LlmFallbackStatus | null;
};

export type WebhookValues = EffectiveDefault<string>;
export type DisplayValues = {
  showSponsorInfo: EffectiveDefault<boolean>;
  renderMarkdownInJobDescriptions: EffectiveDefault<boolean>;
  autoTailorOnManualImport: EffectiveDefault<boolean>;
  roleCvPipelineMode: EffectiveDefault<RoleCvPipelineMode>;
};
export type ChatValues = {
  tone: EffectiveDefault<string>;
  formality: EffectiveDefault<string>;
  constraints: EffectiveDefault<string>;
  doNotUse: EffectiveDefault<string>;
  languageMode: EffectiveDefault<ChatStyleLanguageMode>;
  manualLanguage: EffectiveDefault<ChatStyleManualLanguage>;
  stopSlopEnabled: EffectiveDefault<boolean>;
  summaryMaxWords: EffectiveDefault<number | null>;
  maxKeywordsPerSkill: EffectiveDefault<number | null>;
};

export type EnvSettingsValues = {
  readable: {
    ukvisajobsEmail: string;
    adzunaAppId: string;
  };
  private: {
    ukvisajobsPasswordHint: string | null;
    adzunaAppKeyHint: string | null;
    webhookSecretHint: string | null;
  };
};

export type SourceSettingsValues = {
  idbigtechCompanies: EffectiveDefault<IdBigTechCompanyId[]>;
};

export type BackupValues = {
  backupEnabled: EffectiveDefault<boolean>;
  backupHour: EffectiveDefault<number>;
  backupMaxCount: EffectiveDefault<number>;
};

export type ScoringValues = {
  penalizeMissingSalary: EffectiveDefault<boolean>;
  missingSalaryPenalty: EffectiveDefault<number>;
  autoSkipScoreThreshold: EffectiveDefault<number | null>;
  blockedCompanyKeywords: EffectiveDefault<string[]>;
  targetCompanies: EffectiveDefault<string[]>;
  dealbreakers: EffectiveDefault<string>;
};

export type PromptTemplatesValues = {
  ghostwriterSystemPromptTemplate: EffectiveDefault<string>;
  tailoringPromptTemplate: EffectiveDefault<string>;
  roleCvPromptTemplate: EffectiveDefault<string>;
  scoringPromptTemplate: EffectiveDefault<string>;
};
