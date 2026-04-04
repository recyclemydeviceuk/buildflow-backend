export interface PaginationParams {
  page: number
  limit: number
  skip: number
}

export const parsePagination = (
  pageStr?: string,
  limitStr?: string,
  maxLimit = 100
): PaginationParams => {
  const page = Math.max(1, parseInt(pageStr || '1', 10))
  const limit = Math.min(maxLimit, Math.max(1, parseInt(limitStr || '20', 10)))
  return { page, limit, skip: (page - 1) * limit }
}

export const buildPaginationMeta = (total: number, page: number, limit: number) => ({
  page,
  limit,
  total,
  pages: Math.ceil(total / limit),
  hasNext: page * limit < total,
  hasPrev: page > 1,
})
