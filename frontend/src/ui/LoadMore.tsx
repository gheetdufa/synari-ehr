import { Button } from './Button';

/**
 * Footer for a paginated list: "Showing 50 of 1,234 invoices" and a button that loads the next
 * page. Renders nothing once every row is shown.
 */
export function LoadMore({
  shown,
  total,
  noun,
  hasMore,
  loading,
  failed = false,
  onLoadMore,
}: {
  shown: number;
  total: number;
  /** What the rows are, plural ("invoices"). */
  noun: string;
  hasMore: boolean;
  loading: boolean;
  /** The last attempt to load more failed; the button offers to try again. */
  failed?: boolean;
  onLoadMore: () => void;
}) {
  if (!hasMore) return null;
  return (
    <div className="flex flex-col items-center gap-2 border-t border-sage-100 px-4 py-3 text-sm text-sage-600 sm:flex-row sm:justify-between sm:px-5">
      <p aria-live="polite">
        {failed
          ? `Couldn't load more ${noun}.`
          : `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} ${noun}`}
      </p>
      <Button variant="secondary" size="sm" loading={loading} onClick={onLoadMore}>
        {failed ? 'Try again' : 'Load more'}
      </Button>
    </div>
  );
}
