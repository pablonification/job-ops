import { notFound } from "@infra/errors";
import {
  defineTool,
  defineToolGroup,
  JOB_STATUS_VALUES,
  loadTargetCompanyMatcher,
  paginationShape,
  toCompactJobSummary,
  toPageMeta,
} from "@server/mcp/kit";
import {
  JOB_SEARCH_SORT_VALUES,
  type JobSearchFilters,
  listDistinctEmployers,
  searchJobs,
} from "@server/repositories/job-search";
import * as jobsRepo from "@server/repositories/jobs";
import {
  applyJobPdfFreshness,
  resolvePdfFingerprintContext,
} from "@server/services/pdf-fingerprint";
import type { TargetCompanyMatcher } from "@shared/target-companies";
import { z } from "zod";

const dateInput = (description: string) =>
  z
    .string()
    .trim()
    .min(1)
    .refine((value) => !Number.isNaN(Date.parse(value)), {
      message: "Expected an ISO date such as 2026-11-01",
    })
    .transform((value) => new Date(value).toISOString())
    .describe(description);

const listJobsInput = z
  .object({
    statuses: z
      .array(z.enum(JOB_STATUS_VALUES))
      .max(JOB_STATUS_VALUES.length)
      .optional()
      .describe(
        "Only these statuses. discovered = new, ready = tailored with PDF, applied/in_progress = tracked applications.",
      ),
    query: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe(
        "Free text. Every word must appear in the title, employer or location (case-insensitive).",
      ),
    minScore: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe(
        "Minimum suitability score (0-100). Unscored jobs are excluded.",
      ),
    maxScore: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe(
        "Maximum suitability score (0-100). Unscored jobs are excluded.",
      ),
    sources: z
      .array(z.string().trim().min(1).max(64))
      .max(50)
      .optional()
      .describe(
        "Only jobs from these source ids, e.g. linkedin, indeed, manual.",
      ),
    employer: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("Employer name contains this text (case-insensitive)."),
    postedSince: dateInput(
      "Posted on or after this ISO date. Jobs without a posted date are excluded.",
    ).optional(),
    discoveredSince: dateInput(
      "Discovered (added to JobOps) on or after this ISO date.",
    ).optional(),
    hasPdf: z
      .boolean()
      .optional()
      .describe(
        "true: only jobs with a resume PDF; false: only jobs without one.",
      ),
    targetCompany: z
      .boolean()
      .optional()
      .describe(
        "true: only jobs at the user's target companies (Settings > Scoring); false: only other jobs.",
      ),
    sort: z
      .enum(JOB_SEARCH_SORT_VALUES)
      .default("discovered_desc")
      .describe("Sort order. Default discovered_desc (newest first)."),
    ...paginationShape,
  })
  .strict();

const listJobs = defineTool({
  name: "list_jobs",
  title: "List and search jobs",
  description:
    "List and search the user's jobs with filters (status, text, score, source, employer, target company, dates, PDF) and pagination. Returns compact summaries plus total and nextOffset; call get_job for the full description and tailoring.",
  scope: "read",
  input: listJobsInput,
  handler: async (input) => {
    const { limit, offset, sort, targetCompany, ...baseFilters } = input;
    const targetCompanies = await loadTargetCompanyMatcher();
    const filters = await withTargetCompanyFilter(
      baseFilters,
      targetCompany,
      targetCompanies,
    );
    const { total, rows } = filters
      ? await searchJobs({ filters, sort, limit, offset })
      : { total: 0, rows: [] };
    return {
      jobs: rows.map((row) => toCompactJobSummary(row, { targetCompanies })),
      ...toPageMeta({ limit, offset, total, returned: rows.length }),
    };
  },
});

/**
 * The target-company flag is computed in code, not stored. To keep SQL paging
 * and `total` exact, resolve it first into the exact employer names (among
 * jobs matching the other filters) that are or are not target companies.
 * Returns null when nothing can match.
 */
async function withTargetCompanyFilter(
  filters: JobSearchFilters,
  targetCompany: boolean | undefined,
  matcher: TargetCompanyMatcher,
): Promise<JobSearchFilters | null> {
  if (targetCompany === undefined) return filters;
  if (matcher.isEmpty) return targetCompany ? null : filters;
  const matched = (await listDistinctEmployers(filters)).filter((employer) =>
    matcher.matches(employer),
  );
  if (targetCompany) {
    return matched.length > 0 ? { ...filters, employerIn: matched } : null;
  }
  return { ...filters, employerNotIn: matched };
}

const getJobInput = z
  .object({
    jobId: z.string().trim().min(1).max(200).describe("Job id from list_jobs."),
    includeDescription: z
      .boolean()
      .default(true)
      .describe("Include the job description. Default true."),
    descriptionMaxChars: z
      .number()
      .int()
      .min(200)
      .max(200_000)
      .optional()
      .describe(
        "Truncate the description to this many characters. Omit for the full text.",
      ),
  })
  .strict();

const getJob = defineTool({
  name: "get_job",
  title: "Get job details",
  description:
    "Full details of one job: description, suitability score and reason, target-company flag, tailored resume fields, PDF state, application status and dates.",
  scope: "read",
  maxResultSizeChars: 200_000,
  input: getJobInput,
  handler: async (input) => {
    const job = await jobsRepo.getJobById(input.jobId);
    if (!job) throw notFound("Job not found");
    const hydrated = applyJobPdfFreshness(
      job,
      await resolvePdfFingerprintContext(),
    );
    const fullDescription = hydrated.jobDescription ?? "";
    let jobDescription: string | null = hydrated.jobDescription;
    let descriptionTruncated = false;
    if (!input.includeDescription) {
      jobDescription = null;
      descriptionTruncated = fullDescription.length > 0;
    } else if (
      input.descriptionMaxChars !== undefined &&
      fullDescription.length > input.descriptionMaxChars
    ) {
      jobDescription = fullDescription.slice(0, input.descriptionMaxChars);
      descriptionTruncated = true;
    }
    const targetCompanies = await loadTargetCompanyMatcher();
    return {
      job: {
        ...hydrated,
        jobDescription,
        isTargetCompany: targetCompanies.matches(hydrated.employer),
      },
      descriptionLength: fullDescription.length,
      descriptionTruncated,
    };
  },
});

const getJobCounts = defineTool({
  name: "get_job_counts",
  title: "Count jobs by status",
  description:
    "Number of the user's jobs in each status (discovered, processing, ready, applied, in_progress, skipped, expired) and the total.",
  scope: "read",
  input: z.object({}).strict(),
  handler: async () => {
    const byStatus = await jobsRepo.getJobStats();
    const total = Object.values(byStatus).reduce(
      (sum, count) => sum + count,
      0,
    );
    return { total, byStatus };
  },
});

export const jobsReadToolGroup = defineToolGroup({
  id: "jobs-read",
  tools: [listJobs, getJob, getJobCounts],
});
