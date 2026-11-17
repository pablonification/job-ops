import type {
  AccessTokenListResponse,
  AccessTokenSummary,
  CreateAccessTokenInput,
  CreateAccessTokenResponse,
} from "@shared/types";
import { fetchApi } from "./core";

export async function listAccessTokens(): Promise<AccessTokenListResponse> {
  return fetchApi<AccessTokenListResponse>("/auth/tokens");
}

export async function createAccessToken(
  input: CreateAccessTokenInput,
): Promise<CreateAccessTokenResponse> {
  return fetchApi<CreateAccessTokenResponse>("/auth/tokens", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function revokeAccessToken(
  id: string,
): Promise<AccessTokenSummary> {
  return fetchApi<AccessTokenSummary>(
    `/auth/tokens/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}
