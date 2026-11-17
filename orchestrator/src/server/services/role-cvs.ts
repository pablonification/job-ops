/**
 * Role CVs: named CV variants for a target role, generated from the master
 * resume and stored per private data scope (tenant, plus user in hosted mode).
 *
 * Entry points meant for reuse beyond the Role CV routes:
 * - `generateRoleCvTailoring` turns a role description into tailoring content
 *   (headline, summary, skills, AI-selected projects) without touching storage.
 * - `getRoleCvTailoringContent` returns a stored Role CV's parsed tailoring
 *   content in the shape per-job tailoring and the PDF service use.
 */

import { existsSync } from "node:fs";
import {
  AppError,
  type AppErrorCode,
  badRequest,
  conflict,
  notFound,
  upstreamError,
} from "@infra/errors";
import { logger } from "@infra/logger";
import { isDemoMode } from "@server/config/demo";
import type { RoleCvRow } from "@server/repositories/role-cvs";
import * as roleCvsRepo from "@server/repositories/role-cvs";
import * as settingsRepo from "@server/repositories/settings";
import { resolveResumeProjectSelection } from "@shared/resume-projects";
import type {
  CreateRoleCvInput,
  ResumeProfile,
  RoleCv,
  RoleCvPdfFreshness,
  RoleCvSkillGroup,
  RoleCvTailoringContent,
  UpdateRoleCvInput,
} from "@shared/types";
import { getCurrentDesignResumeOrNullOnLegacy } from "./design-resume";
import { withHostedUsageReservation } from "./hosted-usage";
import { generatePdf } from "./pdf";
import {
  createJobPdfFingerprint,
  type PdfFingerprintContext,
  resolvePdfFingerprintContext,
} from "./pdf-fingerprint";
import { getTenantRoleCvPdfPath, removeStoredRoleCvPdf } from "./pdf-storage";
import { getProfile } from "./profile";
import { pickProjectIdsForJob } from "./projectSelection";
import {
  extractProjectsFromProfile,
  resolveResumeProjectsSettings,
} from "./resumeProjects";
import { getConfiguredRxResumeBaseResumeId } from "./rxresume/baseResumeId";
import { generateTailoring } from "./summary";

/** A PDF lock older than this is treated as abandoned (e.g. after a crash). */
const PDF_LOCK_STALE_MS = 10 * 60 * 1000;

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  INVALID_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  REQUEST_TIMEOUT: 408,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  INTERNAL_ERROR: 500,
  UPSTREAM_ERROR: 502,
  SERVICE_UNAVAILABLE: 503,
};

const NO_MASTER_RESUME_MESSAGE =
  "Set up your resume in Resume Studio before using Role CVs.";

/**
 * Identifies the master resume version that Role CV content is generated
 * from. Resume Studio re-imports reset `revision`, so `updatedAt` is included.
 * Returns null when no master resume is configured.
 */
export async function getMasterResumeRevision(): Promise<string | null> {
  const designResume = await getCurrentDesignResumeOrNullOnLegacy();
  if (designResume) {
    return `design:${designResume.id}:${designResume.revision}:${designResume.updatedAt}`;
  }
  const { resumeId } = await getConfiguredRxResumeBaseResumeId();
  return resumeId ? `rxresume:${resumeId}` : null;
}

type RoleCvViewContext = {
  masterResumeRevision: string | null;
  fingerprintContext: PdfFingerprintContext;
};

async function resolveViewContext(): Promise<RoleCvViewContext> {
  const [masterResumeRevision, fingerprintContext] = await Promise.all([
    getMasterResumeRevision(),
    resolvePdfFingerprintContext(),
  ]);
  return { masterResumeRevision, fingerprintContext };
}

function isPdfLockActive(row: RoleCvRow, now = Date.now()): boolean {
  if (!row.pdfRegeneratingSince) return false;
  const since = Date.parse(row.pdfRegeneratingSince);
  return Number.isFinite(since) && now - since < PDF_LOCK_STALE_MS;
}

function createRoleCvPdfFingerprint(
  row: Pick<
    RoleCvRow,
    | "tailoredHeadline"
    | "tailoredSummary"
    | "tailoredSkills"
    | "selectedProjectIds"
    | "roleDescription"
  >,
  context: PdfFingerprintContext,
): string {
  return createJobPdfFingerprint(
    {
      tailoredHeadline: row.tailoredHeadline,
      tailoredSummary: row.tailoredSummary,
      tailoredSkills: row.tailoredSkills,
      selectedProjectIds: row.selectedProjectIds,
      jobDescription: row.roleDescription,
      tracerLinksEnabled: false,
      employer: "",
    },
    context,
  );
}

function getPdfFreshness(
  row: RoleCvRow,
  context: PdfFingerprintContext,
): RoleCvPdfFreshness {
  if (isPdfLockActive(row)) return "regenerating";
  if (!row.pdfPath || !existsSync(getTenantRoleCvPdfPath(row.id))) {
    return "missing";
  }
  return row.pdfFingerprint === createRoleCvPdfFingerprint(row, context)
    ? "current"
    : "stale";
}

function toRoleCv(row: RoleCvRow, context: RoleCvViewContext): RoleCv {
  return {
    id: row.id,
    name: row.name,
    roleDescription: row.roleDescription,
    tailoredHeadline: row.tailoredHeadline,
    tailoredSummary: row.tailoredSummary,
    tailoredSkills: row.tailoredSkills,
    selectedProjectIds: row.selectedProjectIds,
    masterResumeRevision: row.masterResumeRevision,
    generatedAt: row.generatedAt,
    isStale:
      Boolean(row.generatedAt) &&
      row.masterResumeRevision !== context.masterResumeRevision,
    pdfFreshness: getPdfFreshness(row, context.fingerprintContext),
    pdfGeneratedAt: row.pdfGeneratedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function requireRoleCvRow(id: string): Promise<RoleCvRow> {
  const row = await roleCvsRepo.getRoleCvRowById(id);
  if (!row) throw notFound("Role CV not found");
  return row;
}

async function assertNameAvailable(
  name: string,
  excludingId?: string,
): Promise<void> {
  if (await roleCvsRepo.roleCvNameExists({ name, excludingId })) {
    throw conflict(`A Role CV named "${name}" already exists.`);
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed: role_cvs/i.test(error.message)
  );
}

function parseRoleCvSkills(raw: string | null | undefined): RoleCvSkillGroup[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): RoleCvSkillGroup[] => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name : "";
      const keywords = Array.isArray(record.keywords)
        ? record.keywords.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      return name || keywords.length > 0 ? [{ name, keywords }] : [];
    });
  } catch {
    return [];
  }
}

function parseProjectIdsCsv(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function listRoleCvs(): Promise<RoleCv[]> {
  const [rows, context] = await Promise.all([
    roleCvsRepo.listRoleCvRows(),
    resolveViewContext(),
  ]);
  return rows.map((row) => toRoleCv(row, context));
}

export async function getRoleCv(id: string): Promise<RoleCv> {
  const [row, context] = await Promise.all([
    requireRoleCvRow(id),
    resolveViewContext(),
  ]);
  return toRoleCv(row, context);
}

export async function createRoleCv(input: CreateRoleCvInput): Promise<RoleCv> {
  const name = input.name.trim();
  await assertNameAvailable(name);
  try {
    const row = await roleCvsRepo.insertRoleCvRow({
      name,
      roleDescription: input.roleDescription.trim(),
    });
    return toRoleCv(row, await resolveViewContext());
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw conflict(`A Role CV named "${name}" already exists.`);
    }
    throw error;
  }
}

export async function updateRoleCv(
  id: string,
  input: UpdateRoleCvInput,
): Promise<RoleCv> {
  await requireRoleCvRow(id);
  const name = input.name?.trim();
  if (name !== undefined) {
    await assertNameAvailable(name, id);
  }
  try {
    const row = await roleCvsRepo.updateRoleCvRow(id, {
      ...(name !== undefined ? { name } : {}),
      ...(input.roleDescription !== undefined
        ? { roleDescription: input.roleDescription.trim() }
        : {}),
      ...(input.tailoredHeadline !== undefined
        ? { tailoredHeadline: input.tailoredHeadline }
        : {}),
      ...(input.tailoredSummary !== undefined
        ? { tailoredSummary: input.tailoredSummary }
        : {}),
      ...(input.tailoredSkills !== undefined
        ? { tailoredSkills: input.tailoredSkills }
        : {}),
      ...(input.selectedProjectIds !== undefined
        ? { selectedProjectIds: input.selectedProjectIds }
        : {}),
    });
    if (!row) throw notFound("Role CV not found");
    return toRoleCv(row, await resolveViewContext());
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw conflict(`A Role CV named "${name}" already exists.`);
    }
    throw error;
  }
}

export async function deleteRoleCv(id: string): Promise<void> {
  // A render in flight would write its file after the delete and orphan it.
  const row = await requireRoleCvRow(id);
  if (isPdfLockActive(row)) {
    throw conflict(
      "This Role CV PDF is being generated. Delete it once that finishes.",
    );
  }
  const deleted = await roleCvsRepo.deleteRoleCvRow(id);
  if (deleted === 0) throw notFound("Role CV not found");
  await removeStoredRoleCvPdf(id);
}

/** Parsed tailoring content of a stored Role CV. */
export async function getRoleCvTailoringContent(
  id: string,
): Promise<RoleCvTailoringContent> {
  const row = await requireRoleCvRow(id);
  return {
    headline: row.tailoredHeadline ?? "",
    summary: row.tailoredSummary ?? "",
    skills: parseRoleCvSkills(row.tailoredSkills),
    selectedProjectIds: parseProjectIdsCsv(row.selectedProjectIds),
  };
}

async function selectProjectsForRole(args: {
  profile: ResumeProfile;
  roleText: string;
}): Promise<string[]> {
  const { catalog, selectionItems } = extractProjectsFromProfile(args.profile);
  const overrideRaw = await settingsRepo.getSetting("resumeProjects");
  const { resumeProjects } = resolveResumeProjectsSettings({
    catalog,
    overrideRaw,
  });
  const selection = resolveResumeProjectSelection({ catalog, resumeProjects });
  const eligibleIds = new Set(selection.aiSelectableIds);
  const eligibleProjects = selectionItems.filter((project) =>
    eligibleIds.has(project.id),
  );
  if (selection.remainingSlots <= 0 || eligibleProjects.length === 0) {
    return [];
  }
  if (isDemoMode()) {
    return eligibleProjects
      .slice(0, selection.remainingSlots)
      .map((project) => project.id);
  }
  return pickProjectIdsForJob({
    jobDescription: args.roleText,
    eligibleProjects,
    desiredCount: selection.remainingSlots,
  });
}

function buildDemoTailoring(args: {
  roleName: string;
  profile: ResumeProfile;
}): Omit<RoleCvTailoringContent, "selectedProjectIds"> {
  const skills = (args.profile.sections?.skills?.items ?? [])
    .map((item) => ({
      name: item.name ?? "",
      keywords: Array.isArray(item.keywords) ? item.keywords : [],
    }))
    .filter((group) => group.name || group.keywords.length > 0);
  return {
    headline: args.roleName,
    summary: `Demo Role CV summary for ${args.roleName}. Generated without an AI model in demo mode.`,
    skills,
  };
}

/**
 * Generates tailoring content for a target role from the master resume:
 * headline, summary and skills via the tailoring service (Role CV prompt,
 * tailoring model purpose), plus AI-selected projects via project selection.
 * Does not persist anything. Demo mode never calls a model.
 */
export async function generateRoleCvTailoring(args: {
  roleName: string;
  roleDescription: string;
  profile?: ResumeProfile;
}): Promise<RoleCvTailoringContent> {
  const profile = args.profile ?? (await getProfile());
  const roleText = [args.roleName, args.roleDescription]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n\n");

  let content: Omit<RoleCvTailoringContent, "selectedProjectIds">;
  if (isDemoMode()) {
    content = buildDemoTailoring({ roleName: args.roleName, profile });
  } else {
    const result = await generateTailoring(args.roleDescription, profile, {
      target: { kind: "role", roleName: args.roleName },
    });
    if (!result.success || !result.data) {
      logger.warn("Role CV tailoring generation failed", {
        error: result.error,
      });
      throw upstreamError(
        `Could not generate the Role CV: ${result.error ?? "unknown error"}`,
      );
    }
    content = result.data;
  }

  let selectedProjectIds: string[] = [];
  try {
    selectedProjectIds = await selectProjectsForRole({ profile, roleText });
  } catch (error) {
    logger.warn("Role CV project selection failed", { error });
  }

  return { ...content, selectedProjectIds };
}

/** Generates and stores tailoring content for a Role CV. */
export async function generateRoleCv(id: string): Promise<RoleCv> {
  const row = await requireRoleCvRow(id);
  const masterResumeRevision = await getMasterResumeRevision();
  if (!masterResumeRevision) throw badRequest(NO_MASTER_RESUME_MESSAGE);
  if (!row.roleDescription.trim()) {
    throw badRequest("Add a role description before generating.");
  }

  const content = await withHostedUsageReservation(
    { action: "tailoring" },
    async () => ({
      result: await generateRoleCvTailoring({
        roleName: row.name,
        roleDescription: row.roleDescription,
      }),
      usedUnits: 1,
    }),
  );

  const updated = await roleCvsRepo.updateRoleCvRow(id, {
    tailoredHeadline: content.headline,
    tailoredSummary: content.summary,
    tailoredSkills: JSON.stringify(content.skills),
    selectedProjectIds: content.selectedProjectIds.join(","),
    masterResumeRevision,
    generatedAt: new Date().toISOString(),
  });
  if (!updated) throw notFound("Role CV not found");
  logger.info("Role CV generated", { roleCvId: id });
  return toRoleCv(updated, await resolveViewContext());
}

/**
 * Renders the Role CV PDF through the same renderer path as job PDFs, to a
 * tenant-scoped path of its own. Concurrent regeneration of the same Role CV
 * is rejected with CONFLICT.
 */
export async function generateRoleCvPdf(
  id: string,
  options?: { requestOrigin?: string | null },
): Promise<RoleCv> {
  const row = await requireRoleCvRow(id);
  if (!(await getMasterResumeRevision())) {
    throw badRequest(NO_MASTER_RESUME_MESSAGE);
  }

  const claimedAt = new Date().toISOString();
  const claimed = await roleCvsRepo.claimRoleCvPdfRegeneration({
    id,
    claimedAt,
    staleBefore: new Date(Date.now() - PDF_LOCK_STALE_MS).toISOString(),
  });
  if (!claimed) {
    throw conflict(
      "This Role CV PDF is already being generated. Please wait for it to finish.",
    );
  }

  let released = false;
  try {
    const fingerprintContext = await resolvePdfFingerprintContext();
    const outputPath = getTenantRoleCvPdfPath(id);
    const result = await withHostedUsageReservation(
      { action: "pdf_export" },
      async () => {
        const pdfResult = await generatePdf(
          `role-cv-${id}`,
          {
            headline: row.tailoredHeadline ?? "",
            summary: row.tailoredSummary ?? "",
            skills: parseRoleCvSkills(row.tailoredSkills),
          },
          row.roleDescription,
          undefined,
          row.selectedProjectIds,
          {
            outputPath,
            tracerLinksEnabled: false,
            requestOrigin: options?.requestOrigin ?? null,
          },
        );
        return { result: pdfResult, usedUnits: pdfResult.success ? 1 : 0 };
      },
    );

    if (!result.success) {
      const code = result.errorCode ?? "INTERNAL_ERROR";
      throw new AppError({
        status: STATUS_BY_CODE[code],
        code,
        message: result.error ?? "Failed to generate the Role CV PDF",
      });
    }

    released = await roleCvsRepo.releaseRoleCvPdfRegeneration({
      id,
      claimedAt,
      update: {
        pdfPath: outputPath,
        pdfFingerprint: createRoleCvPdfFingerprint(row, fingerprintContext),
        pdfGeneratedAt: new Date().toISOString(),
      },
    });
    if (!released) {
      throw conflict("The Role CV changed while its PDF was generated.");
    }
    logger.info("Role CV PDF generated", { roleCvId: id });
    return getRoleCv(id);
  } finally {
    if (!released) {
      await roleCvsRepo
        .releaseRoleCvPdfRegeneration({ id, claimedAt })
        .catch((error: unknown) => {
          logger.warn("Failed to release Role CV PDF lock", {
            roleCvId: id,
            error,
          });
        });
    }
  }
}

/** Returns the stored PDF path and a download file name, or throws NOT_FOUND. */
export async function getRoleCvPdfFile(
  id: string,
): Promise<{ path: string; fileName: string }> {
  const row = await requireRoleCvRow(id);
  const path = getTenantRoleCvPdfPath(row.id);
  if (!row.pdfPath || !existsSync(path)) {
    throw notFound("Role CV PDF not found");
  }
  return { path, fileName: row.name };
}
