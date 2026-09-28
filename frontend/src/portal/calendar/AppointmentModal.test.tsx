import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session } from '../../api/auth';
import { ApiError } from '../../api/client';
import type { ClientDetail, ClientSummary } from '../../api/clients';
import type { Location, Service } from '../../api/practice';
import type { TeamMember } from '../../api/team';
import { testAppointment, testParticipant } from '../../test/appointments';
import { page } from '../../test/page';
import { testSession, WithSession } from '../../test/session';
import { ToastProvider } from '../../ui/Toast';
import { AppointmentModal, type AppointmentModalTarget } from './AppointmentModal';

const mocks = vi.hoisted(() => ({
  services: vi.fn(),
  locations: vi.fn(),
  team: vi.fn(),
  getClient: vi.fn(),
  listClients: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  busy: vi.fn(),
}));

vi.mock('../../api/calendarSync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/calendarSync')>()),
  calendarSyncApi: { busy: mocks.busy },
}));

vi.mock('../../api/practice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/practice')>()),
  practiceApi: { services: mocks.services, locations: mocks.locations },
}));

vi.mock('../../api/team', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/team')>()),
  teamApi: { list: mocks.team },
}));

vi.mock('../../api/clients', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/clients')>()),
  clientsApi: { get: mocks.getClient, list: mocks.listClients },
}));

vi.mock('../../api/appointments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/appointments')>()),
  appointmentsApi: { create: mocks.create, update: mocks.update },
}));

const NY = 'America/New_York';

function service(id: number, code: string, description: string, minutes: number, isDefault = false): Service {
  return {
    id,
    code,
    description,
    duration_minutes: minutes,
    rate_cents: 15000,
    is_default: isDefault,
    is_active: true,
    bookable_online: true,
    bookable_by_new_clients: false,
  };
}

const SERVICES = [service(7, '90834', 'Psychotherapy, 45 min', 45, true), service(9, '90853', 'Group psychotherapy', 90)];

function location(id: number, name: string, isVideo: boolean): Location {
  return {
    id,
    name,
    address_line1: '',
    address_line2: '',
    city: '',
    state: '',
    postal_code: '',
    place_of_service: isVideo ? '10' : '11',
    is_video: isVideo,
    is_active: true,
  };
}

const LOCATIONS = [location(11, 'Main office', false), location(12, 'Video office', true)];

function member(id: number, name: string, overrides: Partial<TeamMember> = {}): TeamMember {
  const [first, last] = name.split(' ');
  return {
    id,
    email: `${first.toLowerCase()}@example.com`,
    first_name: first,
    last_name: last,
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

function client(id: number, first: string, last: string): ClientSummary {
  return {
    id,
    first_name: first,
    last_name: last,
    preferred_name: '',
    status: 'active',
    email: `${first.toLowerCase()}@example.com`,
    phone: '',
    date_of_birth: null,
    created_at: '2026-01-01T00:00:00Z',
    care_team: [],
  };
}

const ALEX_DETAIL = { ...client(3, 'Alex', 'Rivera'), default_service_id: null, rate_override_cents: null } as unknown as ClientDetail;

function renderModal(target: AppointmentModalTarget, session: Session = testSession()) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <WithSession session={session}>
        <ToastProvider>
          <AppointmentModal target={target} timeZone={NY} onClose={onClose} onSaved={onSaved} />
        </ToastProvider>
      </WithSession>
    </QueryClientProvider>,
  );
  return { onClose, onSaved };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.services.mockResolvedValue(SERVICES);
  mocks.locations.mockResolvedValue(LOCATIONS);
  mocks.team.mockResolvedValue([member(1, 'Dana Lee', { role: 'owner' }), member(2, 'Jordan Park')]);
  mocks.getClient.mockResolvedValue(ALEX_DETAIL);
  mocks.busy.mockResolvedValue([]);
  mocks.listClients.mockResolvedValue(page([client(3, 'Alex', 'Rivera'), client(4, 'Sam', 'Rivera'), client(5, 'Jo', 'Park')]));
});

function clientSearch(): HTMLElement {
  return screen.getByPlaceholderText(/Search clients|Add another client/);
}

async function addClient(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(clientSearch());
  await user.click(await screen.findByRole('option', { name: new RegExp(name) }));
}

describe('AppointmentModal', () => {
  it('warns, without blocking, when the time is busy in the clinician’s connected calendar', async () => {
    mocks.busy.mockResolvedValue([{ id: 1, clinician_id: 1, starts_at: '2026-09-25T13:30:00Z', ends_at: '2026-09-25T15:00:00Z' }]);
    renderModal({ mode: 'create', startsAt: '2026-09-25T14:00:00Z' });

    expect(await screen.findByText(/overlaps busy time in your connected calendar \(9:30 – 11:00 AM\)/)).toBeInTheDocument();
    expect(mocks.busy).toHaveBeenCalledWith(
      expect.objectContaining({ start: '2026-09-25T14:00:00.000Z', clinician_ids: [1] }),
    );
    expect(screen.getByRole('button', { name: 'Schedule' })).toBeEnabled();
  });

  it('prefills a new appointment from a client link and saves through a client double-booking', async () => {
    const user = userEvent.setup();
    const elsewhere = testAppointment({ id: 5, title_label: 'Alex Rivera', clinician: { id: 2, name: 'Jordan Park' } });
    mocks.create
      .mockRejectedValueOnce(
        new ApiError(409, {
          message: 'A client in this session already has an appointment at this time',
          conflicts: [],
          client_conflicts: [elsewhere],
        }),
      )
      .mockResolvedValueOnce([testAppointment({ participants: [testParticipant({ fee_cents: 12000 })] })]);

    const { onSaved } = renderModal({ mode: 'create', startsAt: '2026-09-25T14:00:00Z', clientId: 3 });

    const chips = await screen.findByRole('list', { name: 'Clients in this appointment' });
    expect(within(chips).getByText('Alex Rivera')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Date/)).toHaveValue('2026-09-25');
    expect(screen.getByLabelText(/^Start time/)).toHaveValue('10:00');
    await waitFor(() => expect(screen.getByLabelText(/^Service/)).toHaveValue('7'));
    expect(screen.getByLabelText(/^Duration/)).toHaveValue(45);
    await waitFor(() => expect(screen.getByLabelText(/^Clinician/)).toHaveValue('1'));
    await waitFor(() => expect(screen.getByLabelText('Office')).toHaveValue('11'));
    expect(screen.getByLabelText(/^Fee override/)).toHaveValue('');

    await user.click(screen.getByRole('radio', { name: /Video/ }));
    expect(screen.getByLabelText('Office')).toHaveValue('12');
    await user.selectOptions(screen.getByLabelText('Repeat'), 'every2weeks');
    const occurrences = screen.getByLabelText('Number of occurrences');
    await user.clear(occurrences);
    await user.type(occurrences, '6');
    await user.click(screen.getByRole('button', { name: 'Schedule' }));

    expect(await screen.findByText('A client in this session already has an appointment at this time')).toBeInTheDocument();
    const warning = screen.getByText('Clients already booked then').closest('[role="status"]') as HTMLElement;
    expect(within(warning).getByText(/Jordan Park/)).toBeInTheDocument();
    expect(mocks.create).toHaveBeenLastCalledWith({
      kind: 'appointment',
      clinician_id: 1,
      participants: [{ client_id: 3 }],
      service_id: 7,
      starts_at: '2026-09-25T14:00:00.000Z',
      duration_minutes: 45,
      location_type: 'video',
      location_id: 12,
      location_details: '',
      memo: '',
      notify_client: true,
      recurrence: { frequency: 'weekly', interval: 2, count: 6 },
    });

    await user.click(screen.getByRole('button', { name: 'Save anyway' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(mocks.create.mock.calls[1][0]).toMatchObject({ allow_conflicts: true, recurrence: { interval: 2, count: 6 } });
    expect(await screen.findByText('Appointment scheduled · Alex Rivera billed $120.00')).toBeInTheDocument();
  });

  it('adds clients as chips, picks the identified patient, and turns it into a group', async () => {
    const user = userEvent.setup();
    mocks.create.mockResolvedValue([testAppointment()]);
    renderModal({ mode: 'create', startsAt: '2026-09-25T14:00:00Z' });

    await screen.findByPlaceholderText('Search clients by name, email or phone');
    await addClient(user, 'Alex Rivera');
    await addClient(user, 'Sam Rivera');
    expect(screen.getByRole('radio', { name: 'Bill Alex Rivera (identified patient)' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'Bill Sam Rivera (identified patient)' }));
    expect(screen.getByRole('radio', { name: 'Bill Alex Rivera (identified patient)' })).not.toBeChecked();
    await user.type(screen.getByLabelText(/Session name/), 'Rivera family');
    await user.click(screen.getByRole('button', { name: 'Remove Alex Rivera' }));
    await addClient(user, 'Alex Rivera');
    await user.click(screen.getByRole('button', { name: 'Schedule' }));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          participants: [
            { client_id: 4, billable: true },
            { client_id: 3, billable: false },
          ],
          title: 'Rivera family',
        }),
      ),
    );
    expect(mocks.create.mock.calls[0][0]).not.toHaveProperty('group');
  });

  it('bills every member of a group session', async () => {
    const user = userEvent.setup();
    mocks.create.mockResolvedValue([testAppointment()]);
    renderModal({ mode: 'create', startsAt: '2026-09-25T14:00:00Z' });

    await screen.findByPlaceholderText('Search clients by name, email or phone');
    await addClient(user, 'Alex Rivera');
    await addClient(user, 'Jo Park');
    await user.click(screen.getByRole('checkbox', { name: /Group session/ }));
    expect(screen.queryByRole('radio', { name: /identified patient/ })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/Group name/), 'DBT skills');
    await user.click(screen.getByRole('button', { name: 'Schedule' }));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          group: true,
          title: 'DBT skills',
          participants: [
            { client_id: 3, billable: true },
            { client_id: 5, billable: true },
          ],
        }),
      ),
    );
  });

  it('makes a group psychotherapy service a group session', async () => {
    const user = userEvent.setup();
    renderModal({ mode: 'create', startsAt: '2026-09-25T14:00:00Z' });
    await user.selectOptions(await screen.findByLabelText(/^Service/), '9');
    const group = screen.getByRole('checkbox', { name: /Group session/ });
    expect(group).toBeChecked();
    expect(group).toBeDisabled();
  });

  it('shows validation errors instead of submitting', async () => {
    const user = userEvent.setup();
    renderModal({ mode: 'create', startsAt: '2026-09-25T14:00:00Z' });

    await user.click(await screen.findByRole('button', { name: 'Schedule' }));
    expect(screen.getByText('Choose a client')).toBeInTheDocument();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('books only on your own calendar without the schedule-all permission', async () => {
    const user = userEvent.setup();
    mocks.create.mockResolvedValue([testAppointment()]);
    renderModal(
      { mode: 'create', startsAt: '2026-09-25T14:00:00Z', clientId: 3 },
      testSession({ staff: { id: 2, role: 'clinician' }, capabilities: [] }),
    );
    await screen.findByRole('list', { name: 'Clients in this appointment' });
    expect(screen.queryByLabelText(/^Clinician/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Schedule' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ clinician_id: 2 })));
  });

  it('asks a scheduler who is not a clinician to choose whose calendar', async () => {
    const user = userEvent.setup();
    mocks.create.mockResolvedValue([testAppointment()]);
    renderModal(
      { mode: 'create', startsAt: '2026-09-25T14:00:00Z', clientId: 3 },
      testSession({ staff: { id: 8, role: 'scheduler', is_clinician: false }, capabilities: ['view_all_clients', 'schedule_all'] }),
    );
    await screen.findByRole('list', { name: 'Clients in this appointment' });
    await user.click(screen.getByRole('button', { name: 'Schedule' }));
    expect(screen.getByText('Choose a clinician', { selector: 'p' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/^Clinician/), 'Jordan Park');
    await user.click(screen.getByRole('button', { name: 'Schedule' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ clinician_id: 2 })));
  });

  it('shows each billed client’s fee when editing a couples session', async () => {
    renderModal({
      mode: 'edit',
      appointment: testAppointment({
        title_label: 'Alex Rivera & Sam Rivera',
        participants: [
          testParticipant({ fee_cents: 12000 }),
          testParticipant({ id: 302, client: { id: 4, name: 'Sam Rivera' }, billable: false, fee_cents: 0 }),
        ],
      }),
    });
    const chips = await screen.findByRole('list', { name: 'Clients in this appointment' });
    expect(within(chips).getByText('$120.00')).toBeInTheDocument();
    expect(within(chips).getByText('Not billed')).toBeInTheDocument();
  });

  it('edits a recurring appointment for this and following occurrences', async () => {
    const user = userEvent.setup();
    const original = testAppointment({ id: 99, series_id: 12 });
    mocks.update.mockResolvedValue([testAppointment({ id: 99, series_id: 12, starts_at: '2026-09-25T15:00:00Z' })]);

    const { onSaved } = renderModal({ mode: 'edit', appointment: original });

    const time = await screen.findByLabelText(/^Start time/);
    expect(screen.queryByLabelText('Repeat')).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /This and following/ }));
    await user.clear(time);
    await user.type(time, '11:00');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(mocks.update).toHaveBeenCalledWith(99, { starts_at: '2026-09-25T15:00:00.000Z' }, 'following');
  });
});
