import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Session } from '../../api/auth';
import type { TeamMember } from '../../api/team';
import { testAppointment, testParticipant } from '../../test/appointments';
import { testSession, WithSession } from '../../test/session';
import { ToastProvider } from '../../ui/Toast';
import CalendarPage from './CalendarPage';

const mocks = vi.hoisted(() => ({ list: vi.fn(), team: vi.fn(), requests: vi.fn(), busy: vi.fn() }));

vi.mock('../../api/appointments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/appointments')>()),
  appointmentsApi: { list: mocks.list },
}));
vi.mock('../../api/team', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/team')>()),
  teamApi: { list: mocks.team },
}));
vi.mock('../../api/booking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/booking')>()),
  appointmentRequestsApi: { list: mocks.requests },
}));
vi.mock('../../api/calendarSync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/calendarSync')>()),
  calendarSyncApi: { busy: mocks.busy },
}));
vi.mock('../../api/practice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/practice')>()),
  practiceApi: { services: () => Promise.resolve([]), locations: () => Promise.resolve([]) },
}));

function member(id: number, name: string, overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    id,
    email: `${id}@example.com`,
    first_name: name.split(' ')[0],
    last_name: name.split(' ')[1] ?? '',
    display_name: name,
    status: 'active',
    role: 'clinician',
    clinician_access: 'basic',
    is_clinician: true,
    supervisor_id: null,
    credentials: '',
    license_number: '',
    license_state: '',
    npi: '',
    taxonomy_code: '',
    claim_modifier: '',
    accepting_new_clients: true,
    invited_at: null,
    last_login_at: null,
    mfa_enabled: false,
    ...overrides,
  };
}

const GROUP = testAppointment({
  id: 50,
  title: 'DBT skills',
  title_label: 'DBT skills',
  is_group: true,
  participants: [testParticipant(), testParticipant({ id: 302, client: { id: 4, name: 'Sam Rivera' } })],
  starts_at: '2026-09-24T15:00:00Z',
  ends_at: '2026-09-24T16:30:00Z',
  duration_minutes: 90,
});

const BUSY = testAppointment({
  id: 51,
  title: 'Busy',
  title_label: 'Busy',
  restricted: true,
  participants: [],
  clinician: { id: 2, name: 'Jordan Park' },
  starts_at: '2026-09-23T17:00:00Z',
  ends_at: '2026-09-23T17:50:00Z',
});

function renderCalendar(session: Session = testSession()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WithSession session={session}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/portal/calendar?view=week&date=2026-09-23']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <CalendarPage />
          </MemoryRouter>
        </ToastProvider>
      </WithSession>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([GROUP, BUSY]);
  mocks.team.mockResolvedValue([member(1, 'Dana Lee', { role: 'owner' }), member(2, 'Jordan Park')]);
  mocks.requests.mockResolvedValue([]);
  mocks.busy.mockResolvedValue([]);
});

afterEach(() => localStorage.clear());

describe('CalendarPage', () => {
  it('shows your own calendar first, then whoever you choose, and remembers it', async () => {
    const user = userEvent.setup();
    renderCalendar();

    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ clinician_ids: [1] })));
    await user.click(await screen.findByRole('button', { name: 'Clinicians shown: Dana Lee' }));
    await user.click(screen.getByRole('button', { name: 'Everyone' }));

    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ clinician_ids: undefined })));
    expect(localStorage.getItem('synari.calendar.clinicians.1')).toBe('"all"');
    expect(within(screen.getByRole('list', { name: 'Clinician colors' })).getByText('Jordan Park')).toBeInTheDocument();

    expect(screen.getByRole('button', { name: 'Clinicians shown: All clinicians' })).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Dana Lee/ }));
    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ clinician_ids: [2] })));
    expect(screen.getByRole('checkbox', { name: /Jordan Park/ })).toBeDisabled();
  });

  it('starts with everyone for staff who aren’t clinicians', async () => {
    renderCalendar(testSession({ staff: { id: 8, role: 'scheduler', is_clinician: false }, capabilities: ['view_all_clients', 'schedule_all'] }));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ clinician_ids: undefined })));
    expect(await screen.findByRole('button', { name: 'Clinicians shown: All clinicians' })).toBeInTheDocument();
  });

  it('draws group sessions with their name and colleagues’ unreachable appointments as plain busy time', async () => {
    renderCalendar();
    expect(await screen.findByRole('button', { name: /^DBT skills, .*group session/ })).toBeInTheDocument();
    const busy = screen.getByTitle('Busy · Jordan Park');
    expect(busy.tagName).toBe('DIV');
    expect(within(busy).getByText('Busy')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Busy/ })).not.toBeInTheDocument();
  });

  it('shades busy time from your connected personal calendar without making it clickable', async () => {
    mocks.busy.mockResolvedValue([{ id: 7, clinician_id: 1, starts_at: '2026-09-25T13:00:00Z', ends_at: '2026-09-25T14:30:00Z' }]);
    renderCalendar();

    const busy = await screen.findByTestId('external-busy');
    expect(within(busy).getByText('Busy (personal calendar)')).toBeInTheDocument();
    expect(within(busy).getByText(/Busy in a connected personal calendar, 9:00 – 10:30 AM/)).toBeInTheDocument();
    expect(busy.className).toContain('pointer-events-none');
    expect(mocks.busy).toHaveBeenCalledWith(expect.objectContaining({ clinician_ids: [1] }));
    expect(within(screen.getByRole('list', { name: 'Legend' })).getByText('Busy (personal calendar)')).toBeInTheDocument();
  });

  it('asks only for busy times of calendars you manage', async () => {
    const user = userEvent.setup();
    renderCalendar(testSession({ staff: { role: 'clinician' }, capabilities: [] }));
    await waitFor(() => expect(mocks.busy).toHaveBeenCalledWith(expect.objectContaining({ clinician_ids: [1] })));
    await user.click(await screen.findByRole('button', { name: 'Clinicians shown: Dana Lee' }));
    await user.click(screen.getByRole('button', { name: 'Everyone' }));
    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith(expect.objectContaining({ clinician_ids: undefined })));
    expect(mocks.busy).toHaveBeenLastCalledWith(expect.objectContaining({ clinician_ids: [1] }));
  });

  it('is read-only for staff who can’t schedule', async () => {
    renderCalendar(testSession({ staff: { id: 9, role: 'biller', is_clinician: false }, capabilities: ['view_all_clients', 'billing_all'] }));
    expect(await screen.findByRole('button', { name: /^DBT skills/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Requests/ })).not.toBeInTheDocument();
    expect(mocks.requests).not.toHaveBeenCalled();
  });
});
