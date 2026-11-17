/**
 * Scheduler bookkeeping (`pipeline_schedule_state`) and the cross-tenant
 * lookups the scheduler needs.
 *
 * Unlike most repositories these functions take the tenant id explicitly:
 * the scheduler works across tenants from a background timer, and only
 * enters a tenant's request context once it knows which tenant and user a
 * run belongs to.
 */
import type {
  DigestDeliveryStatus,
  ScheduleAttemptOutcome,
} from "@shared/types";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db, schema } from "../db/index";

const { pipelineScheduleState, settings, tenantMemberships, users } = schema;

export type PipelineScheduleStateRow =
  typeof pipelineScheduleState.$inferSelect;

/**
 * Tenants with `scheduleEnabled` switched on. Reads across tenants on
 * purpose: this is how the scheduler finds work.
 */
export async function listTenantsWithScheduleEnabled(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ tenantId: settings.tenantId })
    .from(settings)
    .where(
      and(
        eq(settings.key, "scheduleEnabled"),
        inArray(settings.value, ["1", "true"]),
      ),
    );
  return rows.map((row) => row.tenantId).sort();
}

export async function getPipelineScheduleState(
  tenantId: string,
): Promise<PipelineScheduleStateRow | null> {
  const [row] = await db
    .select()
    .from(pipelineScheduleState)
    .where(eq(pipelineScheduleState.tenantId, tenantId))
    .limit(1);
  return row ?? null;
}

/**
 * Claims a scheduled occurrence (ISO instant) for the tenant. Returns true
 * only for the first caller to move `lastFiredOccurrence` forward to it; a
 * second tick in the same minute, a restart or a second process gets false.
 * The check and the write are one SQLite statement, so they cannot race.
 */
export async function claimScheduledOccurrence(args: {
  tenantId: string;
  occurrence: string;
  now: string;
}): Promise<boolean> {
  const result = await db
    .insert(pipelineScheduleState)
    .values({
      tenantId: args.tenantId,
      lastFiredOccurrence: args.occurrence,
      updatedAt: args.now,
    })
    .onConflictDoUpdate({
      target: pipelineScheduleState.tenantId,
      set: { lastFiredOccurrence: args.occurrence, updatedAt: args.now },
      setWhere: or(
        isNull(pipelineScheduleState.lastFiredOccurrence),
        lt(pipelineScheduleState.lastFiredOccurrence, args.occurrence),
      ),
    })
    .run();
  return result.changes === 1;
}

/** Records what happened when the schedule came due. */
export async function recordScheduleAttempt(args: {
  tenantId: string;
  attemptedAt: string;
  outcome: ScheduleAttemptOutcome;
  detail: string | null;
}): Promise<void> {
  await db
    .update(pipelineScheduleState)
    .set({
      lastAttemptAt: args.attemptedAt,
      lastOutcome: args.outcome,
      lastOutcomeDetail: args.detail,
      updatedAt: args.attemptedAt,
    })
    .where(eq(pipelineScheduleState.tenantId, args.tenantId));
}

/** Records the last digest delivery (sent or failed) for the Settings page. */
export async function recordDigestDelivery(args: {
  tenantId: string;
  at: string;
  status: DigestDeliveryStatus;
  detail: string | null;
}): Promise<void> {
  await db
    .insert(pipelineScheduleState)
    .values({
      tenantId: args.tenantId,
      lastDigestAt: args.at,
      lastDigestStatus: args.status,
      lastDigestDetail: args.detail,
      updatedAt: args.at,
    })
    .onConflictDoUpdate({
      target: pipelineScheduleState.tenantId,
      set: {
        lastDigestAt: args.at,
        lastDigestStatus: args.status,
        lastDigestDetail: args.detail,
        updatedAt: args.at,
      },
    });
}

/**
 * Remembers who last saved the schedule; scheduled runs run as them. Does
 * nothing for an id that is not a user (for example a test bypass context).
 */
export async function setPipelineScheduleOwner(args: {
  tenantId: string;
  userId: string;
  now: string;
}): Promise<void> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, args.userId))
    .limit(1);
  if (!user) return;
  await db
    .insert(pipelineScheduleState)
    .values({
      tenantId: args.tenantId,
      ownerUserId: args.userId,
      updatedAt: args.now,
    })
    .onConflictDoUpdate({
      target: pipelineScheduleState.tenantId,
      set: { ownerUserId: args.userId, updatedAt: args.now },
    });
}

export type ScheduleRunAsUser = {
  id: string;
  username: string;
  isSystemAdmin: boolean;
};

/**
 * The user a tenant's scheduled run runs as: the schedule's owner (who last
 * saved it) while they are an active member of the tenant, otherwise the
 * tenant's earliest active system admin, otherwise its earliest active
 * workspace owner. Null when the tenant has no active member.
 */
export async function findScheduleRunAsUser(
  tenantId: string,
  preferredUserId: string | null,
): Promise<ScheduleRunAsUser | null> {
  const [row] = await db
    .select({
      id: users.id,
      username: users.username,
      isSystemAdmin: users.isSystemAdmin,
    })
    .from(users)
    .innerJoin(tenantMemberships, eq(tenantMemberships.userId, users.id))
    .where(
      and(
        eq(tenantMemberships.tenantId, tenantId),
        eq(users.isDisabled, false),
      ),
    )
    .orderBy(
      // The schedule's owner first (while an active member), then system
      // admins, then workspace owners, oldest account first.
      ...(preferredUserId ? [desc(sql`${users.id} = ${preferredUserId}`)] : []),
      desc(users.isSystemAdmin),
      desc(sql`${tenantMemberships.role} = 'owner'`),
      asc(users.createdAt),
      asc(users.id),
    )
    .limit(1);
  return row ?? null;
}
