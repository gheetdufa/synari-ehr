import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { PortalAppointment } from '../../api/booking';
import { ToastProvider } from '../../ui/Toast';
import ClientAppointmentsPage from './ClientAppointmentsPage';

const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true };
const HOUR = 60 * 60_000;

const mocks = vi.hoisted(() => ({ list: vi.fn(), cancel: vi.fn() }));

vi.mock('../../api/booking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/booking')>()),
  portalAppointmentsApi: { list: mocks.list, cancel: mocks.cancel },
}));
vi.mock('../../auth/ClientAuth', () => ({
  usePortalClient: () => ({
    id: 3,
    first_name: 'Samantha',
    last_name: 'Park',
    preferred_name: 'Sam',
    email: 'sam@example.com',
    clinician_name: 'Jordan Lee, LCSW',
    practice_name: 'Calm Harbor Therapy',
    time_zone: 'America/Chicago',
    permissions: { messaging: true, booking: true, billing: true },
  }),
}));

function appointment(overrides: Partial<PortalAppointment>): PortalAppointment {
  const starts = new Date(Date.now() + 5 * HOUR);
  return {
    id: 40,
    starts_at: starts.toISOString(),
    ends_at: new Date(starts.getTime() + HOUR).toISOString(),
    status: 'scheduled',
    location_type: 'in_person',
    location_details: '1 Main St, Springfield',
    has_video: false,
    clinician_name: 'Jordan Lee, LCSW',
    service_description: 'Family psychotherapy',
    is_group: false,
    other_participants: [],
    can_cancel: true,
    cancel_is_late: false,
    ...overrides,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter future={ROUTER_FUTURE}>
          <ClientAppointmentsPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('ClientAppointmentsPage', () => {
  it('cancels only the client’s place in a shared session and warns that it is late', async () => {
    const user = userEvent.setup();
    const shared = appointment({ other_participants: ['Jo', 'Ali'], cancel_is_late: true });
    mocks.list.mockResolvedValue([shared]);
    mocks.cancel.mockResolvedValue({ ...shared, status: 'late_canceled', can_cancel: false });
    renderPage();

    expect(await screen.findByText('Joint session with Jo & Ali')).toBeInTheDocument();
    expect(screen.getByText(/with Jordan Lee, LCSW/)).toBeInTheDocument();
    expect(screen.getByText('Canceling now counts as a late cancellation and may be charged.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel my attendance' }));

    const dialog = await screen.findByRole('dialog', { name: 'Cancel your attendance?' });
    expect(within(dialog).getByText(/Only your place is canceled; the session goes ahead for the others/)).toBeInTheDocument();
    expect(within(dialog).getByText('Late cancellation')).toBeInTheDocument();
    // The API keeps no reason for one client's place, so none is asked for.
    expect(within(dialog).queryByLabelText(/Reason/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel my attendance' }));

    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith(40, ''));
    expect(await screen.findByText('Your attendance was canceled')).toBeInTheDocument();
  });

  it('labels group sessions and cancels an individual one as the appointment', async () => {
    const user = userEvent.setup();
    mocks.list.mockResolvedValue([
      appointment({ id: 41, is_group: true, service_description: 'Group psychotherapy' }),
      appointment({ id: 42, service_description: 'Individual therapy' }),
    ]);
    renderPage();

    expect(await screen.findByText('Group session')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Cancel my attendance' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Cancel appointment' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this appointment?' });
    expect(within(dialog).queryByText('Late cancellation')).not.toBeInTheDocument();
    expect(within(dialog).getByText('Shared with Jordan Lee, LCSW.')).toBeInTheDocument();
  });
});
