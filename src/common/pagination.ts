export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/**
 * Story 15.2 (FR-64, AD-52): single builder for the paginated `meta`
 * envelope. `total = 0` yields `totalPages = 0`; a page beyond the last
 * one yields `hasNextPage = false` and `hasPreviousPage = page > 1`.
 */
export function buildPageMeta(
  page: number,
  limit: number,
  total: number,
): PageMeta {
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}
