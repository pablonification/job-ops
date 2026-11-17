/**
 * Filtered, paginated job queries for agent (MCP) callers. The REST list
 * endpoint returns every job; agents need SQL-side filtering and paging.
 */
import type { Job, JobStatus } from "@shared/types";
import {
  and,
  asc,
  desc,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  type SQL,
  sql,
} from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { db, schema } from "../db/index";
import { privateDataScopeFilter } from "../tenancy/private-scope";

const { jobs } = schema;

export const JOB_SEARCH_SORT_VALUES = [
  "discovered_desc",
  "discovered_asc",
  "score_desc",
  "score_asc",
  "posted_desc",
  "updated_desc",
] as const;

export type JobSearchSort = (typeof JOB_SEARCH_SORT_VALUES)[number];

export type JobSearchFilters = {
  statuses?: JobStatus[];
  /** Whitespace-separated terms; each must match title, employer or location. */
  query?: string;
  minScore?: number;
  maxScore?: number;
  sources?: string[];
  /** Case-insensitive substring of the employer name. */
  employer?: string;
  /** ISO date or date-time; jobs without a parseable posted date are excluded. */
  postedSince?: string;
  /** ISO date or date-time. */
  discoveredSince?: string;
  hasPdf?: boolean;
  /** Exact employer names to keep (used for computed filters). */
  employerIn?: string[];
  /** Exact employer names to drop (used for computed filters). */
  employerNotIn?: string[];
};

export type JobSearchRow = Pick<
  Job,
  | "id"
  | "title"
  | "employer"
  | "location"
  | "status"
  | "outcome"
  | "suitabilityScore"
  | "sponsorMatchScore"
  | "source"
  | "salary"
  | "salaryMinAmount"
  | "salaryMaxAmount"
  | "salaryCurrency"
  | "jobType"
  | "datePosted"
  | "deadline"
  | "discoveredAt"
  | "appliedAt"
  | "updatedAt"
  | "jobUrl"
  | "pdfPath"
  | "pdfRegenerating"
>;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function containsIgnoreCase(column: SQLiteColumn | SQL, value: string) {
  const pattern = `%${escapeLike(value.toLowerCase())}%`;
  return sql`lower(coalesce(${column}, '')) LIKE ${pattern} ESCAPE '\\'`;
}

function buildWhere(filters: JobSearchFilters): SQL | undefined {
  const conditions: Array<SQL | undefined> = [privateDataScopeFilter(jobs)];

  if (filters.statuses && filters.statuses.length > 0) {
    conditions.push(inArray(jobs.status, filters.statuses));
  }
  if (filters.sources && filters.sources.length > 0) {
    conditions.push(inArray(jobs.source, filters.sources));
  }
  const terms = (filters.query ?? "")
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 10);
  for (const term of terms) {
    conditions.push(
      sql`(${containsIgnoreCase(jobs.title, term)} OR ${containsIgnoreCase(jobs.employer, term)} OR ${containsIgnoreCase(jobs.location, term)})`,
    );
  }
  if (filters.employer?.trim()) {
    conditions.push(containsIgnoreCase(jobs.employer, filters.employer.trim()));
  }
  if (filters.minScore !== undefined) {
    conditions.push(sql`${jobs.suitabilityScore} >= ${filters.minScore}`);
  }
  if (filters.maxScore !== undefined) {
    conditions.push(sql`${jobs.suitabilityScore} <= ${filters.maxScore}`);
  }
  if (filters.postedSince) {
    conditions.push(
      sql`datetime(${jobs.datePosted}) >= datetime(${filters.postedSince})`,
    );
  }
  if (filters.discoveredSince) {
    conditions.push(
      sql`datetime(${jobs.discoveredAt}) >= datetime(${filters.discoveredSince})`,
    );
  }
  if (filters.hasPdf === true) conditions.push(isNotNull(jobs.pdfPath));
  if (filters.hasPdf === false) conditions.push(isNull(jobs.pdfPath));
  if (filters.employerIn) {
    conditions.push(
      filters.employerIn.length > 0
        ? inArray(jobs.employer, filters.employerIn)
        : sql`0`,
    );
  }
  if (filters.employerNotIn && filters.employerNotIn.length > 0) {
    conditions.push(notInArray(jobs.employer, filters.employerNotIn));
  }

  return and(...conditions);
}

function buildOrderBy(sort: JobSearchSort): SQL[] {
  switch (sort) {
    case "discovered_asc":
      return [asc(jobs.discoveredAt), asc(jobs.id)];
    case "score_desc":
      return [
        sql`${jobs.suitabilityScore} IS NULL`,
        desc(jobs.suitabilityScore),
        desc(jobs.discoveredAt),
        asc(jobs.id),
      ];
    case "score_asc":
      return [
        sql`${jobs.suitabilityScore} IS NULL`,
        asc(jobs.suitabilityScore),
        desc(jobs.discoveredAt),
        asc(jobs.id),
      ];
    case "posted_desc":
      return [
        sql`datetime(${jobs.datePosted}) IS NULL`,
        sql`datetime(${jobs.datePosted}) DESC`,
        desc(jobs.discoveredAt),
        asc(jobs.id),
      ];
    case "updated_desc":
      return [desc(jobs.updatedAt), asc(jobs.id)];
    default:
      return [desc(jobs.discoveredAt), asc(jobs.id)];
  }
}

/**
 * Distinct employer names among the jobs matching the filters. Lets callers
 * apply a filter computed in code (such as target companies) as an exact
 * employer list, so SQL paging and `total` stay correct.
 */
export async function listDistinctEmployers(
  filters: JobSearchFilters,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ employer: jobs.employer })
    .from(jobs)
    .where(buildWhere(filters));
  return rows.map((row) => row.employer);
}

export async function searchJobs(input: {
  filters: JobSearchFilters;
  sort: JobSearchSort;
  limit: number;
  offset: number;
}): Promise<{ total: number; rows: JobSearchRow[] }> {
  const where = buildWhere(input.filters);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(jobs)
    .where(where);

  const rows = await db
    .select({
      id: jobs.id,
      title: jobs.title,
      employer: jobs.employer,
      location: jobs.location,
      status: jobs.status,
      outcome: jobs.outcome,
      suitabilityScore: jobs.suitabilityScore,
      sponsorMatchScore: jobs.sponsorMatchScore,
      source: jobs.source,
      salary: jobs.salary,
      salaryMinAmount: jobs.salaryMinAmount,
      salaryMaxAmount: jobs.salaryMaxAmount,
      salaryCurrency: jobs.salaryCurrency,
      jobType: jobs.jobType,
      datePosted: jobs.datePosted,
      deadline: jobs.deadline,
      discoveredAt: jobs.discoveredAt,
      appliedAt: jobs.appliedAt,
      updatedAt: jobs.updatedAt,
      jobUrl: jobs.jobUrl,
      pdfPath: jobs.pdfPath,
      pdfRegenerating: jobs.pdfRegenerating,
    })
    .from(jobs)
    .where(where)
    .orderBy(...buildOrderBy(input.sort))
    .limit(input.limit)
    .offset(input.offset);

  return {
    total: countRow?.count ?? 0,
    rows: rows.map((row) => ({
      ...row,
      source: row.source as Job["source"],
      status: row.status as JobStatus,
      pdfRegenerating: row.pdfRegenerating ?? false,
    })),
  };
}
