import type { TargetCompanyMatcher } from "@shared/target-companies";
import type { Job, JobStatus } from "@shared/types";

/** Every job status, for tool input enums. */
export const JOB_STATUS_VALUES = [
  "discovered",
  "processing",
  "ready",
  "applied",
  "in_progress",
  "skipped",
  "expired",
] as const satisfies readonly JobStatus[];

/** Fields needed to build a compact summary; a full `Job` also fits. */
export type CompactJobSummarySource = Pick<
  Job,
  | "id"
  | "title"
  | "employer"
  | "location"
  | "status"
  | "outcome"
  | "suitabilityScore"
  | "sponsorMatchScore"
  | "source"
  | "salary"
  | "salaryMinAmount"
  | "salaryMaxAmount"
  | "salaryCurrency"
  | "jobType"
  | "datePosted"
  | "deadline"
  | "discoveredAt"
  | "appliedAt"
  | "updatedAt"
  | "jobUrl"
  | "pdfPath"
  | "pdfRegenerating"
>;

/**
 * Pass the request's target-company matcher (load it once with
 * `loadTargetCompanyMatcher()`) so `isTargetCompany` reflects the setting.
 */
export type CompactJobSummaryOptions = {
  targetCompanies: TargetCompanyMatcher;
};

/**
 * The job shape list-style tools return. No description or other long fields:
 * agents fetch those with `get_job`.
 */
export type CompactJobSummary = {
  id: string;
  title: string;
  employer: string;
  location: string | null;
  status: JobStatus;
  outcome: string | null;
  /** Employer matches the user's Target companies setting. */
  isTargetCompany: boolean;
  score: number | null;
  sponsorMatchScore: number | null;
  source: string;
  salary: string | null;
  jobType: string | null;
  datePosted: string | null;
  deadline: string | null;
  discoveredAt: string;
  appliedAt: string | null;
  updatedAt: string;
  hasPdf: boolean;
  pdfRegenerating: boolean;
  jobUrl: string;
};

function formatSalary(job: CompactJobSummarySource): string | null {
  if (job.salary?.trim()) return job.salary.trim();
  const { salaryMinAmount: min, salaryMaxAmount: max } = job;
  if (min == null && max == null) return null;
  const currency = job.salaryCurrency ? ` ${job.salaryCurrency}` : "";
  if (min != null && max != null && min !== max) {
    return `${min}-${max}${currency}`;
  }
  return `${min ?? max}${currency}`;
}

export function toCompactJobSummary(
  job: CompactJobSummarySource,
  options: CompactJobSummaryOptions,
): CompactJobSummary {
  return {
    id: job.id,
    title: job.title,
    employer: job.employer,
    location: job.location,
    status: job.status,
    outcome: job.outcome,
    isTargetCompany: options.targetCompanies.matches(job.employer),
    score: job.suitabilityScore,
    sponsorMatchScore: job.sponsorMatchScore,
    source: job.source,
    salary: formatSalary(job),
    jobType: job.jobType,
    datePosted: job.datePosted,
    deadline: job.deadline,
    discoveredAt: job.discoveredAt,
    appliedAt: job.appliedAt,
    updatedAt: job.updatedAt,
    hasPdf: Boolean(job.pdfPath),
    pdfRegenerating: job.pdfRegenerating,
    jobUrl: job.jobUrl,
  };
}
