import type {
  CreateRoleCvInput,
  Job,
  RoleCv,
  RoleCvsListResponse,
  UpdateRoleCvInput,
} from "@shared/types";
import { fetchApi, fetchBlobApi, withQuery } from "./core";

function roleCvPath(id: string, suffix = ""): string {
  return `/role-cvs/${encodeURIComponent(id)}${suffix}`;
}

export async function getRoleCvs(): Promise<RoleCv[]> {
  const response = await fetchApi<RoleCvsListResponse>("/role-cvs");
  return response.roleCvs;
}

export async function createRoleCv(input: CreateRoleCvInput): Promise<RoleCv> {
  return fetchApi<RoleCv>("/role-cvs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateRoleCv(
  id: string,
  input: UpdateRoleCvInput,
): Promise<RoleCv> {
  return fetchApi<RoleCv>(roleCvPath(id), {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deleteRoleCv(id: string): Promise<void> {
  await fetchApi<{ id: string; deleted: boolean }>(roleCvPath(id), {
    method: "DELETE",
  });
}

export async function generateRoleCv(id: string): Promise<RoleCv> {
  return fetchApi<RoleCv>(roleCvPath(id, "/generate"), { method: "POST" });
}

export async function generateRoleCvPdf(id: string): Promise<RoleCv> {
  return fetchApi<RoleCv>(roleCvPath(id, "/generate-pdf"), { method: "POST" });
}

export async function getRoleCvPdfBlob(id: string): Promise<Blob> {
  return fetchBlobApi(
    withQuery(roleCvPath(id, "/pdf"), { v: Date.now().toString(36) }),
    { cache: "no-store" },
  );
}

function jobRoleCvPath(jobId: string, suffix = ""): string {
  return `/jobs/${encodeURIComponent(jobId)}/role-cv${suffix}`;
}

/** Auto-picks the best Role CV for a job (or none). */
export async function matchJobRoleCv(jobId: string): Promise<Job> {
  return fetchApi<Job>(jobRoleCvPath(jobId, "/match"), { method: "POST" });
}

/** Sets a job's Role CV by hand; `null` means no Role CV. */
export async function setJobRoleCv(
  jobId: string,
  roleCvId: string | null,
): Promise<Job> {
  return fetchApi<Job>(jobRoleCvPath(jobId), {
    method: "PUT",
    body: JSON.stringify({ roleCvId }),
  });
}

/** Copies the job's Role CV into its tailoring fields (no AI call). */
export async function applyJobRoleCv(jobId: string): Promise<Job> {
  return fetchApi<Job>(jobRoleCvPath(jobId, "/apply"), {
    method: "POST",
    body: JSON.stringify({}),
  });
}

/** Tailors the job's CV starting from its Role CV. */
export async function refineJobRoleCv(jobId: string): Promise<Job> {
  return fetchApi<Job>(jobRoleCvPath(jobId, "/refine"), {
    method: "POST",
    body: JSON.stringify({}),
  });
}
