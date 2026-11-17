import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, lt, ne, or, type SQL, sql } from "drizzle-orm";
import { db, schema } from "../db/index";
import {
  getPrivateDataScope,
  privateDataScopeFilter,
} from "../tenancy/private-scope";

const { roleCvs } = schema;

export type RoleCvRow = typeof roleCvs.$inferSelect;

export type RoleCvRowUpdate = Partial<
  Pick<
    RoleCvRow,
    | "name"
    | "roleDescription"
    | "tailoredHeadline"
    | "tailoredSummary"
    | "tailoredSkills"
    | "selectedProjectIds"
    | "masterResumeRevision"
    | "generatedAt"
    | "pdfPath"
    | "pdfFingerprint"
    | "pdfGeneratedAt"
    | "pdfRegeneratingSince"
  >
>;

function scopeFilter(): SQL {
  return privateDataScopeFilter(roleCvs);
}

export async function listRoleCvRows(): Promise<RoleCvRow[]> {
  return db
    .select()
    .from(roleCvs)
    .where(scopeFilter())
    .orderBy(desc(roleCvs.updatedAt), desc(roleCvs.createdAt));
}

export async function getRoleCvRowById(id: string): Promise<RoleCvRow | null> {
  const [row] = await db
    .select()
    .from(roleCvs)
    .where(and(scopeFilter(), eq(roleCvs.id, id)))
    .limit(1);
  return row ?? null;
}

/** Case-insensitive name lookup within the active private data scope. */
export async function roleCvNameExists(input: {
  name: string;
  excludingId?: string;
}): Promise<boolean> {
  const clauses = [
    scopeFilter(),
    sql`lower(${roleCvs.name}) = lower(${input.name})`,
  ];
  if (input.excludingId) {
    clauses.push(ne(roleCvs.id, input.excludingId));
  }
  const [row] = await db
    .select({ id: roleCvs.id })
    .from(roleCvs)
    .where(and(...clauses))
    .limit(1);
  return Boolean(row);
}

export async function insertRoleCvRow(input: {
  name: string;
  roleDescription: string;
}): Promise<RoleCvRow> {
  const scope = getPrivateDataScope();
  const now = new Date().toISOString();
  const id = randomUUID();
  await db.insert(roleCvs).values({
    id,
    tenantId: scope.tenantId,
    userId: scope.userId,
    name: input.name,
    roleDescription: input.roleDescription,
    createdAt: now,
    updatedAt: now,
  });
  const row = await getRoleCvRowById(id);
  if (!row) {
    throw new Error("Failed to read back the created Role CV");
  }
  return row;
}

export async function updateRoleCvRow(
  id: string,
  input: RoleCvRowUpdate,
): Promise<RoleCvRow | null> {
  await db
    .update(roleCvs)
    .set({ ...input, updatedAt: new Date().toISOString() })
    .where(and(scopeFilter(), eq(roleCvs.id, id)));
  return getRoleCvRowById(id);
}

export async function deleteRoleCvRow(id: string): Promise<number> {
  const result = await db
    .delete(roleCvs)
    .where(and(scopeFilter(), eq(roleCvs.id, id)));
  return result.changes;
}

/**
 * Compare-and-set claim of the PDF regeneration lock. Returns false when
 * another regeneration holds a lock newer than `staleBefore`.
 */
export async function claimRoleCvPdfRegeneration(input: {
  id: string;
  claimedAt: string;
  staleBefore: string;
}): Promise<boolean> {
  const result = await db
    .update(roleCvs)
    .set({ pdfRegeneratingSince: input.claimedAt })
    .where(
      and(
        scopeFilter(),
        eq(roleCvs.id, input.id),
        or(
          isNull(roleCvs.pdfRegeneratingSince),
          lt(roleCvs.pdfRegeneratingSince, input.staleBefore),
        ),
      ),
    );
  return result.changes === 1;
}

/** Releases the PDF lock only if it is still held by `claimedAt`. */
export async function releaseRoleCvPdfRegeneration(input: {
  id: string;
  claimedAt: string;
  update?: RoleCvRowUpdate;
}): Promise<boolean> {
  const result = await db
    .update(roleCvs)
    .set({
      ...(input.update ?? {}),
      pdfRegeneratingSince: null,
      ...(input.update ? { updatedAt: new Date().toISOString() } : {}),
    })
    .where(
      and(
        scopeFilter(),
        eq(roleCvs.id, input.id),
        eq(roleCvs.pdfRegeneratingSince, input.claimedAt),
      ),
    );
  return result.changes === 1;
}
