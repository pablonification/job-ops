import { randomUUID } from "node:crypto";
import type { AccessTokenScope } from "@shared/types";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db/index";

const { accessTokens } = schema;

export type AccessTokenRecord = {
  id: string;
  tenantId: string;
  userId: string;
  name: string;
  tokenPrefix: string;
  tokenHash: string;
  scope: AccessTokenScope;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

const tokenColumns = {
  id: accessTokens.id,
  tenantId: accessTokens.tenantId,
  userId: accessTokens.userId,
  name: accessTokens.name,
  tokenPrefix: accessTokens.tokenPrefix,
  tokenHash: accessTokens.tokenHash,
  scope: accessTokens.scope,
  expiresAt: accessTokens.expiresAt,
  lastUsedAt: accessTokens.lastUsedAt,
  revokedAt: accessTokens.revokedAt,
  createdAt: accessTokens.createdAt,
};

export async function createAccessTokenRecord(input: {
  tenantId: string;
  userId: string;
  name: string;
  tokenPrefix: string;
  tokenHash: string;
  scope: AccessTokenScope;
  expiresAt: string | null;
}): Promise<AccessTokenRecord> {
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(accessTokens).values({
    id,
    tenantId: input.tenantId,
    userId: input.userId,
    name: input.name,
    tokenPrefix: input.tokenPrefix,
    tokenHash: input.tokenHash,
    scope: input.scope,
    expiresAt: input.expiresAt,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  return {
    id,
    tenantId: input.tenantId,
    userId: input.userId,
    name: input.name,
    tokenPrefix: input.tokenPrefix,
    tokenHash: input.tokenHash,
    scope: input.scope,
    expiresAt: input.expiresAt,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: now,
  };
}

/**
 * Looked up without tenant or user scoping: a bearer token carries no JobOps
 * identity until this row resolves it. The prefix is not secret; the caller
 * must still compare the stored hash in constant time.
 */
export async function findAccessTokenByPrefix(
  tokenPrefix: string,
): Promise<AccessTokenRecord | null> {
  const [row] = await db
    .select(tokenColumns)
    .from(accessTokens)
    .where(eq(accessTokens.tokenPrefix, tokenPrefix))
    .limit(1);
  return row ?? null;
}

export async function listAccessTokensForUser(input: {
  tenantId: string;
  userId: string;
}): Promise<AccessTokenRecord[]> {
  return db
    .select(tokenColumns)
    .from(accessTokens)
    .where(
      and(
        eq(accessTokens.tenantId, input.tenantId),
        eq(accessTokens.userId, input.userId),
      ),
    )
    .orderBy(desc(accessTokens.createdAt), desc(accessTokens.id));
}

export async function countActiveAccessTokensForUser(input: {
  tenantId: string;
  userId: string;
}): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(accessTokens)
    .where(
      and(
        eq(accessTokens.tenantId, input.tenantId),
        eq(accessTokens.userId, input.userId),
        isNull(accessTokens.revokedAt),
      ),
    );
  return row?.count ?? 0;
}

/** Returns the revoked token, or null when the caller does not own it. */
export async function revokeAccessTokenForUser(input: {
  id: string;
  tenantId: string;
  userId: string;
}): Promise<AccessTokenRecord | null> {
  const ownership = and(
    eq(accessTokens.id, input.id),
    eq(accessTokens.tenantId, input.tenantId),
    eq(accessTokens.userId, input.userId),
  );
  const [existing] = await db
    .select(tokenColumns)
    .from(accessTokens)
    .where(ownership)
    .limit(1);
  if (!existing) return null;
  if (existing.revokedAt) return existing;

  const now = new Date().toISOString();
  await db
    .update(accessTokens)
    .set({ revokedAt: now, updatedAt: now })
    .where(ownership);
  return { ...existing, revokedAt: now };
}

export async function touchAccessTokenLastUsed(
  id: string,
  usedAt: string,
): Promise<void> {
  await db
    .update(accessTokens)
    .set({ lastUsedAt: usedAt })
    .where(eq(accessTokens.id, id));
}
