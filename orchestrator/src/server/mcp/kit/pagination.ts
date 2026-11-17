import { z } from "zod";

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

/**
 * Spread into a tool's input object: `z.object({ ...paginationShape, ... })`.
 */
export const paginationShape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_LIMIT)
    .default(DEFAULT_PAGE_LIMIT)
    .describe(
      `Page size (1-${MAX_PAGE_LIMIT}, default ${DEFAULT_PAGE_LIMIT}).`,
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      "Number of items to skip. Use nextOffset from the previous page.",
    ),
};

export type PaginationInput = { limit: number; offset: number };

export type PageMeta = {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
};

/** Pagination fields every list tool returns next to its items. */
export function toPageMeta(
  input: PaginationInput & { total: number; returned: number },
): PageMeta {
  const end = input.offset + input.returned;
  const hasMore = end < input.total;
  return {
    total: input.total,
    limit: input.limit,
    offset: input.offset,
    hasMore,
    nextOffset: hasMore ? end : null,
  };
}

/** Slice an in-memory list into a page (for sources without SQL paging). */
export function paginateArray<T>(
  items: readonly T[],
  input: PaginationInput,
): { items: T[]; page: PageMeta } {
  const slice = items.slice(input.offset, input.offset + input.limit);
  return {
    items: slice,
    page: toPageMeta({ ...input, total: items.length, returned: slice.length }),
  };
}
