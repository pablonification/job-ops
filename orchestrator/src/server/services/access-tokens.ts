/**
 * Personal access tokens (`jo_pat_<prefix>_<secret>`).
 *
 * - The secret is 32 random bytes (base64url). Only a SHA-256 hash of the full
 *   token is stored; a fast hash is appropriate for a high-entropy secret.
 * - The prefix is random, unique and not secret. It is used to find the row
 *   and as the display handle in Settings.
 * - Verification compares hashes with `timingSafeEqual`.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { badRequest, notFound } from "@infra/errors";
import { logger } from "@infra/logger";
import { sanitizeUnknown } from "@infra/sanitize";
import * as accessTokensRepo from "@server/repositories/access-tokens";
import {
  ACCESS_TOKEN_MARKER,
  ACCESS_TOKEN_MAX_EXPIRY_DAYS,
  type AccessTokenScope,
  type AccessTokenSummary,
} from "@shared/types";

const PREFIX_BYTES = 6;
const SECRET_BYTES = 32;
const ACCESS_TOKEN_PATTERN = /^jo_pat_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const LAST_USED_WRITE_INTERVAL_MS = 60_000;
const MAX_CREATE_ATTEMPTS = 3;
export const MAX_ACTIVE_ACCESS_TOKENS_PER_USER = 25;

export type AuthenticatedAccessToken = {
  tokenId: string;
  tenantId: string;
  userId: string;
  scope: AccessTokenScope;
};

export function isAccessTokenCandidate(rawToken: string): boolean {
  return rawToken.startsWith(ACCESS_TOKEN_MARKER);
}

export function hashAccessToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateAccessToken(): { token: string; prefix: string } {
  const prefix = randomBytes(PREFIX_BYTES).toString("hex");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  return { token: `${ACCESS_TOKEN_MARKER}${prefix}_${secret}`, prefix };
}

function parseAccessTokenPrefix(rawToken: string): string | null {
  const match = ACCESS_TOKEN_PATTERN.exec(rawToken);
  return match?.[1] ?? null;
}

function hashesMatch(expectedHex: string, actualHex: string): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(actualHex, "hex");
  if (expected.length !== actual.length || expected.length === 0) return false;
  return timingSafeEqual(expected, actual);
}

export function toAccessTokenSummary(
  record: accessTokensRepo.AccessTokenRecord,
): AccessTokenSummary {
  return {
    id: record.id,
    name: record.name,
    prefix: `${ACCESS_TOKEN_MARKER}${record.tokenPrefix}`,
    scope: record.scope,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
  };
}

function isPrefixConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed: access_tokens\.token_prefix/i.test(error.message)
  );
}

export async function createAccessToken(input: {
  tenantId: string;
  userId: string;
  name: string;
  scope: AccessTokenScope;
  expiresInDays?: number | null;
  now?: Date;
}): Promise<{ token: AccessTokenSummary; secret: string }> {
  const activeCount = await accessTokensRepo.countActiveAccessTokensForUser({
    tenantId: input.tenantId,
    userId: input.userId,
  });
  if (activeCount >= MAX_ACTIVE_ACCESS_TOKENS_PER_USER) {
    throw badRequest(
      `You can have at most ${MAX_ACTIVE_ACCESS_TOKENS_PER_USER} active access tokens. Revoke one first.`,
    );
  }

  const now = input.now ?? new Date();
  const expiresInDays = input.expiresInDays ?? null;
  if (
    expiresInDays !== null &&
    (!Number.isInteger(expiresInDays) ||
      expiresInDays < 1 ||
      expiresInDays > ACCESS_TOKEN_MAX_EXPIRY_DAYS)
  ) {
    throw badRequest(
      `Expiry must be between 1 and ${ACCESS_TOKEN_MAX_EXPIRY_DAYS} days.`,
    );
  }
  const expiresAt =
    expiresInDays === null
      ? null
      : new Date(now.getTime() + expiresInDays * 86_400_000).toISOString();

  for (let attempt = 1; ; attempt += 1) {
    const { token, prefix } = generateAccessToken();
    try {
      const record = await accessTokensRepo.createAccessTokenRecord({
        tenantId: input.tenantId,
        userId: input.userId,
        name: input.name,
        tokenPrefix: prefix,
        tokenHash: hashAccessToken(token),
        scope: input.scope,
        expiresAt,
      });
      return { token: toAccessTokenSummary(record), secret: token };
    } catch (error) {
      if (!isPrefixConflict(error) || attempt >= MAX_CREATE_ATTEMPTS) {
        throw error;
      }
    }
  }
}

export async function listAccessTokens(input: {
  tenantId: string;
  userId: string;
}): Promise<AccessTokenSummary[]> {
  const records = await accessTokensRepo.listAccessTokensForUser(input);
  return records.map(toAccessTokenSummary);
}

export async function revokeAccessToken(input: {
  id: string;
  tenantId: string;
  userId: string;
}): Promise<AccessTokenSummary> {
  const record = await accessTokensRepo.revokeAccessTokenForUser(input);
  if (!record) throw notFound("Access token not found");
  return toAccessTokenSummary(record);
}

/**
 * Resolves a raw bearer value to the token row it belongs to. Returns null for
 * malformed, unknown, revoked or expired tokens. The caller still has to load
 * the user and apply the same account checks as a session.
 */
export async function authenticateAccessToken(
  rawToken: string,
  now: Date = new Date(),
): Promise<AuthenticatedAccessToken | null> {
  const prefix = parseAccessTokenPrefix(rawToken);
  if (!prefix) return null;

  const record = await accessTokensRepo.findAccessTokenByPrefix(prefix);
  if (!record) return null;
  if (!hashesMatch(record.tokenHash, hashAccessToken(rawToken))) return null;
  if (record.revokedAt) return null;
  if (record.expiresAt) {
    const expiresAtMs = Date.parse(record.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) {
      return null;
    }
  }

  const lastUsedMs = record.lastUsedAt ? Date.parse(record.lastUsedAt) : NaN;
  if (
    !Number.isFinite(lastUsedMs) ||
    now.getTime() - lastUsedMs >= LAST_USED_WRITE_INTERVAL_MS
  ) {
    try {
      await accessTokensRepo.touchAccessTokenLastUsed(
        record.id,
        now.toISOString(),
      );
    } catch (error) {
      logger.warn("Failed to record access token use", {
        tokenId: record.id,
        error: sanitizeUnknown(error),
      });
    }
  }

  return {
    tokenId: record.id,
    tenantId: record.tenantId,
    userId: record.userId,
    scope: record.scope,
  };
}
