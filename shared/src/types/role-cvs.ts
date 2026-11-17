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
