import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { PortalClient } from '../../api/auth';
import type { PortalBookingOptions, Slot } from '../../api/booking';
import { ToastProvider } from '../../ui/Toast';
import ClientBookingPage from './ClientBookingPage';
import { addDaysToKey, dayKeyOf } from './slots';

const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true };
const CHICAGO = 'America/Chicago';

const mocks = vi.hoisted(() => ({ options: vi.fn(), slots: vi.fn(), request: vi.fn(), client: null as PortalClient | null }));

vi.mock('../../api/booking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/booking')>()),
  portalBookingApi: { options: mocks.options, slots: mocks.slots, request: mocks.request },
}));
vi.mock('../../auth/ClientAuth', () => ({ usePortalClient: () => mocks.client }));

const OPTIONS: PortalBookingOptions = {
  clinicians: [
    {
      id: 8,
      name: 'Jordan Lee, LCSW',
      time_zone: 'America/New_York',
      services: [{ id: 3, description: 'Individual therapy', duration_minutes: 50 }],
    },
    {
      id: 9,
      name: 'Maya Chen, PhD',
      time_zone: 'America/New_York',
      services: [{ id: 6, description: 'Medication check', duration_minutes: 30 }],
    },
  ],
  locations: [],
};

/** Tomorrow at 9:00 AM Chicago time, by video. */
function tomorrowSlot(): Slot {
  const day = addDaysToKey(dayKeyOf(new Date(), CHICAGO), 1);
  for (const offset of [5, 6]) {
    const starts = new Date(`${day}T${String(9 + offset).padStart(2, '0')}:00:00Z`);
    const hour = new Intl.DateTimeFormat('en-US', { timeZone: CHICAGO, hour: 'numeric', hourCycle: 'h23' }).format(starts);
    if (Number(hour) === 9) {
      return {
        starts_at: starts.toISOString(),
        ends_at: new Date(starts.getTime() + 30 * 60_000).toISOString(),
        location_type: 'video',
        location_id: null,
      };
    }
  }
  throw new Error('no slot');
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter future={ROUTER_FUTURE}>
          <ClientBookingPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.client = {
    id: 3,
    first_name: 'Samantha',
    last_name: 'Park',
    preferred_name: 'Sam',
    email: 'sam@example.com',
    clinician_name: 'Jordan Lee, LCSW',
    practice_name: 'Calm Harbor Therapy',
    time_zone: CHICAGO,
    permissions: { messaging: true, booking: true, billing: true },
    acting_contact: null,
    idle_timeout_minutes: 30,
  };
  mocks.options.mockResolvedValue(OPTIONS);
  mocks.slots.mockResolvedValue([tomorrowSlot()]);
  mocks.request.mockResolvedValue({});
});

describe('ClientBookingPage', () => {
  it('books with the care-team clinician the client chooses', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Choose a clinician' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Jordan Lee, LCSW/ })).toHaveTextContent('Individual therapy (50 minutes)');
    await user.click(screen.getByRole('button', { name: /Maya Chen, PhD/ }));

    expect(await screen.findByText('With Maya Chen, PhD')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Medication check/ }));
    const time = await screen.findByRole('button', { name: /9:00\sAM/ });
    expect(mocks.slots).toHaveBeenCalledWith(expect.objectContaining({ clinician_id: 9, service_id: 6 }));
    await user.click(time);

    expect(await screen.findByRole('heading', { name: 'Confirm your request' })).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Message for Maya Chen, PhD/), 'Mornings are best');
    await user.click(screen.getByRole('button', { name: 'Send request' }));

    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith({
        clinician_id: 9,
        service_id: 6,
        starts_at: tomorrowSlot().starts_at,
        location_type: 'video',
        message: 'Mornings are best',
      }),
    );
  });

  it('skips the clinician step when only one clinician can be booked', async () => {
    mocks.options.mockResolvedValue({ ...OPTIONS, clinicians: [OPTIONS.clinicians[0], { ...OPTIONS.clinicians[1], services: [] }] });
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Choose a service' })).toBeInTheDocument();
    expect(screen.getByText('With Jordan Lee, LCSW')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Choose a clinician' })).not.toBeInTheDocument();
  });

  it('points the client to their clinician when online booking is off', async () => {
    mocks.client = { ...mocks.client!, permissions: { messaging: true, booking: false, billing: true } };
    renderPage();

    expect(screen.getByText("Online booking isn't available")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Message your clinician/ })).toHaveAttribute('href', '/client/messages');
    expect(mocks.options).not.toHaveBeenCalled();
  });
});
