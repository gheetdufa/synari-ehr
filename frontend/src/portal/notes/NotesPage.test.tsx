import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appointmentsApi, type Appointment } from '../../api/appointments';
import type { Session } from '../../api/auth';
import { clientsApi, type ClientDetail } from '../../api/clients';
import { meApi, type StaffPreferences } from '../../api/me';
import { notesApi, type Note, type NoteSummary } from '../../api/notes';
import { teamApi, type TeamMember } from '../../api/team';
import { page } from '../../test/page';
import { testSession, WithSession } from '../../test/session';
import { ToastProvider } from '../../ui/Toast';
import { ALL_FORMATS } from './formats.fixture';
import NotesPage from './NotesPage';

vi.mock('../../api/notes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/notes')>();
  return {
    ...actual,
    notesApi: {
      formats: vi.fn(),
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      backlog: vi.fn(),
      cosignQueue: vi.fn(),
      cosign: vi.fn(),
      requestChanges: vi.fn(),
      createGroup: vi.fn(),
      signSession: vi.fn(),
    },
  };
});
vi.mock('../../api/appointments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/appointments')>();
  return { ...actual, appointmentsApi: { ...actual.appointmentsApi, list: vi.fn(), get: vi.fn() } };
});
vi.mock('../../api/team', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/team')>();
  return { ...actual, teamApi: { ...actual.teamApi, list: vi.fn() } };
});
vi.mock('../../api/clients', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/clients')>();
  return { ...actual, clientsApi: { ...actual.clientsApi, get: vi.fn(), list: vi.fn() } };
});
vi.mock('../../api/me', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/me')>();
  return { ...actual, meApi: { ...actual.meApi, preferences: vi.fn() } };
});

const ME = 1;
const SUPERVISEE = { id: 7, name: 'Jordan Park, LMFT' };
const ALEX = { id: 3, first_name: 'Alex', last_name: 'Rivera', preferred_name: '' };
const SAM = { id: 4, first_name: 'Sam', last_name: 'Rivera', preferred_name: '' };

function note(id: number, changes: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id,
    client: ALEX,
    author: { id: ME, name: 'Dana Lee, LCSW' },
    appointment_id: null,
    note_type: 'progress',
    format: 'SOAP',
    title: `Note ${id}`,
    status: 'draft',
    signed_at: null,
    supervisor: null,
    cosigned_at: null,
    supervisor_comment: '',
    was_signed: false,
    ai_generated: false,
    risk_level: 'none',
    risk_flags: [],
    appointment_starts_at: null,
    appointment_participant_count: 0,
    integrity: null,
    created_at: '2026-10-05T15:00:00Z',
    updated_at: '2026-10-05T15:00:00Z',
    ...changes,
  };
}

function member(id: number, changes: Partial<TeamMember> = {}): TeamMember {
  return {
    id,
    email: `staff${id}@example.com`,
    first_name: 'Staff',
    last_name: String(id),
    display_name: `Staff ${id}`,
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
    ...changes,
  };
}

/** A couples session I ran with Alex and Sam (only the fields the API sends). */
const couplesSession = {
  id: 42,
  kind: 'appointment',
  title: '',
  title_label: 'Alex Rivera & Sam Rivera',
  clinician: { id: ME, name: 'Dana Lee, LCSW' },
  participants: [
    { id: 1, client: { id: ALEX.id, name: 'Alex Rivera' }, billable: true, fee_cents: 15000, attendance: null, effective_status: 'attended' },
    { id: 2, client: { id: SAM.id, name: 'Sam Rivera' }, billable: false, fee_cents: 0, attendance: null, effective_status: 'attended' },
  ],
  is_group: false,
  service_id: 1,
  service_code: '90847',
  service_description: 'Family psychotherapy',
  starts_at: '2026-09-20T14:00:00Z',
  ends_at: '2026-09-20T14:50:00Z',
  duration_minutes: 50,
  location_type: 'video',
  location_details: '',
  status: 'attended',
  memo: '',
  request_message: '',
  series_id: null,
  has_video: true,
  canceled_at: null,
  canceled_by: null,
  cancel_reason: '',
  created_at: '2026-09-01T12:00:00Z',
  restricted: false,
} as Appointment;

const supervisor = testSession({ staff: { role: 'clinician' }, capabilities: [] });
const basicClinician = testSession({ staff: { role: 'clinician' }, capabilities: [] });

function renderPage(path: string, session: Session = testSession()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WithSession session={session}>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <Routes>
              <Route path="/portal/notes" element={<NotesPage />} />
              <Route path="/portal/notes/:noteId" element={<p>Note editor</p>} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </WithSession>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(notesApi.formats).mockResolvedValue(ALL_FORMATS);
  vi.mocked(notesApi.list).mockResolvedValue(page([]));
  vi.mocked(notesApi.cosignQueue).mockResolvedValue([]);
  vi.mocked(notesApi.backlog).mockResolvedValue({ draft_notes: 0, appointments_missing_notes: 0, notes_awaiting_cosign: 0 });
  vi.mocked(teamApi.list).mockResolvedValue([member(ME, { display_name: 'Dana Lee, LCSW' })]);
  vi.mocked(appointmentsApi.list).mockResolvedValue([]);
  vi.mocked(meApi.preferences).mockResolvedValue({ note_format_default: 'SOAP' } as StaffPreferences);
});

describe('co-sign queue', () => {
  const waiting = note(20, {
    author: SUPERVISEE,
    status: 'pending_cosign',
    signed_at: '2026-10-05T16:00:00Z',
    was_signed: true,
    supervisor: { id: ME, name: 'Dana Lee, LCSW' },
  });

  beforeEach(() => {
    vi.mocked(teamApi.list).mockResolvedValue([
      member(ME, { display_name: 'Dana Lee, LCSW' }),
      member(SUPERVISEE.id, { display_name: SUPERVISEE.name, supervisor_id: ME }),
    ]);
    vi.mocked(notesApi.backlog).mockResolvedValue({ draft_notes: 0, appointments_missing_notes: 0, notes_awaiting_cosign: 1 });
    vi.mocked(notesApi.cosignQueue).mockResolvedValueOnce([waiting]).mockResolvedValue([]);
  });

  it('lets a supervisor co-sign a supervisee\'s note from the queue', async () => {
    vi.mocked(notesApi.cosign).mockResolvedValue({ ...waiting, status: 'signed', cosigned_at: '2026-10-06T10:00:00Z' } as Note);
    const user = userEvent.setup();
    renderPage('/portal/notes?view=cosign', supervisor);

    const queue = await screen.findByRole('list', { name: 'Notes awaiting your co-signature' });
    expect(within(queue).getByText(/by Jordan Park, LMFT/)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Co-sign queue/ })).toHaveAttribute('aria-selected', 'true');

    await user.click(within(queue).getByRole('button', { name: "Co-sign Jordan Park, LMFT's note for Alex Rivera" }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Co-sign' }));

    expect(notesApi.cosign).toHaveBeenCalledWith(20);
    expect(await screen.findByText('Nothing to co-sign')).toBeInTheDocument();
  });

  it('sends a note back to its author with a comment', async () => {
    vi.mocked(notesApi.requestChanges).mockResolvedValue({ ...waiting, status: 'draft', supervisor_comment: 'Add the plan.' } as Note);
    const user = userEvent.setup();
    renderPage('/portal/notes?view=cosign', supervisor);

    await user.click(await screen.findByRole('button', { name: "Request changes to Jordan Park, LMFT's note for Alex Rivera" }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Comment for the author/), 'Add the plan.');
    await user.click(within(dialog).getByRole('button', { name: 'Send back' }));

    expect(notesApi.requestChanges).toHaveBeenCalledWith(20, 'Add the plan.');
    expect(await screen.findByText('Sent the note for Alex Rivera back to Jordan Park, LMFT.')).toBeInTheDocument();
  });

  it('points supervisors at the queue from Needs attention', async () => {
    const user = userEvent.setup();
    renderPage('/portal/notes', supervisor);

    expect(await screen.findByText('1 note is waiting for your co-signature.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open co-sign queue' }));
    expect(await screen.findByRole('list', { name: 'Notes awaiting your co-signature' })).toBeInTheDocument();
  });
});

describe('notes list filters', () => {
  it('hides the co-sign queue and author filter from clinicians who supervise no one', async () => {
    renderPage('/portal/notes', basicClinician);

    expect(await screen.findByRole('tab', { name: 'Awaiting co-sign' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Co-sign queue/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Author' })).not.toBeInTheDocument();
  });

  it('filters by author and status with practice-wide clinical access', async () => {
    vi.mocked(teamApi.list).mockResolvedValue([
      member(ME, { display_name: 'Dana Lee, LCSW' }),
      member(SUPERVISEE.id, { display_name: SUPERVISEE.name }),
      member(12, { display_name: 'Riley Biller', is_clinician: false, role: 'biller' }),
    ]);
    vi.mocked(notesApi.list).mockResolvedValue(page([note(5, { author: SUPERVISEE })]));
    const user = userEvent.setup();
    renderPage('/portal/notes');

    expect(await screen.findByText(/by Jordan Park, LMFT/)).toBeInTheDocument();
    const author = screen.getByRole('combobox', { name: 'Author' });
    await waitFor(() => expect(within(author).getByRole('option', { name: SUPERVISEE.name })).toBeInTheDocument());
    expect(within(author).queryByRole('option', { name: 'Riley Biller' })).not.toBeInTheDocument();

    await user.selectOptions(author, String(SUPERVISEE.id));
    await user.click(screen.getByRole('tab', { name: 'Awaiting co-sign' }));
    await waitFor(() =>
      expect(notesApi.list).toHaveBeenLastCalledWith({
        status: 'pending_cosign',
        client_id: undefined,
        author_id: SUPERVISEE.id,
        note_type: undefined,
        limit: 50,
        offset: 0,
      }),
    );
  });

  it('keeps New note away from staff who don\'t write notes', async () => {
    renderPage('/portal/notes', testSession({ staff: { role: 'practice_manager', is_clinician: false } }));
    expect(await screen.findByText('No notes yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New note' })).not.toBeInTheDocument();
  });
});

describe('group notes', () => {
  beforeEach(() => {
    vi.mocked(appointmentsApi.get).mockResolvedValue(couplesSession);
  });

  it('starts a draft for everyone in the session and signs them all', async () => {
    const drafts = [
      note(31, { appointment_id: 42, appointment_participant_count: 2 }),
      note(32, { client: SAM, appointment_id: 42, appointment_participant_count: 2 }),
    ];
    vi.mocked(notesApi.createGroup).mockImplementation(async () => {
      vi.mocked(notesApi.list).mockResolvedValue(page(drafts));
      return drafts as Note[];
    });
    vi.mocked(notesApi.signSession).mockResolvedValue(
      drafts.map((draft) => ({ ...draft, status: 'signed', signed_at: '2026-10-05T16:00:00Z' }) as Note),
    );
    const user = userEvent.setup();
    renderPage('/portal/notes?session=42', basicClinician);

    expect(await screen.findByText('Session notes · Alex Rivera & Sam Rivera')).toBeInTheDocument();
    expect(screen.getAllByText('No note yet.')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Write a group note' }));
    expect(notesApi.createGroup).toHaveBeenCalledWith(42, {});
    expect(await screen.findByText('Started 2 drafts, one for each client.')).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Notes for Sam Rivera' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sign all (2)' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Sign all' }));
    expect(notesApi.signSession).toHaveBeenCalledWith(42);
    expect(await screen.findByText('Signed 2 notes.')).toBeInTheDocument();
  });

  it('offers a group note from the New note dialog for a multi-client session', async () => {
    vi.mocked(clientsApi.get).mockResolvedValue(ALEX as ClientDetail);
    vi.mocked(appointmentsApi.list).mockResolvedValue([couplesSession]);
    vi.mocked(notesApi.createGroup).mockResolvedValue([]);
    const user = userEvent.setup();
    renderPage('/portal/notes?new=1&client=3', basicClinician);

    const dialog = await screen.findByRole('dialog');
    const everyone = await within(dialog).findByRole('checkbox', {
      name: /Write a group note for everyone in this session \(2 clients\)/,
    });
    await user.click(everyone);
    await user.click(within(dialog).getByRole('button', { name: 'Create notes' }));

    expect(notesApi.createGroup).toHaveBeenCalledWith(42, { note_type: 'progress', format: 'SOAP' });
    expect(await screen.findByText('Session notes · Alex Rivera & Sam Rivera')).toBeInTheDocument();
  });

  it('opens my own note for a client in a session instead of another clinician\'s', async () => {
    vi.mocked(notesApi.list).mockResolvedValue(page([]));
    vi.mocked(notesApi.create).mockResolvedValue(note(50, { appointment_id: 42 }) as Note);
    renderPage('/portal/notes?new=1&client=3&appointment=42', basicClinician);

    expect(await screen.findByText('Note editor')).toBeInTheDocument();
    expect(notesApi.list).toHaveBeenCalledWith({ appointment_id: 42, client_id: 3, author_id: ME, limit: 1 });
    expect(notesApi.create).toHaveBeenCalledWith({ client_id: 3, appointment_id: 42 });
  });
});
