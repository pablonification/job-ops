/**
 * Role CVs: named CV variants tailored to a target role, generated from the
 * master resume. Field encodings match the per-job tailoring fields on `Job`
 * (`tailoredSkills` is a JSON string of skill groups, `selectedProjectIds` is a
 * CSV of AI-selected project ids) so the existing tailoring helpers apply.
 */

export type RoleCvPdfFreshness =
  | "missing"
  | "current"
  | "stale"
  | "regenerating";

export interface RoleCvSkillGroup {
  name: string;
  keywords: string[];
}

export interface RoleCv {
  id: string;
  name: string;
  roleDescription: string;
  tailoredHeadline: string | null;
  tailoredSummary: string | null;
  /** JSON string of `RoleCvSkillGroup[]`, same encoding as `Job.tailoredSkills`. */
  tailoredSkills: string | null;
  /** CSV of project ids, same encoding as `Job.selectedProjectIds`. */
  selectedProjectIds: string | null;
  /** Master-resume revision token captured when the content was generated. */
  masterResumeRevision: string | null;
  generatedAt: string | null;
  /** True when the master resume changed since the content was generated. */
  isStale: boolean;
  pdfFreshness: RoleCvPdfFreshness;
  pdfGeneratedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoleCvsListResponse {
  roleCvs: RoleCv[];
}

export interface CreateRoleCvInput {
  name: string;
  roleDescription: string;
}

export interface UpdateRoleCvInput {
  name?: string;
  roleDescription?: string;
  tailoredHeadline?: string | null;
  tailoredSummary?: string | null;
  tailoredSkills?: string | null;
  selectedProjectIds?: string | null;
}

/**
 * Parsed tailoring content of a Role CV, in the shape the tailoring and PDF
 * services consume.
 */
export interface RoleCvTailoringContent {
  headline: string;
  summary: string;
  skills: RoleCvSkillGroup[];
  selectedProjectIds: string[];
}

/** How a job's Role CV reference was chosen. */
export const ROLE_CV_MATCH_SOURCE_VALUES = ["auto", "manual"] as const;
export type RoleCvMatchSource = (typeof ROLE_CV_MATCH_SOURCE_VALUES)[number];

/**
 * How auto-tailoring (pipeline, "move to ready", manual import) uses Role CVs.
 * - `off`: ignore Role CVs.
 * - `as_is`: copy the job's Role CV into its tailoring fields (no model call).
 * - `refine`: tailor for the job, starting from the job's Role CV.
 */
export const ROLE_CV_PIPELINE_MODE_VALUES = ["off", "as_is", "refine"] as const;
export type RoleCvPipelineMode = (typeof ROLE_CV_PIPELINE_MODE_VALUES)[number];

export interface SetJobRoleCvInput {
  roleCvId: string | null;
}

/** Optional Role CV to use instead of the job's current one. */
export interface UseJobRoleCvInput {
  roleCvId?: string;
}
