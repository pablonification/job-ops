import type {
  CreateRoleCvInput,
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
