import { serviceUnavailable } from "@infra/errors";
import { logger } from "@infra/logger";
import { getRequestContext } from "@infra/request-context";
import { sanitizeUnknown } from "@infra/sanitize";
import { getJobOpsAppStatus } from "@server/config/app-mode";
import { isDemoMode } from "@server/config/demo";
import { MCP_PATH } from "@server/mcp/endpoint";
import { defineTool, defineToolGroup } from "@server/mcp/kit";
import { getPipelineStatus, getProgress } from "@server/pipeline/index";
import * as pipelineRepo from "@server/repositories/pipeline";
import { getDesignResumeStatus } from "@server/services/design-resume";
import { getProfile } from "@server/services/profile";
import { extractProjectsFromProfile } from "@server/services/resumeProjects";
import { getConfiguredRxResumeBaseResumeId } from "@server/services/rxresume/baseResumeId";
import type { ResumeProfile } from "@shared/types";
import { stripHtmlTags } from "@shared/utils/string";
import { z } from "zod";

const RECENT_RUNS_LIMIT = 5;
const SUMMARY_MAX_CHARS = 2_000;
const PROJECT_DESCRIPTION_MAX_CHARS = 300;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? stripHtmlTags(value).trim() : "";
}

async function resolveProfileSource(): Promise<
  "design_resume" | "rxresume" | null
> {
  const local = await getDesignResumeStatus();
  if (local.exists) return "design_resume";
  const { resumeId } = await getConfiguredRxResumeBaseResumeId();
  return resumeId ? "rxresume" : null;
}

/**
 * Agent-facing summary of the master resume. Contact details (email, phone,
 * photo) are left out on purpose.
 */
function summarizeProfile(profile: ResumeProfile) {
  const basics = profile.basics ?? {};
  const sections = profile.sections ?? {};
  const location = [
    basics.location?.city,
    basics.location?.region,
    basics.location?.countryCode,
  ]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(", ");
  const summary =
    cleanText(sections.summary?.content) || cleanText(basics.summary);

  return {
    name: basics.name ?? null,
    headline: basics.headline || basics.label || null,
    location: location || null,
    summary: summary ? truncate(summary, SUMMARY_MAX_CHARS) : null,
    links: (basics.profiles ?? [])
      .filter((link) => link?.url)
      .map((link) => ({ network: link.network ?? null, url: link.url })),
    skills: (sections.skills?.items ?? [])
      .filter((skill) => skill?.visible !== false)
      .map((skill) => ({
        name: skill.name,
        keywords: Array.isArray(skill.keywords) ? skill.keywords : [],
      })),
    experience: (sections.experience?.items ?? [])
      .filter((item) => item?.visible !== false)
      .map((item) => ({
        company: item.company,
        position: item.position,
        location: item.location || null,
        date: item.date || null,
      })),
    projects: extractProjectsFromProfile(profile).catalog.map((project) => ({
      id: project.id,
      name: project.name,
      date: project.date || null,
      visibleInBaseResume: project.isVisibleInBase,
      description: truncate(project.description, PROJECT_DESCRIPTION_MAX_CHARS),
    })),
  };
}

const getPipelineStatusTool = defineTool({
  name: "get_pipeline_status",
  title: "Get pipeline status",
  description:
    "Whether a job discovery pipeline run is active, its current step and counters, and the most recent runs with their results.",
  scope: "read",
  input: z.object({}).strict(),
  handler: async () => {
    const { isRunning } = getPipelineStatus();
    // The config snapshot is large and rarely useful to an agent.
    const recentRuns = (
      await pipelineRepo.getRecentPipelineRuns(RECENT_RUNS_LIMIT)
    ).map(({ configSnapshot: _configSnapshot, ...run }) => run);
    return {
      isRunning,
      progress: getProgress(),
      lastRun: recentRuns[0] ?? null,
      recentRuns,
    };
  },
});

const getProfileTool = defineTool({
  name: "get_profile",
  title: "Get master resume summary",
  description:
    "Summary of the user's master resume: name, headline, location, summary, skills, experience and the project catalog (project ids are used by tailoring). Contact details are omitted.",
  scope: "read",
  input: z.object({}).strict(),
  handler: async () => {
    const source = await resolveProfileSource();
    if (!source) {
      return {
        configured: false,
        source: null,
        message:
          "No master resume yet. Create one in Design Resume or select a Reactive Resume base resume in Settings.",
      };
    }
    let profile: ResumeProfile;
    try {
      profile = await getProfile();
    } catch (error) {
      logger.warn("MCP get_profile could not load the master resume", {
        source,
        error: sanitizeUnknown(error),
      });
      throw serviceUnavailable(
        "Could not load the master resume. Check the resume settings in JobOps.",
      );
    }
    return { configured: true, source, profile: summarizeProfile(profile) };
  },
});

function resolveAppVersion(): string | null {
  const version =
    process.env.JOBOPS_APP_VERSION?.trim() ||
    process.env.npm_package_version?.trim();
  return version || null;
}

const getAppStatusTool = defineTool({
  name: "get_app_status",
  title: "Get JobOps status",
  description:
    "JobOps instance and session status: app mode and version, who the token acts as and its scope, whether a master resume is set up, and whether a pipeline run is active.",
  scope: "read",
  input: z.object({}).strict(),
  handler: async (_input, context) => {
    const requestContext = getRequestContext();
    const appStatus = getJobOpsAppStatus();
    const profileSource = await resolveProfileSource();
    return {
      app: {
        name: "JobOps",
        version: resolveAppVersion(),
        mode: appStatus.appMode,
        demoMode: isDemoMode(),
        capabilities: appStatus.capabilities,
      },
      caller: {
        username: requestContext?.username ?? null,
        isSystemAdmin: requestContext?.isSystemAdmin === true,
        authMethod: requestContext?.authMethod ?? null,
        scope: context.scope,
      },
      profile: { configured: profileSource !== null, source: profileSource },
      pipeline: { isRunning: getPipelineStatus().isRunning },
      mcpUrl: context.requestOrigin
        ? `${context.requestOrigin}${MCP_PATH}`
        : null,
    };
  },
});

export const appReadToolGroup = defineToolGroup({
  id: "app-read",
  tools: [getPipelineStatusTool, getProfileTool, getAppStatusTool],
});
