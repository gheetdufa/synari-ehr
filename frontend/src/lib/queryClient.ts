import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';

/** Shared query cache. Client errors (4xx) aren't retried; they won't succeed on a retry. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: (failureCount, error) =>
        !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failureCount < 2,
    },
  },
});
