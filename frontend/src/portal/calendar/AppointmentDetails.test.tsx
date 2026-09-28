import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Appointment } from '../../api/appointments';
import type { Session } from '../../api/auth';
import { ApiError } from '../../api/client';
import { testAppointment, testParticipant } from '../../test/appointments';
import { testSession, WithSession } from '../../test/session';
import { ToastProvider } from '../../ui/Toast';
import { AppointmentDetails } from './AppointmentDetails';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  updateParticipant: vi.fn(),
  cancel: vi.fn(),
  remove: vi.fn(),
  accept: vi.fn(),
  decline: vi.fn(),
}));

vi.mock('../../api/appointments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/appointments')>()),
  appointmentsApi: {
    get: mocks.get,
    update: mocks.update,
    updateParticipant: mocks.updateParticipant,
    cancel: mocks.cancel,
    remove: mocks.remove,
  },
}));

vi.mock('../../api/booking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/booking')>()),
  appointmentRequestsApi: { list: vi.fn().mockResolvedValue([]), accept: mocks.accept, decline: mocks.decline },
}));

const NY = 'America/New_York';

function appointment(overrides: Partial<Appointment> = {}): Appointment {
  return testAppointment({
    starts_at: '2030-01-10T15:00:00Z',
    ends_at: '2030-01-10T15:45:00Z',
    memo: 'Bring worksheet',
    series_id: 9,
    location: { id: 12, name: 'Video office', place_of_service: '10' },
    ...overrides,
  });
}

const FAMILY = appointment({
  title_label: 'Rivera family',
  title: 'Rivera family',
  series_id: null,
  participants: [
    testParticipant(),
    testParticipant({ id: 302, client: { id: 4, name: 'Sam Rivera' }, billable: false, fee_cents: 0 }),
  ],
});

function renderDetails(initial: Appointment, session: Session = testSession()) {
  const onClose = vi.fn();
  const onEdit = vi.fn();
  mocks.get.mockResolvedValue(initial);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <WithSession session={session}>
        <ToastProvider>
          <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <AppointmentDetails target={{ id: initial.id, initial }} timeZone={NY} onClose={onClose} onEdit={onEdit} />
          </MemoryRouter>
        </ToastProvider>
      </WithSession>
    </QueryClientProvider>,
  );
  return { onClose, onEdit };
}

beforeEach(() => vi.clearAllMocks());

describe('AppointmentDetails', () => {
  it('shows the appointment, its clinician and its links', () => {
    renderDetails(appointment());
    expect(screen.getByRole('heading', { name: 'Alex Rivera' })).toBeInTheDocument();
    expect(screen.getByText('Thursday, January 10, 2030')).toBeInTheDocument();
    expect(screen.getByText('Dana Lee, LCSW')).toBeInTheDocument();
    expect(screen.getByText('$150.00')).toBeInTheDocument();
    expect(screen.getByText('Video · Video office')).toBeInTheDocument();
    expect(screen.getByText('Bring worksheet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Alex Rivera' })).toHaveAttribute('href', '/portal/clients/3');
    expect(screen.getByRole('link', { name: /New note/ })).toHaveAttribute('href', '/portal/notes?new=1&client=3&appointment=42');
    expect(screen.getByRole('link', { name: /Message/ })).toHaveAttribute('href', '/portal/messaging?client=3');
    expect(screen.getByRole('button', { name: /Video opens 60 min before/ })).toBeDisabled();
  });

  it('marks attendance', async () => {
    const user = userEvent.setup();
    mocks.update.mockResolvedValue([appointment({ status: 'no_show' })]);
    renderDetails(appointment());
    await user.click(screen.getByRole('button', { name: 'No show' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith(42, { status: 'no_show' }));
  });

  it('sets each client’s attendance and billing in a shared session', async () => {
    const user = userEvent.setup();
    mocks.updateParticipant.mockResolvedValue(FAMILY);
    renderDetails(FAMILY);

    expect(screen.getByRole('heading', { name: 'Rivera family' })).toBeInTheDocument();
    expect(screen.getByText('Couple/family')).toBeInTheDocument();
    const clients = within(screen.getByRole('region', { name: 'Clients (2)' }));
    expect(clients.getByText('Billed')).toBeInTheDocument();
    expect(clients.getByText('Not billed')).toBeInTheDocument();
    expect(clients.getByRole('link', { name: 'New note for Sam Rivera' })).toHaveAttribute(
      'href',
      '/portal/notes?new=1&client=4&appointment=42',
    );
    expect(clients.getByRole('link', { name: 'Message Sam Rivera' })).toHaveAttribute('href', '/portal/messaging?client=4');

    await user.selectOptions(clients.getByLabelText('Attendance for Sam Rivera'), 'no_show');
    await waitFor(() => expect(mocks.updateParticipant).toHaveBeenCalledWith(42, 302, { attendance: 'no_show' }));
    await user.click(clients.getByRole('checkbox', { name: 'Bill Sam' }));
    await waitFor(() => expect(mocks.updateParticipant).toHaveBeenCalledWith(42, 302, { billable: true }));
    expect(screen.getByRole('group', { name: 'Session status' })).toBeInTheDocument();
  });

  it('puts a client back on the session’s status', async () => {
    const user = userEvent.setup();
    mocks.updateParticipant.mockResolvedValue(FAMILY);
    const missed = { ...FAMILY, participants: [FAMILY.participants[0], { ...FAMILY.participants[1], attendance: 'no_show' as const }] };
    renderDetails(missed);
    await user.selectOptions(screen.getByLabelText('Attendance for Sam Rivera'), 'Same as session (Scheduled)');
    await waitFor(() => expect(mocks.updateParticipant).toHaveBeenCalledWith(42, 302, { attendance: null }));
  });

  it('shows a colleague’s appointment with unreachable clients only as busy time', () => {
    renderDetails(
      appointment({
        restricted: true,
        title: 'Busy',
        title_label: 'Busy',
        participants: [],
        clinician: { id: 2, name: 'Jordan Park' },
        service_code: '',
        service_description: '',
        memo: '',
      }),
    );
    expect(screen.getByRole('heading', { name: 'Busy' })).toBeInTheDocument();
    expect(screen.getByText('Jordan Park')).toBeInTheDocument();
    expect(screen.queryByText('Alex Rivera')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit|Delete|Cancel appointment/ })).not.toBeInTheDocument();
  });

  it('is read-only on a colleague’s calendar without the schedule-all permission', () => {
    renderDetails(
      appointment({ clinician: { id: 2, name: 'Jordan Park' } }),
      testSession({ staff: { id: 5, role: 'clinician' }, capabilities: ['view_all_clients'] }),
    );
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Attendance' })).not.toBeInTheDocument();
    // Only the appointment's clinician hosts its video session.
    expect(screen.queryByRole('button', { name: /Video opens/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(2);
  });

  it('hides chart links from staff without clinical access', () => {
    renderDetails(
      appointment({ clinician: { id: 2, name: 'Jordan Park' } }),
      testSession({ staff: { id: 8, role: 'scheduler', is_clinician: false }, capabilities: ['view_all_clients', 'schedule_all'] }),
    );
    expect(screen.queryByRole('link', { name: /New note/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Message/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('cancels this and following occurrences with a late fee and email', async () => {
    const user = userEvent.setup();
    mocks.cancel.mockResolvedValue([appointment({ status: 'late_canceled' })]);
    renderDetails(appointment());
    await user.click(screen.getByRole('button', { name: /Cancel appointment/ }));
    await user.click(screen.getByRole('radio', { name: /This and following/ }));
    await user.type(screen.getByLabelText(/Reason/), 'Moving away');
    await user.click(screen.getByRole('checkbox', { name: /Late cancellation/ }));
    expect(screen.getByRole('checkbox', { name: /Email the client/ })).toBeChecked();
    const confirm = screen.getAllByRole('button', { name: 'Cancel appointment' });
    await user.click(confirm[confirm.length - 1]);
    await waitFor(() =>
      expect(mocks.cancel).toHaveBeenCalledWith(42, { reason: 'Moving away', late: true, notify_client: true }, 'following'),
    );
  });

  it('explains why an appointment with records cannot be deleted', async () => {
    const user = userEvent.setup();
    mocks.remove.mockRejectedValue(
      new ApiError(409, "This appointment has notes or invoices, so it can't be deleted. Cancel it instead."),
    );
    renderDetails(appointment({ series_id: null }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText(/has notes or invoices/)).toBeInTheDocument();
    expect(mocks.remove).toHaveBeenCalledWith(42, 'this');
  });

  it('accepts or declines a pending request', async () => {
    const user = userEvent.setup();
    mocks.decline.mockResolvedValue(appointment({ status: 'declined' }));
    const { onClose } = renderDetails(
      appointment({ status: 'requested', source: 'public', request_message: 'Evenings are hard for me.', series_id: null }),
    );
    expect(screen.getByText('Evenings are hard for me.')).toBeInTheDocument();
    expect(screen.getByText('Requested on the booking page')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Accept request/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Decline' }));
    await user.type(screen.getByLabelText(/Reason/), 'Full caseload');
    await user.click(screen.getByRole('checkbox', { name: /Include the reason/ }));
    await user.click(screen.getByRole('button', { name: 'Decline request' }));
    await waitFor(() => expect(mocks.decline).toHaveBeenCalledWith(42, { reason: 'Full caseload', include_reason: true }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
