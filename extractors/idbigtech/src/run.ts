import {
  collectPages,
  ID_BIG_TECH_COMPANY_IDS,
  type IdBigTechCompanyId,
  isRelevantJobTitle,
  type JobBoardRunOptions,
  type PoliteJsonClient,
  runJobBoard,
  type TermSearchContext,
  TimeBudgetExceededError,
} from "@shared/extractors/indonesia/index.js";
import type { ExtractorRunResult } from "@shared/types/extractors";
import type { CreateJobInput } from "@shared/types/jobs";
import { COMPANY_FETCHERS } from "./companies";
import {
  type CompanyClient,
  type CompanyFetcher,
  type CompanyPosting,
  type CompanyRequestContext,
  ID_BIG_TECH_LABEL,
} from "./types";

export interface RunIdBigTechOptions extends JobBoardRunOptions {
  /** Companies to scan, in any order; defaults to all of them. */
  companies?: readonly IdBigTechCompanyId[];
  /** Replaces individual fetchers (tests). */
  fetchers?: Partial<Record<IdBigTechCompanyId, CompanyFetcher>>;
  /** Already-imported job URLs; their detail requests are skipped. */
  getExistingJobUrls?: () => Promise<string[]>;
}

function companyClient(client: PoliteJsonClient, label: string): CompanyClient {
  return {
    getJson: (url, options) => client.getJson(url, { label, ...options }),
    postJson: (url, body, options) =>
      client.postJson(url, body, { label, ...options }),
    getText: (url, options) => client.getText(url, { label, ...options }),
  };
}

function errorMessage(label: string, error: unknown): string {
  const message =
    error instanceof Error ? error.message : "unexpected extractor error";
  return message.startsWith(label) ? message : `${label}: ${message}`;
}

/** Collects a company's postings for one term, up to the per-term cap. */
class TermCandidates {
  readonly postings: CompanyPosting[] = [];
  private readonly urls = new Set<string>();

  constructor(private readonly term: TermSearchContext) {}

  get full(): boolean {
    return this.postings.length >= this.term.maxJobs;
  }

  consider(posting: CompanyPosting): "added" | "duplicate" | "filtered" {
    const { job } = posting;
    if (!isRelevantJobTitle(job.title, this.term.searchTerm)) return "filtered";
    if (this.term.isCollected(job.jobUrl) || this.urls.has(job.jobUrl)) {
      return "duplicate";
    }
    if (!this.term.matchesCities(job)) return "filtered";
    this.urls.add(job.jobUrl);
    this.postings.push(posting);
    return "added";
  }
}

/**
 * Scans the enabled companies for every search term. For each term, each
 * company lists its postings (by keyword where its API has a search, or from
 * its whole board, listed once per run), keeps the ones whose title matches
 * the term and that are in Indonesia and the requested cities, then fetches
 * details for postings that are not already in job-ops.
 *
 * A company that fails is reported as a source error and the others carry on;
 * the source fails only when no enabled company could be listed.
 */
export async function runIdBigTech(
  options: RunIdBigTechOptions = {},
): Promise<ExtractorRunResult> {
  const enabled = new Set(options.companies ?? ID_BIG_TECH_COMPANY_IDS);
  const fetchers = ID_BIG_TECH_COMPANY_IDS.filter((id) => enabled.has(id)).map(
    (id) => options.fetchers?.[id] ?? COMPANY_FETCHERS[id],
  );
  if (fetchers.length === 0) {
    return {
      success: false,
      jobs: [],
      error: `${ID_BIG_TECH_LABEL}: no companies are enabled; choose at least one in Settings`,
    };
  }

  const listed = new Set<IdBigTechCompanyId>();
  const boards = new Map<IdBigTechCompanyId, Promise<CompanyPosting[]>>();
  const reportedBoardFailures = new Set<IdBigTechCompanyId>();
  let knownUrlsPromise: Promise<Set<string>> | null = null;
  const getKnownUrls = (): Promise<Set<string>> => {
    knownUrlsPromise ??= (
      options.getExistingJobUrls?.() ?? Promise.resolve([])
    ).then(
      (urls) => new Set(urls),
      () => new Set<string>(),
    );
    return knownUrlsPromise;
  };

  async function listBoard(
    fetcher: CompanyFetcher,
    context: CompanyRequestContext,
    term: TermSearchContext,
  ): Promise<CompanyPosting[]> {
    const postings: CompanyPosting[] = [];
    let offset = 0;
    for (let number = 1; number <= fetcher.maxPages; number += 1) {
      if (term.shouldStop()) break;
      const page = await fetcher.fetchPage(context, {
        searchTerm: "",
        number,
        offset,
        limit: fetcher.pageSize,
      });
      for (const item of page.items) {
        const posting = fetcher.toPosting(item, context);
        if (posting) postings.push(posting);
      }
      offset += page.items.length;
      if (!page.hasMore || page.items.length === 0) break;
    }
    return postings;
  }

  async function findCandidates(
    fetcher: CompanyFetcher,
    context: CompanyRequestContext,
    term: TermSearchContext,
  ): Promise<CompanyPosting[]> {
    const candidates = new TermCandidates(term);
    if (fetcher.listing === "board") {
      let board = boards.get(fetcher.id);
      if (!board) {
        board = listBoard(fetcher, context, term);
        boards.set(fetcher.id, board);
      }
      for (const posting of await board) {
        if (candidates.full) break;
        candidates.consider(posting);
      }
      return candidates.postings;
    }

    await collectPages(
      { ...term, pageSize: fetcher.pageSize },
      {
        fetchPage: async ({ number, offset, limit }) => {
          const page = await fetcher.fetchPage(context, {
            searchTerm: term.searchTerm,
            number,
            offset,
            limit,
          });
          return {
            items: page.items,
            hasMore: page.hasMore && number < fetcher.maxPages,
          };
        },
        toJob: (item) => fetcher.toPosting(item, context)?.job ?? null,
        consume: (job, item) => candidates.consider({ job, item }),
      },
    );
    return candidates.postings;
  }

  /** Fetches details where needed and hands jobs to the runner; returns jobs added. */
  async function completeAndAccept(
    fetcher: CompanyFetcher,
    context: CompanyRequestContext,
    candidates: readonly CompanyPosting[],
    term: TermSearchContext,
  ): Promise<number> {
    let added = 0;
    const accept = (job: CreateJobInput) => {
      if (term.accept(job) === "added") added += 1;
    };
    if (!fetcher.fetchDetail) {
      for (const { job } of candidates) accept(job);
      return added;
    }

    const knownUrls = candidates.length > 0 ? await getKnownUrls() : null;
    let detailsFetched = 0;
    let detailsSkipped = 0;
    let detailFailures = 0;
    for (const posting of candidates) {
      if (term.shouldStop()) break;
      if (knownUrls?.has(posting.job.jobUrl)) {
        detailsSkipped += 1;
        accept(posting.job);
      } else {
        try {
          const detailed = await fetcher.fetchDetail(context, posting);
          if (detailed) accept(detailed);
        } catch (error) {
          if (error instanceof TimeBudgetExceededError) throw error;
          detailFailures += 1;
        }
        detailsFetched += 1;
      }
      term.reportDetails({
        detailsTotal: candidates.length,
        detailsFetched,
        detailsSkipped,
      });
    }
    if (detailFailures > 0) {
      term.reportError(
        `${fetcher.label}: ${detailFailures} job detail request(s) failed; those jobs were not imported and will be retried on the next run`,
      );
    }
    return added;
  }

  return runJobBoard({
    label: ID_BIG_TECH_LABEL,
    options,
    maxPageSize: 50,
    shouldFail: () => fetchers.every((fetcher) => !listed.has(fetcher.id)),
    runTerm: async (term) => {
      for (const fetcher of fetchers) {
        if (term.shouldStop()) break;
        const context: CompanyRequestContext = {
          client: companyClient(term.client, fetcher.label),
          cities: term.cities,
        };
        term.reportProgress(`${fetcher.label}: searching`);
        try {
          const candidates = await findCandidates(fetcher, context, term);
          listed.add(fetcher.id);
          const added = await completeAndAccept(
            fetcher,
            context,
            candidates,
            term,
          );
          term.reportProgress(
            `${fetcher.label}: ${added} new job${added === 1 ? "" : "s"}`,
          );
        } catch (error) {
          if (error instanceof TimeBudgetExceededError) throw error;
          const boardFailed = fetcher.listing === "board";
          if (boardFailed && reportedBoardFailures.has(fetcher.id)) continue;
          if (boardFailed) reportedBoardFailures.add(fetcher.id);
          term.reportError(errorMessage(fetcher.label, error));
          term.reportProgress(`${fetcher.label}: failed`);
        }
      }
    },
  });
}
