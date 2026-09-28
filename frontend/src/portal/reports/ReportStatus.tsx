import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { ApiError } from '../../api/client';
import { EmptyState, ErrorState } from '../../ui/Display';
import { SectionSpinner } from '../../ui/Spinner';

/** A report that hasn't loaded: a spinner, the error with a retry, or a friendly note for a 403. */
export function ReportStatus({ query }: { query: UseQueryResult<unknown> }) {
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.status === 403) {
      return (
        <EmptyState
          icon={<Lock />}
          title="Not available for your role"
          description="Ask a practice owner or manager if you need access to reports."
        />
      );
    }
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }
  return <SectionSpinner />;
}

/** A report table's footer row. */
export function TotalsRow({ children }: { children: ReactNode }) {
  return (
    <tfoot className="border-t-2 border-sage-200 bg-sage-50 font-semibold">
      <tr>{children}</tr>
    </tfoot>
  );
}
