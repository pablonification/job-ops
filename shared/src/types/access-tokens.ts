/**
 * Personal access tokens let an agent (for example Claude Code over MCP)
 * act as the user who created them.
 */
export const ACCESS_TOKEN_SCOPES = ["read", "write"] as const;

export type AccessTokenScope = (typeof ACCESS_TOKEN_SCOPES)[number];

/** Every token starts with this marker so the auth guard can recognise it. */
export const ACCESS_TOKEN_MARKER = "jo_pat_";

export const ACCESS_TOKEN_MAX_EXPIRY_DAYS = 365;

export interface AccessTokenSummary {
  id: string;
  name: string;
  /** Non-secret display prefix, e.g. `jo_pat_3f9a1c7b2d4e`. */
  prefix: string;
  scope: AccessTokenScope;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface AccessTokenListResponse {
  tokens: AccessTokenSummary[];
  /** Absolute MCP endpoint URL for this instance, when it can be resolved. */
  mcpUrl: string | null;
}

export interface CreateAccessTokenInput {
  name: string;
  scope: AccessTokenScope;
  /** Omit or null for a token that never expires. */
  expiresInDays?: number | null;
}

export interface CreateAccessTokenResponse {
  token: AccessTokenSummary;
  /** The full secret. Returned once, at creation, and never again. */
  secret: string;
  mcpUrl: string | null;
}
