/**
 * Picks the Role CV that best fits a job, or none. Mirrors project selection:
 * a model call with a deterministic keyword fallback when the model is
 * unavailable or returns an unknown id.
 */

import { logger } from "@infra/logger";
import { isDemoMode } from "@server/config/demo";
import { stripHtmlTags } from "@shared/utils/string";
import type { JsonSchemaDefinition } from "./llm/types";
import { createConfiguredLlmService, resolveLlmModel } from "./modelSelection";

export type RoleCvMatchCandidate = {
  id: string;
  name: string;
  roleDescription: string;
  tailoredHeadline: string | null;
  tailoredSkills: string | null;
};

export type RoleCvMatchJob = {
  title: string;
  jobDescription: string | null;
};

export type RoleCvMatchResult = {
  roleCvId: string | null;
  method: "model" | "fallback";
};

const NO_MATCH = "none";

/** Keyword fallback needs at least this score to pick a Role CV. */
const FALLBACK_MIN_SCORE = 3;
const TITLE_WEIGHT = 3;

const ROLE_CV_MATCH_SCHEMA: JsonSchemaDefinition = {
  name: "role_cv_match",
  schema: {
    type: "object",
    properties: {
      roleCvId: {
        type: "string",
        description: `ID of the best-fitting Role CV, or "${NO_MATCH}" if none fits`,
      },
    },
    required: ["roleCvId"],
    additionalProperties: false,
  },
};

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "our",
  "the",
  "this",
  "to",
  "we",
  "will",
  "with",
  "you",
  "your",
  "role",
  "team",
  "work",
  "job",
  "experience",
  "years",
  "senior",
  "junior",
  "mid",
  "lead",
]);

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9+#]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    tokens.add(raw);
  }
  return tokens;
}

function skillKeywords(raw: string | null): string {
  if (!raw?.trim()) return "";
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return "";
    return parsed
      .flatMap((group) => {
        if (!group || typeof group !== "object") return [];
        const record = group as Record<string, unknown>;
        const keywords = Array.isArray(record.keywords) ? record.keywords : [];
        return [record.name, ...keywords].filter(
          (value): value is string => typeof value === "string",
        );
      })
      .join(" ");
  } catch {
    return "";
  }
}

function countOverlap(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const token of a) {
    if (b.has(token)) count += 1;
  }
  return count;
}

/**
 * Deterministic keyword scoring. Title words count extra on both sides.
 * Returns null when no Role CV reaches the minimum score.
 */
export function fallbackPickRoleCvId(
  job: RoleCvMatchJob,
  roleCvs: RoleCvMatchCandidate[],
): string | null {
  const jobTitleTokens = tokenize(job.title);
  const jobTokens = tokenize(
    `${job.title} ${stripHtmlTags(job.jobDescription ?? "")}`,
  );

  let best: { id: string; score: number } | null = null;
  for (const roleCv of roleCvs) {
    const titleTokens = tokenize(
      `${roleCv.name} ${roleCv.tailoredHeadline ?? ""}`,
    );
    const allTokens = tokenize(
      [
        roleCv.name,
        roleCv.tailoredHeadline ?? "",
        roleCv.roleDescription,
        skillKeywords(roleCv.tailoredSkills),
      ].join(" "),
    );
    const score =
      TITLE_WEIGHT * countOverlap(titleTokens, jobTitleTokens) +
      countOverlap(allTokens, jobTokens);
    if (!best || score > best.score) {
      best = { id: roleCv.id, score };
    }
  }

  return best && best.score >= FALLBACK_MIN_SCORE ? best.id : null;
}

function truncate(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `${input.slice(0, maxChars - 1).trimEnd()}…`;
}

function buildRoleCvMatchPrompt(
  job: RoleCvMatchJob,
  roleCvs: RoleCvMatchCandidate[],
): string {
  const candidates = roleCvs.map((roleCv) => ({
    id: roleCv.id,
    name: roleCv.name,
    headline: roleCv.tailoredHeadline ?? "",
    roleDescription: truncate(roleCv.roleDescription, 1000),
  }));

  return `
You are choosing which CV variant (Role CV) to use for a job application.

Rules:
- Pick the one Role CV whose target role best matches the job.
- Only choose an ID from the provided list.
- If none of them fits the job, answer "${NO_MATCH}".

Job title:
${job.title}

Job description:
${truncate(stripHtmlTags(job.jobDescription ?? ""), 6000)}

Role CVs (pick from these IDs only):
${JSON.stringify(candidates)}

Respond with JSON only, in this exact shape:
{
  "roleCvId": "id-or-${NO_MATCH}"
}
`.trim();
}

/**
 * Chooses the Role CV that best fits the job, or null for none. Uses the
 * project-selection model purpose. Falls back to keyword scoring when the
 * model fails or returns an id that is not a candidate. Demo mode never calls
 * a model.
 */
export async function pickRoleCvForJob(args: {
  job: RoleCvMatchJob;
  roleCvs: RoleCvMatchCandidate[];
}): Promise<RoleCvMatchResult> {
  if (args.roleCvs.length === 0) {
    return { roleCvId: null, method: "fallback" };
  }
  const fallback = (): RoleCvMatchResult => ({
    roleCvId: fallbackPickRoleCvId(args.job, args.roleCvs),
    method: "fallback",
  });
  if (isDemoMode()) return fallback();

  try {
    const [model, llm] = await Promise.all([
      resolveLlmModel("projectSelection"),
      createConfiguredLlmService("projectSelection"),
    ]);
    const result = await llm.callJson<{ roleCvId: string }>({
      model,
      messages: [
        {
          role: "user",
          content: buildRoleCvMatchPrompt(args.job, args.roleCvs),
        },
      ],
      jsonSchema: ROLE_CV_MATCH_SCHEMA,
    });
    if (!result.success) {
      logger.warn("Role CV match model call failed, using keyword fallback", {
        error: result.error,
      });
      return fallback();
    }

    const picked =
      typeof result.data?.roleCvId === "string"
        ? result.data.roleCvId.trim()
        : "";
    if (picked.toLowerCase() === NO_MATCH) {
      return { roleCvId: null, method: "model" };
    }
    if (args.roleCvs.some((roleCv) => roleCv.id === picked)) {
      return { roleCvId: picked, method: "model" };
    }
    logger.warn("Role CV match model returned an unknown id", {
      roleCvId: truncate(picked, 80),
    });
    return fallback();
  } catch (error) {
    logger.warn("Role CV match failed, using keyword fallback", { error });
    return fallback();
  }
}
