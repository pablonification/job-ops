/**
 * The user's saved Watchlist sources (career pages checked for new jobs).
 * Shared by `GET|PUT /api/watchlist/sources` and the MCP watchlist tools.
 */
import { unprocessableEntity } from "@infra/errors";
import { listCareerBoardSources } from "@server/config/career-boards";
import { isPublicLookingHttpUrl } from "@server/infra/http-url";
import * as watchlistRepo from "@server/repositories/watchlist";
import { getWatchlistSourceAdapter } from "@server/watchlist/adapters";
import {
  getWatchlistSourceTypeDescriptors,
  hydrateWatchlistSelectedSources,
} from "@server/watchlist/results";
import { MAX_WATCHLIST_SOURCES } from "@shared/types";
import { z } from "zod";

export const watchlistSelectionSchema = z.object({
  catalogSourceId: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .nullable()
    .optional()
    .describe(
      "Id of a catalog source (from catalogSources). Omit for a custom URL.",
    ),
  sourceType: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe("Source type, e.g. greenhouse, workday, bamboohr."),
  label: z.string().trim().min(1).max(200).nullable().optional(),
  careersUrl: z.string().trim().url().max(2000),
});

export const updateWatchlistSelectionsSchema = z.object({
  selections: z.array(watchlistSelectionSchema).max(MAX_WATCHLIST_SOURCES),
});

export type WatchlistSelectionInput = z.infer<typeof watchlistSelectionSchema>;

type CatalogSources = Awaited<ReturnType<typeof listCareerBoardSources>>;

function toWatchlistSourcesPayload(
  catalogSources: CatalogSources,
  selectedSources: Awaited<
    ReturnType<typeof watchlistRepo.listWatchlistSelectedSources>
  >,
) {
  return {
    catalogSources,
    selectedSources: hydrateWatchlistSelectedSources(selectedSources),
    availableSourceTypes: getWatchlistSourceTypeDescriptors(),
  };
}

export type WatchlistSourcesPayload = ReturnType<
  typeof toWatchlistSourcesPayload
>;

export async function getWatchlistSources(): Promise<WatchlistSourcesPayload> {
  const [catalogSources, selectedSources] = await Promise.all([
    listCareerBoardSources(),
    watchlistRepo.listWatchlistSelectedSources(),
  ]);
  return toWatchlistSourcesPayload(catalogSources, selectedSources);
}

/**
 * Replaces the saved Watchlist sources with `selections`. Catalog entries must
 * match the catalog URL; custom entries are normalised by their source type's
 * adapter (which may fetch the page). Throws UNPROCESSABLE_ENTITY for
 * duplicates, unknown catalog ids, unsupported types and invalid URLs.
 */
export async function replaceWatchlistSources(
  selections: readonly WatchlistSelectionInput[],
): Promise<WatchlistSourcesPayload> {
  const catalogSources = await listCareerBoardSources();
  const catalogSourcesById = new Map(
    catalogSources.map((source) => [source.id, source]),
  );
  const normalizedSelections = [];
  const seenUrls = new Set<string>();

  for (const selection of selections) {
    const normalizedUrl = selection.careersUrl.trim();
    if (seenUrls.has(normalizedUrl)) {
      throw unprocessableEntity("Duplicate watchlist URLs are not allowed", {
        careersUrl: normalizedUrl,
      });
    }
    seenUrls.add(normalizedUrl);

    if (selection.catalogSourceId) {
      const catalogSource = catalogSourcesById.get(selection.catalogSourceId);
      if (!catalogSource) {
        throw unprocessableEntity("Selected watchlist source was not found", {
          catalogSourceId: selection.catalogSourceId,
        });
      }

      if (catalogSource.careersUrl !== normalizedUrl) {
        throw unprocessableEntity(
          "Selected watchlist source URL does not match the catalog",
          {
            catalogSourceId: selection.catalogSourceId,
            careersUrl: normalizedUrl,
          },
        );
      }

      normalizedSelections.push({
        catalogSourceId: catalogSource.id,
        sourceType: catalogSource.sourceType,
        label: catalogSource.label,
        careersUrl: catalogSource.careersUrl,
      });
      continue;
    }

    // Custom career pages are fetched later by the scrapers, so refuse
    // anything that is not an ordinary public web address.
    if (!isPublicLookingHttpUrl(normalizedUrl)) {
      throw unprocessableEntity(
        "Watchlist URLs must be public http or https web addresses",
        { careersUrl: normalizedUrl },
      );
    }

    const adapter = getWatchlistSourceAdapter(selection.sourceType);
    if (!adapter) {
      throw unprocessableEntity("Unsupported watchlist source type", {
        sourceType: selection.sourceType,
      });
    }
    if (!adapter.descriptor.supportsCustomSource) {
      throw unprocessableEntity(
        "Custom sources are not supported for this source type",
        { sourceType: selection.sourceType },
      );
    }

    try {
      const normalized = await adapter.normalizeCustomSelection({
        label: selection.label,
        careersUrl: normalizedUrl,
      });
      normalizedSelections.push({
        catalogSourceId: null,
        sourceType: selection.sourceType,
        label: normalized.label,
        careersUrl: normalized.careersUrl,
      });
    } catch (error) {
      throw unprocessableEntity(
        `${adapter.descriptor.invalidUrlMessage}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { careersUrl: normalizedUrl },
      );
    }
  }

  const selectedSources = await watchlistRepo.replaceWatchlistSelectedSources({
    selections: normalizedSelections,
  });
  return toWatchlistSourcesPayload(catalogSources, selectedSources);
}
