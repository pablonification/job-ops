import { badRequest } from "@infra/errors";
import {
  assertJobIdle,
  defineTool,
  defineToolGroup,
  jobIdInput,
  loadCompactJobState,
  paginateArray,
  paginationShape,
} from "@server/mcp/kit";
import * as roleCvsRepo from "@server/repositories/role-cvs";
import { requireJob } from "@server/services/jobs/common";
import {
  applyRoleCvToJob,
  matchJobRoleCv,
  refineJobWithRoleCv,
  setJobRoleCv,
} from "@server/services/jobs/role-cv-actions";
import {
  createRoleCv,
  deleteRoleCv,
  generateRoleCv,
  generateRoleCvPdf,
  getRoleCv,
  listRoleCvs,
  updateRoleCv,
} from "@server/services/role-cvs";
import type { Job, RoleCv } from "@shared/types";
import { z } from "zod";

const ROLE_DESCRIPTION_PREVIEW_CHARS = 300;

const roleCvIdInput = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("Role CV id from list_role_cvs.");

function parseSkills(raw: string | null): unknown[] {
  if (!raw?.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function splitIds(raw: string | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function hasContent(roleCv: RoleCv): boolean {
  return Boolean(
    roleCv.tailoredHeadline?.trim() && roleCv.tailoredSummary?.trim(),
  );
}

function pdfUrlFor(roleCvId: string, requestOrigin: string | null): string {
  return `${requestOrigin ?? ""}/api/role-cvs/${encodeURIComponent(roleCvId)}/pdf`;
}

/** List shape: no summary or skills, role description cut short. */
function toRoleCvSummary(roleCv: RoleCv) {
  const description = roleCv.roleDescription;
  return {
    id: roleCv.id,
    name: roleCv.name,
    roleDescription:
      description.length > ROLE_DESCRIPTION_PREVIEW_CHARS
        ? `${description.slice(0, ROLE_DESCRIPTION_PREVIEW_CHARS)}…`
        : description,
    headline: roleCv.tailoredHeadline,
    hasContent: hasContent(roleCv),
    isStale: roleCv.isStale,
    generatedAt: roleCv.generatedAt,
    pdfFreshness: roleCv.pdfFreshness,
    updatedAt: roleCv.updatedAt,
  };
}

/** Detail shape: everything, with skills and project ids parsed. */
function toRoleCvDetail(roleCv: RoleCv, requestOrigin: string | null) {
  const hasPdf =
    roleCv.pdfFreshness === "current" || roleCv.pdfFreshness === "stale";
  return {
    id: roleCv.id,
    name: roleCv.name,
    roleDescription: roleCv.roleDescription,
    headline: roleCv.tailoredHeadline,
    summary: roleCv.tailoredSummary,
    skills: parseSkills(roleCv.tailoredSkills),
    selectedProjectIds: splitIds(roleCv.selectedProjectIds),
    hasContent: hasContent(roleCv),
    isStale: roleCv.isStale,
    generatedAt: roleCv.generatedAt,
    pdfFreshness: roleCv.pdfFreshness,
    pdfGeneratedAt: roleCv.pdfGeneratedAt,
    pdfUrl: hasPdf ? pdfUrlFor(roleCv.id, requestOrigin) : null,
    createdAt: roleCv.createdAt,
    updatedAt: roleCv.updatedAt,
  };
}

/** Which Role CV a job uses, by id and name, and how it was chosen. */
async function describeJobRoleCv(job: Job) {
  if (!job.roleCvId) {
    return { roleCv: null, roleCvMatchSource: job.roleCvMatchSource };
  }
  const row = await roleCvsRepo.getRoleCvRowById(job.roleCvId);
  return {
    roleCv: row ? { id: row.id, name: row.name } : null,
    roleCvMatchSource: job.roleCvMatchSource,
  };
}

const listRoleCvsTool = defineTool({
  name: "list_role_cvs",
  title: "List Role CVs",
  description:
    "The user's Role CVs: named CV variants for a target role (e.g. 'Backend intern'), generated from the master resume and used as the starting point for per-job tailoring. Returns id, name, a role description preview, headline, whether it has content, whether it is stale against the master resume, and PDF state. Call get_role_cv for the summary and skills.",
  scope: "read",
  input: z.object({ ...paginationShape }).strict(),
  handler: async ({ limit, offset }) => {
    const { items, page } = paginateArray(await listRoleCvs(), {
      limit,
      offset,
    });
    return { roleCvs: items.map(toRoleCvSummary), ...page };
  },
});

const getRoleCvTool = defineTool({
  name: "get_role_cv",
  title: "Get a Role CV",
  description:
    "One Role CV in full: role description, headline, summary, skill groups, selected project ids, whether it is stale against the master resume, and its PDF state and download URL (GET with your access token as Authorization: Bearer).",
  scope: "read",
  input: z.object({ roleCvId: roleCvIdInput }).strict(),
  handler: async ({ roleCvId }, context) => ({
    roleCv: toRoleCvDetail(await getRoleCv(roleCvId), context.requestOrigin),
  }),
});

const nameInput = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .describe("Name, unique per user, e.g. 'Backend Engineer Intern'.");
const roleDescriptionInput = z
  .string()
  .trim()
  .max(20000)
  .describe(
    "What the target role looks like: responsibilities, stack, level. Generation uses it in place of a job description.",
  );

const createRoleCvTool = defineTool({
  name: "create_role_cv",
  title: "Create a Role CV",
  description:
    "Create an empty Role CV from a name and a role description. It has no headline or summary until you call generate_role_cv (or set them with update_role_cv). Fails with CONFLICT if the name is taken.",
  scope: "write",
  input: z
    .object({
      name: nameInput,
      roleDescription: roleDescriptionInput.default(""),
    })
    .strict(),
  handler: async ({ name, roleDescription }, context) => ({
    roleCv: toRoleCvDetail(
      await createRoleCv({ name, roleDescription }),
      context.requestOrigin,
    ),
    next: "Call generate_role_cv to fill the headline, summary, skills and projects from the master resume.",
  }),
});

const skillGroupInput = z
  .object({
    name: z.string().trim().max(200),
    keywords: z.array(z.string().trim().min(1).max(200)).max(100),
  })
  .strict();

const updateRoleCvTool = defineTool({
  name: "update_role_cv",
  title: "Edit a Role CV",
  description:
    "Edit a Role CV's name, role description, headline, summary, skill groups or selected project ids (see get_profile). Only the fields given change; null clears a content field. Jobs that already use this Role CV are not rewritten: re-apply with apply_role_cv_to_job.",
  scope: "write",
  idempotent: true,
  input: z
    .object({
      roleCvId: roleCvIdInput,
      name: nameInput.optional(),
      roleDescription: roleDescriptionInput.optional(),
      headline: z.string().max(500).nullable().optional(),
      summary: z.string().max(10000).nullable().optional(),
      skills: z
        .array(skillGroupInput)
        .max(50)
        .nullable()
        .optional()
        .describe("Skill groups, replacing the current ones."),
      selectedProjectIds: z
        .array(z.string().trim().min(1).max(200))
        .max(50)
        .nullable()
        .optional()
        .describe("Project ids from get_profile, replacing the current ones."),
    })
    .strict(),
  handler: async (input, context) => {
    const { roleCvId, headline, summary, skills, selectedProjectIds, ...rest } =
      input;
    const patch = {
      ...rest,
      ...(headline !== undefined ? { tailoredHeadline: headline } : {}),
      ...(summary !== undefined ? { tailoredSummary: summary } : {}),
      ...(skills !== undefined
        ? { tailoredSkills: skills === null ? null : JSON.stringify(skills) }
        : {}),
      ...(selectedProjectIds !== undefined
        ? {
            selectedProjectIds:
              selectedProjectIds === null ? null : selectedProjectIds.join(","),
          }
        : {}),
    };
    const updatedFields = Object.keys(input).filter(
      (key) => key !== "roleCvId",
    );
    if (updatedFields.length === 0) {
      throw badRequest("Provide at least one field to change.");
    }
    return {
      roleCv: toRoleCvDetail(
        await updateRoleCv(roleCvId, patch),
        context.requestOrigin,
      ),
      updatedFields,
    };
  },
});

const generateRoleCvTool = defineTool({
  name: "generate_role_cv",
  title: "Generate a Role CV",
  description:
    "Fill a Role CV's headline, summary, skills and project selection from the master resume and its role description, with the AI model (replaces existing content; can take a minute). Also refreshes a stale Role CV. Needs a master resume and a role description.",
  scope: "write",
  openWorld: true,
  input: z.object({ roleCvId: roleCvIdInput }).strict(),
  handler: async ({ roleCvId }, context) => ({
    roleCv: toRoleCvDetail(
      await generateRoleCv(roleCvId),
      context.requestOrigin,
    ),
  }),
});

const generateRoleCvPdfTool = defineTool({
  name: "generate_role_cv_pdf",
  title: "Render a Role CV PDF",
  description:
    "Render the PDF of a Role CV from its current content, for applications made outside JobOps. Returns the Role CV with its PDF download URL. Fails with CONFLICT while its PDF is already rendering.",
  scope: "write",
  openWorld: true,
  input: z.object({ roleCvId: roleCvIdInput }).strict(),
  handler: async ({ roleCvId }, context) => {
    const roleCv = await generateRoleCvPdf(roleCvId, {
      requestOrigin: context.requestOrigin,
    });
    return {
      roleCv: toRoleCvDetail(roleCv, context.requestOrigin),
      pdfUrl: pdfUrlFor(roleCvId, context.requestOrigin),
    };
  },
});

const deleteRoleCvTool = defineTool({
  name: "delete_role_cv",
  title: "Delete a Role CV",
  description:
    "Permanently delete a Role CV and its PDF. Jobs that used it keep their tailored content and lose only the reference. Fails with CONFLICT while its PDF renders.",
  scope: "write",
  destructive: true,
  input: z.object({ roleCvId: roleCvIdInput }).strict(),
  handler: async ({ roleCvId }) => {
    await deleteRoleCv(roleCvId);
    return { deleted: true, roleCvId };
  },
});

const matchJobRoleCvTool = defineTool({
  name: "match_job_role_cv",
  title: "Pick the best Role CV for a job",
  description:
    "Choose the user's best-fitting Role CV for a job (the AI model, with a keyword fallback) and store it on the job as an automatic match; roleCv null means none fits. Only Role CVs with content are considered; with none, the job is unchanged. Does not change the tailored content: use apply_role_cv_to_job, or process_job, which tailors from the matched Role CV.",
  scope: "write",
  openWorld: true,
  input: z.object({ jobId: jobIdInput }).strict(),
  handler: async ({ jobId }) => {
    assertJobIdle(await requireJob(jobId), { allowPdfRegenerating: true });
    const job = await matchJobRoleCv(jobId);
    return {
      job: await loadCompactJobState(job),
      ...(await describeJobRoleCv(job)),
    };
  },
});

const setJobRoleCvTool = defineTool({
  name: "set_job_role_cv",
  title: "Choose a job's Role CV",
  description:
    "Set which Role CV a job uses by hand (recorded as a manual choice), or null for none. No model call and no change to the tailored content; process_job and apply_role_cv_to_job then use this choice.",
  scope: "write",
  idempotent: true,
  input: z
    .object({
      jobId: jobIdInput,
      roleCvId: roleCvIdInput.nullable(),
    })
    .strict(),
  handler: async ({ jobId, roleCvId }) => {
    assertJobIdle(await requireJob(jobId), { allowPdfRegenerating: true });
    const job = await setJobRoleCv(jobId, roleCvId);
    return {
      job: await loadCompactJobState(job),
      ...(await describeJobRoleCv(job)),
    };
  },
});

const applyRoleCvToJobTool = defineTool({
  name: "apply_role_cv_to_job",
  title: "Use a Role CV for a job",
  description:
    "Put a Role CV's content into a job's tailored resume. mode as_is copies headline, summary, skills and projects (no model call); mode refine tailors the job with the model, starting from the Role CV (up to a minute). Uses roleCvId (recorded as a manual choice) or the job's current Role CV; INVALID_REQUEST when there is none or it has no content. A ready job's PDF goes stale and may regenerate automatically; otherwise call generate_job_pdf.",
  scope: "write",
  openWorld: true,
  input: z
    .object({
      jobId: jobIdInput,
      mode: z
        .enum(["as_is", "refine"])
        .describe("as_is: copy, no model call. refine: tailor from it."),
      roleCvId: roleCvIdInput
        .optional()
        .describe("Role CV to use. Omit for the job's current Role CV."),
    })
    .strict(),
  handler: async ({ jobId, mode, roleCvId }, context) => {
    assertJobIdle(await requireJob(jobId));
    const job =
      mode === "refine"
        ? await refineJobWithRoleCv(jobId, {
            roleCvId,
            requestOrigin: context.requestOrigin,
          })
        : await applyRoleCvToJob(jobId, { roleCvId });
    return {
      mode,
      job: await loadCompactJobState(job),
      ...(await describeJobRoleCv(job)),
      tailoring: {
        headline: job.tailoredHeadline,
        summary: job.tailoredSummary,
        skills: parseSkills(job.tailoredSkills),
        selectedProjectIds: splitIds(job.selectedProjectIds),
      },
    };
  },
});

export const roleCvsToolGroup = defineToolGroup({
  id: "role-cvs",
  tools: [
    listRoleCvsTool,
    getRoleCvTool,
    createRoleCvTool,
    updateRoleCvTool,
    generateRoleCvTool,
    generateRoleCvPdfTool,
    deleteRoleCvTool,
    matchJobRoleCvTool,
    setJobRoleCvTool,
    applyRoleCvToJobTool,
  ],
});
