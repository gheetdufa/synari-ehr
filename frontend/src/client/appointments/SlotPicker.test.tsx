import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BookingLocation, Slot, SlotRange } from '../../api/booking';
import { SlotPicker, type SlotSource } from './SlotPicker';
import { addDaysToKey, dayKeyOf } from './slots';

const NY = 'America/New_York';

/** UTC ISO for a wall time on a New York date (EDT or EST, whichever applies). */
function nyInstant(dayKey: string, hour: number): string {
  for (const offset of [4, 5]) {
    const iso = new Date(`${dayKey}T${String(hour + offset).padStart(2, '0')}:00:00Z`).toISOString();
    const local = new Intl.DateTimeFormat('en-US', { timeZone: NY, hour: 'numeric', hourCycle: 'h23' }).format(new Date(iso));
    if (Number(local) === hour && dayKeyOf(iso, NY) === dayKey) return iso;
  }
  throw new Error('no instant');
}

const OFFICES: BookingLocation[] = [{ id: 5, name: 'Main office', address: '1 Main St, Springfield' }];

function slotAt(dayKey: string, hour: number, location: Slot['location_type'], locationId: number | null = null): Slot {
  const starts = nyInstant(dayKey, hour);
  return {
    starts_at: starts,
    ends_at: new Date(Date.parse(starts) + 50 * 60_000).toISOString(),
    location_type: location,
    location_id: locationId,
  };
}

function renderPicker(slots: Slot[]) {
  const fetch = vi.fn<(range: SlotRange) => Promise<Slot[]>>().mockResolvedValue(slots);
  const source: SlotSource = { key: (range) => ['test-slots', range], fetch };
  const onSelect = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SlotPicker
        source={source}
        clinicianId={8}
        serviceId={3}
        timeZone={NY}
        locations={OFFICES}
        selected={null}
        onSelect={onSelect}
      />
    </QueryClientProvider>,
  );
  return { fetch, onSelect };
}

describe('SlotPicker', () => {
  it("requests a padded week of the clinician's times, shows open days and picks a time", async () => {
    const today = dayKeyOf(new Date(), NY);
    const tomorrow = addDaysToKey(today, 1);
    const { fetch, onSelect } = renderPicker([slotAt(tomorrow, 10, 'video'), slotAt(tomorrow, 14, 'in_person', 5)]);

    const morning = await screen.findByRole('button', { name: /10:00\sAM/ });
    expect(fetch).toHaveBeenCalledWith({
      clinician_id: 8,
      service_id: 3,
      start_date: addDaysToKey(today, -1),
      end_date: addDaysToKey(today, 7),
    });
    expect(within(morning).getByText('Video')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /2:00\sPM/ })).toHaveTextContent('In person · Main office');
    expect(screen.getByRole('button', { name: /: 2 open times$/ })).toHaveAttribute('aria-pressed', 'true');
    const closedDays = screen.getAllByRole('button', { name: /: no open times$/ });
    expect(closedDays).toHaveLength(6);
    closedDays.forEach((day) => expect(day).toBeDisabled());
    expect(screen.getByText(/Times shown in Eastern Time \(America\/New_York\)/)).toBeInTheDocument();

    await userEvent.click(morning);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ location_type: 'video' }));
  });

  it('offers the next week when this week is empty', async () => {
    renderPicker([]);
    expect(await screen.findByText('No open times this week')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show next week' }));
    expect(await screen.findByText('Week 2 of 4')).toBeInTheDocument();
  });
});
