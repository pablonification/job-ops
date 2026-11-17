/**
 * Manual job import: fetching a posting's text from a URL and creating a job
 * from a reviewed draft. Shared by the REST routes (`/api/manual-jobs/fetch`,
 * `/api/manual-jobs/import`) and the MCP `import_job` tool.
 */
import { AppError, badRequest, conflict, notFound } from "@infra/errors";
import { logger } from "@infra/logger";
import { fetchPublicUrl, type PublicHttpDeps } from "@server/infra/public-http";
import { processJob } from "@server/pipeline/index";
import * as jobsRepo from "@server/repositories/jobs";
import { getSetting } from "@server/repositories/settings";
import { inferManualJobDetails } from "@server/services/manualJob";
import { getProfile } from "@server/services/profile";
import { scoreJobSuitability } from "@server/services/scorer";
import { settingsRegistry } from "@shared/settings-registry";
import type { Job, ManualJobDraft } from "@shared/types";
import { JSDOM } from "jsdom";
import { z } from "zod";

export const manualJobFetchSchema = z.object({
  url: z.string().trim().url().max(2000),
});

export const manualJobInferenceSchema = z.object({
  jobDescription: z.string().trim().min(1).max(60000),
});

export const manualJobImportSchema = z.object({
  skipTailoring: z.boolean().optional(),
  job: z.object({
    source: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9:_-]*$/i)
      .optional(),
    sourceJobId: z.string().trim().max(500).optional(),
    title: z.string().trim().min(1).max(500),
    employer: z.string().trim().min(1).max(500),
    jobUrl: z.string().trim().url().max(2000),
    applicationLink: z.string().trim().url().max(2000).optional(),
    location: z.string().trim().max(200).optional(),
    salary: z.string().trim().max(200).optional(),
    deadline: z.string().trim().max(100).optional(),
    jobDescription: z.string().trim().min(1).max(40000),
    jobType: z.string().trim().max(200).optional(),
    jobLevel: z.string().trim().max(200).optional(),
    jobFunction: z.string().trim().max(200).optional(),
    disciplines: z.string().trim().max(200).optional(),
    degreeRequired: z.string().trim().max(200).optional(),
    starting: z.string().trim().max(200).optional(),
  }),
});

export type ManualJobImportInput = z.infer<typeof manualJobImportSchema>;

/** Longest job description an import accepts. */
export const MANUAL_JOB_DESCRIPTION_MAX_CHARS = 40000;

const FETCH_TIMEOUT_MS = 15000;
/** Page bytes read (after decompression); the rest of a larger page is cut. */
const FETCH_MAX_BYTES = 5 * 1024 * 1024;
const FETCH_MAX_REDIRECTS = 5;
const FETCHED_CONTENT_MAX_CHARS = 50000;

const cleanOptional = (value?: string | null) => {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

async function resolveSkipTailoring(
  explicit: boolean | undefined,
): Promise<boolean> {
  if (typeof explicit === "boolean") return explicit;
  const raw = await getSetting("autoTailorOnManualImport");
  const parsed = settingsRegistry.autoTailorOnManualImport.parse(
    raw ?? undefined,
  );
  const autoTailor =
    parsed ?? settingsRegistry.autoTailorOnManualImport.default();
  return !autoTailor;
}

const BLOCKED_AUTOFETCH_HOSTS: Array<{
  label: string;
  match: (hostname: string) => boolean;
}> = [
  {
    label: "LinkedIn",
    match: (hostname) =>
      hostname === "linkedin.com" || hostname.endsWith(".linkedin.com"),
  },
  {
    label: "Indeed",
    match: (hostname) =>
      hostname === "indeed.com" || hostname.includes("indeed."),
  },
];

function getHostname(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function getBlockedAutofetchLabel(url: string): string | null {
  const hostname = getHostname(url);
  if (!hostname) return null;
  const blocked = BLOCKED_AUTOFETCH_HOSTS.find((entry) =>
    entry.match(hostname),
  );
  return blocked?.label ?? null;
}

function buildFetchFailureMessage(status: number): string {
  if (status === 401 || status === 403 || status === 429) {
    return "This site blocks automated fetch requests. Paste the job description manually.";
  }
  if (status === 404) {
    return "We couldn't find that page. Check the URL or paste the job description manually.";
  }
  return "Couldn't fetch this URL automatically. Paste the job description manually.";
}

function extractJobPageText(html: string): string {
  const dom = new JSDOM(html);
  const document = dom.window.document;

  // Extract page title (often contains job title)
  const pageTitle = document.querySelector("title")?.textContent?.trim() || "";

  // Extract meta description
  const metaDescription =
    document
      .querySelector('meta[name="description"]')
      ?.getAttribute("content")
      ?.trim() || "";

  // Extract Open Graph data
  const ogTitle =
    document
      .querySelector('meta[property="og:title"]')
      ?.getAttribute("content")
      ?.trim() || "";
  const ogDescription =
    document
      .querySelector('meta[property="og:description"]')
      ?.getAttribute("content")
      ?.trim() || "";
  const ogSiteName =
    document
      .querySelector('meta[property="og:site-name"]')
      ?.getAttribute("content")
      ?.trim() || "";

  // Remove non-content elements
  const elementsToRemove = document.querySelectorAll(
    "script, style, nav, header, footer, aside, iframe, noscript, " +
      '[role="navigation"], [role="banner"], [role="contentinfo"], ' +
      ".nav, .navbar, .header, .footer, .sidebar, .menu, .cookie, .popup, .modal, .ad, .advertisement",
  );
  elementsToRemove.forEach((el) => {
    el.remove();
  });

  // Try to find the main job content area
  const mainContent =
    document.querySelector(
      'main, [role="main"], article, ' +
        ".job-description, .job-details, .job-content, .vacancy-description, " +
        "#job-description, #job-details, #job-content, " +
        '[class*="job-desc"], [class*="jobDesc"], [class*="vacancy"], [class*="posting"]',
    ) || document.body;

  // Get text content
  let textContent = mainContent?.textContent || "";

  // Clean up whitespace
  textContent = textContent
    .replace(/[\t ]+/g, " ")
    .replace(/\n\s*\n/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Build enriched content with extracted metadata
  let enrichedContent = "";
  if (pageTitle) enrichedContent += `Page Title: ${pageTitle}\n`;
  if (ogTitle && ogTitle !== pageTitle)
    enrichedContent += `Job Title: ${ogTitle}\n`;
  if (ogSiteName) enrichedContent += `Company/Site: ${ogSiteName}\n`;
  if (ogDescription) enrichedContent += `Summary: ${ogDescription}\n`;
  if (metaDescription && metaDescription !== ogDescription)
    enrichedContent += `Description: ${metaDescription}\n`;
  if (enrichedContent) enrichedContent += "\n---\n\n";
  enrichedContent += textContent;

  // Limit to reasonable size
  if (enrichedContent.length > FETCHED_CONTENT_MAX_CHARS) {
    enrichedContent = enrichedContent.substring(0, FETCHED_CONTENT_MAX_CHARS);
  }
  return enrichedContent;
}

/**
 * Fetches a job page and returns its readable text plus page metadata.
 * LinkedIn and Indeed are refused (422); other fetch failures are 502 and a
 * slow site times out after 15 seconds (408).
 */
export async function fetchManualJobContent(
  url: string,
  deps?: PublicHttpDeps,
): Promise<{ content: string; url: string }> {
  const blockedLabel = getBlockedAutofetchLabel(url);
  if (blockedLabel) {
    throw new AppError({
      status: 422,
      code: "UNPROCESSABLE_ENTITY",
      message: `Auto-fetch is not supported for ${blockedLabel} links. Paste the job description manually.`,
    });
  }

  const response = await fetchPublicUrl(
    url,
    {
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: FETCH_MAX_BYTES,
      maxRedirects: FETCH_MAX_REDIRECTS,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
      },
    },
    deps,
  );

  if (response.status < 200 || response.status > 299) {
    throw new AppError({
      status: 502,
      code: "UPSTREAM_ERROR",
      message: buildFetchFailureMessage(response.status),
      details: { upstreamStatus: response.status },
    });
  }

  return {
    content: extractJobPageText(response.body.toString("utf8")),
    url,
  };
}

function startBackgroundScoring(processedJob: Job): void {
  // Score asynchronously so the import returns immediately with a processing state.
  void (async () => {
    try {
      const rawProfile = await getProfile();
      if (
        !rawProfile ||
        typeof rawProfile !== "object" ||
        Array.isArray(rawProfile)
      ) {
        throw new Error("Invalid resume profile format");
      }
      const profile = rawProfile as Record<string, unknown>;
      const {
        score,
        reason,
        jobBrief,
        jobUpdates = {},
      } = await scoreJobSuitability(processedJob, profile);
      await jobsRepo.updateJob(processedJob.id, {
        ...jobUpdates,
        status: "ready",
        suitabilityScore: score,
        suitabilityReason: reason,
        jobBrief,
      });
    } catch (error) {
      logger.warn("Manual job scoring failed", {
        jobId: processedJob.id,
        error,
      });
      await jobsRepo.updateJob(processedJob.id, { status: "ready" });
    }
  })().catch((error) => {
    logger.warn("Manual job scoring task failed to start", {
      jobId: processedJob.id,
      error,
    });
  });
}

/**
 * Creates a job from a reviewed draft. Unless tailoring is skipped (explicitly
 * or by the `autoTailorOnManualImport` setting), it tailors and renders the
 * PDF right away, returns the job in `processing`, and scores it in the
 * background before moving it to `ready`.
 */
export async function importManualJob(
  input: ManualJobImportInput,
): Promise<Job> {
  const job = input.job;
  const source = cleanOptional(job.source) ?? "manual";
  const sourceJobId = cleanOptional(job.sourceJobId);

  if (sourceJobId) {
    const existingJob = await jobsRepo.getJobBySourceJobId(source, sourceJobId);
    if (existingJob) {
      throw conflict("This job is already in your workspace.");
    }
  }

  const createdJob = await jobsRepo.createJob({
    source,
    sourceJobId: sourceJobId ?? undefined,
    title: job.title.trim(),
    employer: job.employer.trim(),
    jobUrl: job.jobUrl.trim(),
    applicationLink: cleanOptional(job.applicationLink) ?? undefined,
    location: cleanOptional(job.location) ?? undefined,
    salary: cleanOptional(job.salary) ?? undefined,
    deadline: cleanOptional(job.deadline) ?? undefined,
    jobDescription: job.jobDescription.trim(),
    jobType: cleanOptional(job.jobType) ?? undefined,
    jobLevel: cleanOptional(job.jobLevel) ?? undefined,
    jobFunction: cleanOptional(job.jobFunction) ?? undefined,
    disciplines: cleanOptional(job.disciplines) ?? undefined,
    degreeRequired: cleanOptional(job.degreeRequired) ?? undefined,
    starting: cleanOptional(job.starting) ?? undefined,
  });

  const skipTailoring = await resolveSkipTailoring(input.skipTailoring);
  if (skipTailoring) return createdJob;

  const processResult = await processJob(createdJob.id, {
    analyticsOrigin: "manual_job_create",
  });
  if (!processResult.success) {
    logger.warn("Manual job auto-processing failed", {
      jobId: createdJob.id,
      error: processResult.error ?? "Unknown error",
    });
    throw new AppError({
      status: 502,
      code: "UPSTREAM_ERROR",
      message:
        processResult.error ||
        "Imported job but failed to move it to ready automatically",
      details: { jobId: createdJob.id },
    });
  }

  const processedJob = await jobsRepo.getJobById(createdJob.id);
  if (!processedJob) throw notFound("Job not found");

  const scoringJob = await jobsRepo.updateJob(processedJob.id, {
    status: "processing",
  });
  if (!scoringJob) throw notFound("Job not found");

  startBackgroundScoring(processedJob);
  return scoringJob;
}

type ImportJobFields = z.infer<typeof manualJobImportSchema>["job"];

/** Draft fields `importJobFromPosting` fills from the model or the caller. */
const POSTING_TEXT_FIELDS = [
  "title",
  "employer",
  "location",
  "salary",
  "deadline",
  "jobType",
  "jobLevel",
  "jobFunction",
  "disciplines",
  "degreeRequired",
  "starting",
] as const satisfies ReadonlyArray<keyof ImportJobFields>;

export type PostingOverrides = Partial<
  Pick<
    ImportJobFields,
    "title" | "employer" | "location" | "salary" | "jobUrl" | "applicationLink"
  >
>;

/**
 * Keeps a model-extracted value only when the import schema accepts it, so a
 * bad guess (too long, not a URL) is dropped instead of failing the import.
 */
function acceptedDraftValue(
  field: keyof ImportJobFields,
  value: string | null | undefined,
): string | undefined {
  const cleaned = cleanOptional(value);
  if (!cleaned) return undefined;
  return manualJobImportSchema.shape.job.shape[field].safeParse(cleaned).success
    ? cleaned
    : undefined;
}

/**
 * The manual import dialog in one call: reads the posting (fetching `url`
 * unless `description` is given), lets the model extract the fields,
 * applies the caller's overrides, checks title, employer and job URL are
 * known, and imports it. The stored description is the posting text, as in
 * the dialog. `process` maps to the dialog's tailor checkbox; omitted, the
 * user's setting decides.
 */
export async function importJobFromPosting(
  input: {
    url?: string;
    description?: string;
    overrides?: PostingOverrides;
    process?: boolean;
  },
  deps?: PublicHttpDeps,
): Promise<{ job: Job; warning: string | null }> {
  if (!input.url && !input.description) {
    throw badRequest("Provide url or description.");
  }
  const fetched =
    input.description === undefined && input.url
      ? await fetchManualJobContent(input.url, deps)
      : null;
  const text = (input.description ?? fetched?.content ?? "").trim();
  if (!text) {
    throw badRequest(
      "The page had no readable text. Pass the job posting as description instead.",
    );
  }

  const inferred = await inferManualJobDetails(
    manualJobInferenceSchema.parse({ jobDescription: text }).jobDescription,
  );
  const draft: ManualJobDraft = inferred.job ?? {};
  const overrides = input.overrides ?? {};

  const fields: Partial<ImportJobFields> = {};
  for (const field of POSTING_TEXT_FIELDS) {
    const value =
      cleanOptional(overrides[field as keyof PostingOverrides]) ??
      acceptedDraftValue(field, draft[field]);
    if (value) fields[field] = value;
  }
  const jobUrl =
    cleanOptional(overrides.jobUrl) ??
    fetched?.url ??
    cleanOptional(input.url) ??
    acceptedDraftValue("jobUrl", draft.jobUrl);
  const applicationLink =
    cleanOptional(overrides.applicationLink) ??
    acceptedDraftValue("applicationLink", draft.applicationLink);

  const missing = [
    ...(fields.title ? [] : ["title"]),
    ...(fields.employer ? [] : ["employer"]),
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
      ...(input.process === undefined ? {} : { skipTailoring: !input.process }),
      job: {
        ...fields,
        jobUrl,
        applicationLink,
        jobDescription: text.slice(0, MANUAL_JOB_DESCRIPTION_MAX_CHARS),
      },
    }),
  );
  return { job, warning: inferred.warning ?? null };
}
