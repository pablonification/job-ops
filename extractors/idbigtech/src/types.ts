import type {
  IdBigTechCompanyId,
  PoliteJsonClient,
} from "@shared/extractors/indonesia/index.js";
import type { CreateJobInput } from "@shared/types/jobs";

export const ID_BIG_TECH_SOURCE = "idbigtech";
export const ID_BIG_TECH_LABEL = "Indonesia Big Tech";

/** The polite client, with this company's name in its error messages. */
export type CompanyClient = Pick<
  PoliteJsonClient,
  "getJson" | "postJson" | "getText"
>;

/** A list result mapped to a job, plus the raw item its detail request needs. */
export interface CompanyPosting {
  /** Built from list data: canonical `jobUrl`, real employer, Indonesian location. */
  job: CreateJobInput;
  item: unknown;
}

export interface CompanyRequestContext {
  client: CompanyClient;
  /** Cities the run asks for; empty means anywhere in Indonesia. */
  cities: readonly string[];
}

export interface CompanyListPage {
  items: readonly unknown[];
  hasMore: boolean;
}

/**
 * One company's careers site. The runner handles terms, caps, cities,
 * de-duplication, detail skipping, politeness and errors; a fetcher only knows
 * how to list, map and (optionally) complete that company's postings.
 */
export interface CompanyFetcher {
  id: IdBigTechCompanyId;
  /** Company name used in progress and error messages. */
  label: string;
  /**
   * `search`: the API takes the search term, so it is listed once per term.
   * `board`: the API returns every opening regardless of keyword, so it is
   * listed once per run and filtered by title for each term.
   */
  listing: "search" | "board";
  /** Results asked for per list request. */
  pageSize: number;
  /** Most list requests per term (`search`) or per run (`board`). */
  maxPages: number;
  fetchPage(
    context: CompanyRequestContext,
    page: {
      /** Empty for `board` listings. */
      searchTerm: string;
      /** 1-based page number. */
      number: number;
      offset: number;
      limit: number;
    },
  ): Promise<CompanyListPage>;
  /**
   * Maps a list item to a posting, or `null` when it is unusable or not based
   * in (or remote from) Indonesia.
   */
  toPosting(
    item: unknown,
    context: Pick<CompanyRequestContext, "cities">,
  ): CompanyPosting | null;
  /**
   * Optional detail request that completes the job (full description, apply
   * link). Resolves `null` when the posting is closed or turns out to be
   * outside Indonesia. Skipped for job URLs already in job-ops.
   */
  fetchDetail?(
    context: CompanyRequestContext,
    posting: CompanyPosting,
  ): Promise<CreateJobInput | null>;
}
