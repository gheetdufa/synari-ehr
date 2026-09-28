import { useMemo } from 'react';
import { keepPreviousData, useInfiniteQuery, type InfiniteData, type QueryKey } from '@tanstack/react-query';
import type { Page } from '../api/client';

/** Rows asked for per "Load more" unless a list chooses otherwise. */
export const DEFAULT_PAGE_SIZE = 50;

/** The offset of the page after `pages`, or undefined once every matching row is loaded. */
export function nextOffset<T>(pages: Page<T>[]): number | undefined {
  const loaded = pages.reduce((count, page) => count + page.items.length, 0);
  const last = pages[pages.length - 1];
  if (!last || last.items.length === 0 || loaded >= last.total) return undefined;
  return loaded;
}

/** The rows of every loaded page, in order. */
export function pageItems<T>(data: InfiniteData<Page<T>> | undefined): T[] {
  return data?.pages.flatMap((page) => page.items) ?? [];
}

/**
 * A paginated list endpoint as an infinite query: `items` holds every loaded row, `total` how many
 * match the filters, and `loadMore` is ready to spread onto the `<LoadMore>` footer. Give each
 * list its own query key: a key used here must not also be used with `useQuery`.
 */
export function usePagedQuery<T>({
  queryKey,
  fetchPage,
  pageSize = DEFAULT_PAGE_SIZE,
  enabled = true,
  keepPreviousPages = false,
}: {
  queryKey: QueryKey;
  fetchPage: (page: { limit: number; offset: number }) => Promise<Page<T>>;
  pageSize?: number;
  enabled?: boolean;
  /** Keep showing the previous filter's rows while a new filter loads (e.g. search as you type). */
  keepPreviousPages?: boolean;
}) {
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => fetchPage({ limit: pageSize, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (_last, pages) => nextOffset(pages),
    placeholderData: keepPreviousPages ? keepPreviousData : undefined,
    enabled,
  });
  const items = useMemo(() => pageItems(query.data), [query.data]);
  const pages = query.data?.pages;
  const total = pages && pages.length > 0 ? pages[pages.length - 1].total : 0;
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = query;
  const loadMore = {
    shown: items.length,
    total,
    hasMore: hasNextPage,
    loading: isFetchingNextPage,
    failed: isFetchNextPageError,
    onLoadMore: () => void fetchNextPage(),
  };
  return { ...query, items, total, loadMore };
}
