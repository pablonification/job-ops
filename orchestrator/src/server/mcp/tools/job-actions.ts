import { badRequest } from "@infra/errors";
import { updateJobSchema } from "@server/api/routes/jobs/shared";
import {
  assertJobIdle,
  defineTool,
  defineToolGroup,
  JOB_STATUS_VALUES,
  jobIdInput,
  loadCompactJobState,
  toCompactJobState,
} from "@server/mcp/kit";
import {
  buildJobActionExecutionOptions,
  executeJobActionForJob,
  mapJobActionFailure,
  runJobActionBatch,
} from "@server/services/jobs/actions";
import { checkJobSponsor } from "@server/services/jobs/application";
import {
  hydrateJobPdfFreshness,
  requireJob,
} from "@server/services/jobs/common";
import {
  generateJobPdf,
  TAILORING_GENERATE_FIELDS,
  tailorJob,
} from "@server/services/jobs/tailoring";
import {
  deleteJobWithFiles,
  updateJobWithSideEffects,
} from "@server/services/jobs/updates";
import {
  fetchManualJobContent,
  importManualJob,
  MANUAL_JOB_DESCRIPTION_MAX_CHARS,
  manualJobImportSchema,
} from "@server/services/manual-job-import";
import { inferManualJobDetails } from "@server/services/manualJob";
import { pdfExists } from "@server/services/pdf";
import type { Job, JobAction, ManualJobDraft } from "@shared/types";
import { z } from "zod";

const MCP_ROUTE = "POST /mcp";
const BULK_ACTION_MAX_JOBS = 100;

function parseJsonArray(value: string | null): unknown[] | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function splitProjectIds(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

async function runSingleJobAction(
  action: JobAction,
  jobId: string,
  options: { forceMoveToReady?: boolean; requestOrigin: string | null },
): Promise<Job> {
  const result = await executeJobActionForJob(
    action,
    jobId,
    buildJobActionExecutionOptions(action, options),
  );
  if (!result.ok) throw mapJobActionFailure(result);
  return result.job;
}

const jobOnlyInput = z.object({ jobId: jobIdInput }).strict();

const rescoreJob = defineTool({
  name: "rescore_job",
  title: "Rescore a job",
  description:
    "Re-run the suitability model for one job against the master resume. Returns the new score (0-100), the reason and the updated compact job. Not allowed while the job is processing.",
  scope: "write",
  idempotent: false,
  openWorld: true,
  input: jobOnlyInput,
  handler: async ({ jobId }, context) => {
    assertJobIdle(await requireJob(jobId), { allowPdfRegenerating: true });
    const job = await runSingleJobAction("rescore", jobId, {
      requestOrigin: context.requestOrigin,
    });
    return {
      job: await loadCompactJobState(job),
      score: job.suitabilityScore,
      reason: job.suitabilityReason,
    };
  },
});

const tailorJobTool = defineTool({
  name: "tailor_job",
  title: "Tailor the resume for a job",
  description:
    "Generate the tailored resume content for one job with the model: summary, headline, skills and project selection (or only the fields listed). Existing tailored content is kept unless force is true. Does not render the PDF; call generate_job_pdf afterwards (a changed PDF may also regenerate automatically).",
  scope: "write",
  openWorld: true,
  input: z
    .object({
      jobId: jobIdInput,
      fields: z
        .array(z.enum(TAILORING_GENERATE_FIELDS))
        .min(1)
        .max(TAILORING_GENERATE_FIELDS.length)
        .optional()
        .describe("Only regenerate these fields. Omit for all of them."),
      force: z
        .boolean()
        .default(false)
        .describe("Regenerate even when tailored content already exists."),
    })
    .strict(),
  handler: async ({ jobId, fields, force }) => {
    assertJobIdle(await requireJob(jobId));
    const job = await tailorJob(jobId, {
      force,
      fields: fields ? [...new Set(fields)] : undefined,
      route: MCP_ROUTE,
    });
    return {
      job: await loadCompactJobState(job),
      tailoring: {
        headline: job.tailoredHeadline,
        summary: job.tailoredSummary,
        skills: parseJsonArray(job.tailoredSkills),
        selectedProjectIds: splitProjectIds(job.selectedProjectIds),
      },
    };
  },
});

function pdfPathFor(jobId: string): string {
  return `/api/jobs/${encodeURIComponent(jobId)}/pdf`;
}

const generateJobPdfTool = defineTool({
  name: "generate_job_pdf",
  title: "Generate the resume PDF for a job",
  description:
    "Render the tailored resume PDF for one job from its current tailored content. Returns the updated compact job and the PDF download URL. Fails with CONFLICT while the job is processing or its PDF is already being generated.",
  scope: "write",
  openWorld: true,
  input: jobOnlyInput,
  handler: async ({ jobId }, context) => {
    assertJobIdle(await requireJob(jobId));
    const job = await generateJobPdf(jobId, {
      requestOrigin: context.requestOrigin,
    });
    const state = await loadCompactJobState(job);
    return {
      job: state,
      pdfUrl: `${context.requestOrigin ?? ""}${pdfPathFor(jobId)}`,
    };
  },
});

const processJobTool = defineTool({
  name: "process_job",
  title: "Tailor and render a job (move to Ready)",
  description:
    "Move a discovered job to Ready: tailor the resume content with the model, then render the PDF. Only for jobs in status discovered. force regenerates existing tailored content. Can take a minute.",
  scope: "write",
  openWorld: true,
  input: z
    .object({
      jobId: jobIdInput,
      force: z
        .boolean()
        .default(false)
        .describe("Regenerate tailored content even when it already exists."),
    })
    .strict(),
  handler: async ({ jobId, force }, context) => {
    assertJobIdle(await requireJob(jobId));
    const job = await runSingleJobAction("move_to_ready", jobId, {
      forceMoveToReady: force,
      requestOrigin: context.requestOrigin,
    });
    return { job: await loadCompactJobState(job) };
  },
});

const skipJob = defineTool({
  name: "skip_job",
  title: "Skip a job",
  description:
    "Mark a job as skipped (not interested). Only for jobs in status discovered or ready.",
  scope: "write",
  input: jobOnlyInput,
  handler: async ({ jobId }, context) => {
    const job = await runSingleJobAction("skip", jobId, {
      requestOrigin: context.requestOrigin,
    });
    return { job: await loadCompactJobState(job) };
  },
});

const tailoredSkillInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    keywords: z.array(z.string().trim().min(1).max(200)).max(100),
  })
  .strict();

const updateJobInput = z
  .object({
    jobId: jobIdInput,
    title: z.string().optional(),
    employer: z.string().optional(),
    jobUrl: z.string().optional().describe("Posting URL."),
    applicationLink: z
      .string()
      .nullable()
      .optional()
      .describe("Direct application URL; null clears it."),
    location: z.string().nullable().optional(),
    salary: z.string().nullable().optional(),
    deadline: z.string().nullable().optional(),
    jobDescription: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Replace the job description (max 40000 characters). Clears the cached job brief.",
      ),
    status: z
      .enum(JOB_STATUS_VALUES)
      .optional()
      .describe(
        "Set the status directly. Prefer skip_job, process_job and mark_job_applied, which run the matching workflow.",
      ),
    tailoredHeadline: z.string().optional(),
    tailoredSummary: z.string().optional(),
    tailoredSkills: z
      .array(tailoredSkillInput)
      .max(50)
      .optional()
      .describe("Tailored skill groups, replacing the current ones."),
    selectedProjectIds: z
      .array(z.string().trim().min(1).max(200))
      .max(50)
      .optional()
      .describe("Project ids (see get_profile) to show on the resume."),
    tracerLinksEnabled: z
      .boolean()
      .optional()
      .describe(
        "Turn tracer links on or off. Turning them on needs a publicly reachable JobOps URL.",
      ),
  })
  .strict();

const updateJob = defineTool({
  name: "update_job",
  title: "Edit a job",
  description:
    "Edit a job's details, description, status, tailored resume content (headline, summary, skills, selected projects) or tracer-link setting. Only the fields given change. Changing tailored content marks the PDF stale and may regenerate it automatically.",
  scope: "write",
  idempotent: true,
  input: updateJobInput,
  handler: async (input, context) => {
    const { jobId, tailoredSkills, selectedProjectIds, ...fields } = input;
    const patch = updateJobSchema.parse({
      ...fields,
      ...(tailoredSkills
        ? { tailoredSkills: JSON.stringify(tailoredSkills) }
        : {}),
      ...(selectedProjectIds
        ? { selectedProjectIds: selectedProjectIds.join(",") }
        : {}),
    });
    if (Object.keys(patch).length === 0) {
      throw badRequest("Provide at least one field to change.");
    }
    const job = await updateJobWithSideEffects(jobId, patch, {
      requestOrigin: context.requestOrigin,
      route: MCP_ROUTE,
      source: "mcp_update_job",
    });
    return {
      job: await loadCompactJobState(job),
      updatedFields: Object.keys(patch),
    };
  },
});

const deleteJob = defineTool({
  name: "delete_job",
  title: "Delete a job",
  description:
    "Permanently delete a job with its notes, stage history, resume PDF and attached documents. Fails with CONFLICT while the job is processing, its PDF renders or Ghostwriter is replying. Prefer skip_job to hide a job.",
  scope: "write",
  destructive: true,
  input: jobOnlyInput,
  handler: async ({ jobId }) => {
    await deleteJobWithFiles(jobId, { route: MCP_ROUTE });
    return { deleted: true, jobId };
  },
});

const bulkJobAction = defineTool({
  name: "bulk_job_action",
  title: "Run an action on many jobs",
  description: `Run skip, rescore or move_to_ready (tailor + PDF) over up to ${BULK_ACTION_MAX_JOBS} job ids, 4 at a time, and wait for all of them. Returns per-job results: ok with the compact job, or the error code and message. move_to_ready on many jobs can take several minutes; prefer batches of about 10.`,
  scope: "write",
  openWorld: true,
  input: z
    .object({
      action: z.enum(["skip", "rescore", "move_to_ready"]),
      jobIds: z
        .array(jobIdInput)
        .min(1)
        .max(BULK_ACTION_MAX_JOBS)
        .describe("Job ids; duplicates are ignored."),
      force: z
        .boolean()
        .optional()
        .describe(
          "move_to_ready only: regenerate tailored content that already exists.",
        ),
    })
    .strict(),
  handler: async ({ action, jobIds, force }, context) => {
    const outcome = await runJobActionBatch({
      action,
      jobIds,
      forceMoveToReady: action === "move_to_ready" ? force : undefined,
      requestOrigin: context.requestOrigin,
    });
    return {
      action: outcome.action,
      requested: outcome.requested,
      succeeded: outcome.succeeded,
      failed: outcome.failed,
      results: outcome.results.map((result) =>
        result.ok
          ? {
              jobId: result.jobId,
              ok: true,
              job: toCompactJobState(result.job),
            }
          : { jobId: result.jobId, ok: false, error: result.error },
      ),
    };
  },
});

const IMPORT_FIELD_LIMITS = {
  title: 500,
  employer: 500,
  location: 200,
  salary: 200,
  deadline: 100,
  jobType: 200,
  jobLevel: 200,
  jobFunction: 200,
  disciplines: 200,
  degreeRequired: 200,
  starting: 200,
} as const;

type ImportTextField = keyof typeof IMPORT_FIELD_LIMITS;

function cleanText(value: string | null | undefined, max: number) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function cleanUrl(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 2000) return undefined;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:"
      ? trimmed
      : undefined;
  } catch {
    return undefined;
  }
}

const importJobInput = z
  .object({
    url: z
      .string()
      .trim()
      .url()
      .max(2000)
      .optional()
      .describe(
        "Posting URL to fetch and read. LinkedIn and Indeed block fetching: pass description instead.",
      ),
    description: z
      .string()
      .trim()
      .min(1)
      .max(60000)
      .optional()
      .describe("Pasted job posting text. When given, the URL is not fetched."),
    jobUrl: z
      .string()
      .trim()
      .url()
      .max(2000)
      .optional()
      .describe(
        "Posting URL to store. Defaults to url, then to a URL found in the text. Required when neither exists.",
      ),
    title: z.string().trim().min(1).max(500).optional(),
    employer: z.string().trim().min(1).max(500).optional(),
    location: z.string().trim().min(1).max(200).optional(),
    salary: z.string().trim().min(1).max(200).optional(),
    applicationLink: z.string().trim().url().max(2000).optional(),
    process: z
      .boolean()
      .optional()
      .describe(
        "true: tailor and render the PDF right away, then score in the background. false: just save it as discovered. Default: the user's 'Auto-tailor manually imported jobs' setting.",
      ),
  })
  .strict();

const importJob = defineTool({
  name: "import_job",
  title: "Import a job from a URL or text",
  description:
    "Add a job the pipeline did not find, from a posting URL (fetched) or pasted text, like the manual import dialog. The model extracts title, employer, location and other fields; values you pass override them. Returns the new job. With processing, the job comes back as processing and turns ready when scoring finishes (poll get_job).",
  scope: "write",
  openWorld: true,
  input: importJobInput,
  handler: async (input) => {
    if (!input.url && !input.description) {
      throw badRequest("Provide url or description.");
    }
    const fetched =
      input.description === undefined && input.url
        ? await fetchManualJobContent(input.url)
        : null;
    const text = (input.description ?? fetched?.content ?? "").trim();
    if (!text) {
      throw badRequest(
        "The page had no readable text. Pass the job posting as description instead.",
      );
    }

    const inferred = await inferManualJobDetails(text);
    const draft: ManualJobDraft = inferred.job ?? {};
    const textFields: Partial<Record<ImportTextField, string>> = {};
    for (const [field, max] of Object.entries(IMPORT_FIELD_LIMITS) as Array<
      [ImportTextField, number]
    >) {
      const value = cleanText(
        (input as Partial<Record<ImportTextField, string>>)[field] ??
          draft[field],
        max,
      );
      if (value) textFields[field] = value;
    }
    const jobUrl =
      input.jobUrl ?? fetched?.url ?? input.url ?? cleanUrl(draft.jobUrl);
    const missing = [
      ...(textFields.title ? [] : ["title"]),
      ...(textFields.employer ? [] : ["employer"]),
      ...(jobUrl ? [] : ["jobUrl"]),
    ];
    if (missing.length > 0) {
      throw badRequest(
        `Could not determine ${missing.join(", ")} from the posting. Pass ${missing.length === 1 ? "it" : "them"} explicitly.`,
        { missing, ...(inferred.warning ? { warning: inferred.warning } : {}) },
      );
    }

    const job = await importManualJob(
      manualJobImportSchema.parse({
        ...(input.process === undefined
          ? {}
          : { skipTailoring: !input.process }),
        job: {
          ...textFields,
          jobUrl,
          applicationLink:
            input.applicationLink ?? cleanUrl(draft.applicationLink),
          jobDescription: text.slice(0, MANUAL_JOB_DESCRIPTION_MAX_CHARS),
        },
      }),
    );
    return {
      job: await loadCompactJobState(job),
      warning: inferred.warning ?? null,
      next:
        job.status === "processing"
          ? "Tailored and rendered. Scoring runs in the background; poll get_job until status is ready."
          : "Saved as discovered. Use rescore_job to score it and process_job to tailor it.",
    };
  },
});

const checkJobSponsorTool = defineTool({
  name: "check_job_sponsor",
  title: "Check visa sponsorship",
  description:
    "Look up the job's employer in the visa sponsor registers and store the match on the job. Returns the best match score (0-100), matched names and the top 5 candidates.",
  scope: "write",
  idempotent: true,
  input: jobOnlyInput,
  handler: async ({ jobId }, context) => {
    const { job, matchResults } = await checkJobSponsor(jobId, {
      requestOrigin: context.requestOrigin,
    });
    return {
      job: await loadCompactJobState(job),
      sponsorMatchScore: job.sponsorMatchScore,
      sponsorMatchNames: parseJsonArray(job.sponsorMatchNames),
      matchResults,
    };
  },
});

const PDF_FRESHNESS_HINTS = {
  missing: "No PDF yet. Call generate_job_pdf or process_job.",
  uploaded: "The user uploaded this PDF; it is not generated from tailoring.",
  current: "The PDF matches the current tailored content.",
  stale:
    "Tailored content or the resume changed since this PDF was rendered. Call generate_job_pdf to refresh it.",
  regenerating:
    "A new PDF is being rendered. Wait until pdfRegenerating is false.",
} as const;

const getJobPdfLink = defineTool({
  name: "get_job_pdf_link",
  title: "Get the resume PDF link",
  description:
    "Download URL of a job's resume PDF (GET it with your access token as Authorization: Bearer) and whether the PDF is current, stale, uploaded, regenerating or missing.",
  scope: "read",
  input: jobOnlyInput,
  handler: async ({ jobId }, context) => {
    const job = await hydrateJobPdfFreshness(await requireJob(jobId));
    const hasPdf = await pdfExists(jobId);
    const freshness = hasPdf ? job.pdfFreshness : "missing";
    return {
      jobId,
      hasPdf,
      url: hasPdf ? `${context.requestOrigin ?? ""}${pdfPathFor(jobId)}` : null,
      authorization:
        "Send the header Authorization: Bearer <your JobOps access token>. Read-only tokens may download.",
      pdfFreshness: freshness,
      pdfRegenerating: job.pdfRegenerating,
      pdfSource: hasPdf ? job.pdfSource : null,
      pdfGeneratedAt: hasPdf ? job.pdfGeneratedAt : null,
      hint: PDF_FRESHNESS_HINTS[freshness],
    };
  },
});

export const jobActionsToolGroup = defineToolGroup({
  id: "job-actions",
  tools: [
    rescoreJob,
    tailorJobTool,
    generateJobPdfTool,
    processJobTool,
    skipJob,
    updateJob,
    deleteJob,
    bulkJobAction,
    importJob,
    checkJobSponsorTool,
    getJobPdfLink,
  ],
});
