import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LoadMore } from './LoadMore';

describe('LoadMore', () => {
  it('shows how many rows are loaded and loads the next page', async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn();
    render(<LoadMore noun="invoices" shown={50} total={1234} hasMore loading={false} onLoadMore={onLoadMore} />);
    expect(screen.getByText('Showing 50 of 1,234 invoices')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('offers to try again when loading more failed', () => {
    render(<LoadMore noun="notes" shown={50} total={80} hasMore loading={false} failed onLoadMore={vi.fn()} />);
    expect(screen.getByText("Couldn't load more notes.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('disappears once every row is shown', () => {
    const { container } = render(
      <LoadMore noun="notes" shown={80} total={80} hasMore={false} loading={false} onLoadMore={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
