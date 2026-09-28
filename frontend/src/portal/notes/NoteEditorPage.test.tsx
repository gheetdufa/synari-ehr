import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aiApi } from '../../api/ai';
import { appointmentsApi } from '../../api/appointments';
import { notesApi, type Note } from '../../api/notes';
import { teamApi, type TeamMember } from '../../api/team';
import type { Session } from '../../api/auth';
import { page } from '../../test/page';
import { testSession, WithSession } from '../../test/session';
import { ToastProvider } from '../../ui/Toast';
import { ALL_FORMATS } from './formats.fixture';
import NoteEditorPage from './NoteEditorPage';

vi.mock('../../api/notes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/notes')>();
  return {
    ...actual,
    notesApi: {
      formats: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      sign: vi.fn(),
      unlock: vi.fn(),
      remove: vi.fn(),
      list: vi.fn(),
      create: vi.fn(),
      backlog: vi.fn(),
      cosign: vi.fn(),
      requestChanges: vi.fn(),
      revisions: vi.fn(),
      addenda: vi.fn(),
      addAddendum: vi.fn(),
    },
  };
});

vi.mock('../../api/team', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/team')>();
  return { ...actual, teamApi: { ...actual.teamApi, list: vi.fn() } };
});

vi.mock('../../api/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/ai')>();
  return { ...actual, aiApi: { generateNote: vi.fn(), assistant: vi.fn(), transcribe: vi.fn() } };
});

vi.mock('../../api/appointments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/appointments')>();
  return { ...actual, appointmentsApi: { ...actual.appointmentsApi, list: vi.fn(), get: vi.fn() } };
});

vi.mock('../../lib/usePublicConfig', () => ({
  usePublicConfig: () => ({
    registration_enabled: true,
    email_enabled: false,
    sms_enabled: false,
    payments_enabled: false,
    telehealth_enabled: false,
    ai_enabled: true,
    livekit_url: '',
  }),
}));

const AUTHOR = { id: 1, name: 'Dana Lee, LCSW' };
const SUPERVISOR = { id: 9, name: 'Morgan Hale, PhD' };

const draft: Note = {
  id: 1,
  client: { id: 3, first_name: 'Alex', last_name: 'Rivera', preferred_name: '' },
  author: AUTHOR,
  appointment_id: null,
  note_type: 'progress',
  format: 'SOAP',
  title: 'Progress note – Oct 5, 2026',
  status: 'draft',
  signed_at: null,
  supervisor: null,
  cosigned_at: null,
  supervisor_comment: '',
  was_signed: false,
  ai_generated: false,
  risk_level: 'none',
  appointment_starts_at: null,
  appointment_participant_count: 0,
  created_at: '2026-10-05T15:00:00Z',
  updated_at: '2026-10-05T15:00:00Z',
  sections: { subjective: 'Reports better sleep.', objective: '', assessment: '', plan: '' },
  content: '',
  risk_flags: [],
  integrity: null,
  revision_count: 0,
  addendum_count: 0,
  pending_revision_reason: '',
};

/** Someone on the team, for the supervision lookups. */
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

/** Signed in as the note's author (Dana, id 1) unless another session is given. */
function renderEditor(session: Session = testSession()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WithSession session={session}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/portal/notes/1']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <Routes>
              <Route path="/portal/notes/:noteId" element={<NoteEditorPage />} />
              <Route path="/portal/notes" element={<p>Notes list</p>} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </WithSession>
    </QueryClientProvider>,
  );
}

/** A supervisee (Dana, supervised by Morgan) or Morgan themselves. */
const supervisee = testSession({ staff: { role: 'clinician', supervisor_id: SUPERVISOR.id }, capabilities: [] });
const supervisor = testSession({
  staff: { id: SUPERVISOR.id, first_name: 'Morgan', last_name: 'Hale', display_name: SUPERVISOR.name, role: 'clinician' },
  capabilities: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(teamApi.list).mockResolvedValue([
    member(AUTHOR.id, { display_name: AUTHOR.name, supervisor_id: SUPERVISOR.id }),
    member(SUPERVISOR.id, { display_name: SUPERVISOR.name }),
  ]);
  vi.mocked(notesApi.formats).mockResolvedValue(ALL_FORMATS);
  vi.mocked(notesApi.list).mockResolvedValue(page([]));
  vi.mocked(appointmentsApi.list).mockResolvedValue([]);
  vi.mocked(notesApi.update).mockImplementation(async (id, changes) => ({ ...draft, id, ...changes }) as Note);
});

describe('NoteEditorPage', () => {
  it('shows one field per section with its guidance and saves edits on blur', async () => {
    vi.mocked(notesApi.get).mockResolvedValue(draft);
    const user = userEvent.setup();
    renderEditor();

    const subjective = await screen.findByLabelText('Subjective');
    expect(subjective).toHaveValue('Reports better sleep.');
    expect(subjective).toHaveAccessibleDescription('What the client reported.');
    expect(screen.getByLabelText('Plan')).toHaveValue('');
    expect(screen.getByRole('link', { name: /Alex Rivera/ })).toHaveAttribute('href', '/portal/clients/3');

    const plan = screen.getByLabelText('Plan');
    await user.type(plan, 'Continue CBT');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await user.tab();

    await waitFor(() =>
      expect(notesApi.update).toHaveBeenCalledWith(1, {
        format: 'SOAP',
        sections: { subjective: 'Reports better sleep.', objective: '', assessment: '', plan: 'Continue CBT' },
        content: '',
      }),
    );
    expect(await screen.findByText('Saved just now')).toBeInTheDocument();
  });

  it('applies an AI draft section by section and surfaces its risk flags', async () => {
    vi.mocked(notesApi.get).mockResolvedValue({ ...draft, sections: { subjective: '', objective: '', assessment: '', plan: '' } });
    vi.mocked(aiApi.generateNote).mockResolvedValue({
      format: 'SOAP',
      sections: { subjective: 'AI subjective', objective: 'AI objective', assessment: 'AI assessment', plan: 'AI plan' },
      content: '',
      risk_flags: ['Client mentioned passive thoughts of death'],
    });
    const user = userEvent.setup();
    renderEditor();

    await user.type(await screen.findByLabelText('Session material'), 'Rough notes from today');
    await user.click(screen.getByRole('button', { name: 'Generate draft' }));

    expect(aiApi.generateNote).toHaveBeenCalledWith(
      { client_id: 3, appointment_id: null, format: 'SOAP', note_type: 'progress', source_text: 'Rough notes from today' },
      expect.any(AbortSignal),
    );
    expect(await screen.findByText('AI draft ready — review it before using it')).toBeInTheDocument();
    expect(screen.getByText('Client mentioned passive thoughts of death')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Use the AI draft for Plan' }));
    expect(screen.getByLabelText('Plan')).toHaveValue('AI plan');
    expect(screen.getByLabelText('Subjective')).toHaveValue('');
    // The flag now belongs to the note itself, not just the draft.
    expect(screen.getByText('AI noticed possible safety concerns — review')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByLabelText('Plan')).toHaveValue('');
  });

  it('signs after confirmation and then shows the locked note', async () => {
    vi.mocked(notesApi.get).mockResolvedValue(draft);
    vi.mocked(notesApi.sign).mockResolvedValue({
      ...draft,
      status: 'signed',
      signed_at: '2026-10-05T16:00:00Z',
      was_signed: true,
    });
    const user = userEvent.setup();
    renderEditor();

    await user.click(await screen.findByRole('button', { name: /Sign note/ }));
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByText('Signing locks this note. Session audio and transcript linked to it will be deleted.'),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Sign and lock' }));

    expect(await screen.findByRole('button', { name: /Unlock to amend/ })).toBeInTheDocument();
    expect(notesApi.sign).toHaveBeenCalledWith(1);
    expect(screen.queryByRole('textbox', { name: 'Subjective' })).not.toBeInTheDocument();
    expect(screen.getByText('Reports better sleep.')).toBeInTheDocument();
    expect(screen.getByText(/Signed .* · Locked/)).toBeInTheDocument();
    expect(await screen.findByText('Note signed and locked.')).toBeInTheDocument();
  });

  it('shows the recording banner on AI-generated drafts and hides delete for once-signed notes', async () => {
    vi.mocked(notesApi.get).mockResolvedValue({ ...draft, ai_generated: true, was_signed: true });
    renderEditor();
    expect(await screen.findByText('AI draft from session recording — review before signing')).toBeInTheDocument();
    expect(screen.getByText('Unlocked for amendment')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete draft' })).not.toBeInTheDocument();
  });
});

describe('authorship and supervision', () => {
  const pending: Note = {
    ...draft,
    status: 'pending_cosign',
    signed_at: '2026-10-05T16:00:00Z',
    was_signed: true,
    supervisor: SUPERVISOR,
  };

  it('shows someone else\'s draft read-only, naming its author', async () => {
    vi.mocked(notesApi.get).mockResolvedValue({ ...draft, author: { id: 7, name: 'Jordan Park, LMFT' } });
    renderEditor();

    expect(await screen.findByText('Written by Jordan Park, LMFT')).toBeInTheDocument();
    expect(screen.getByText("This draft isn't signed yet. Only Jordan Park, LMFT can edit or sign it.")).toBeInTheDocument();
    expect(screen.getByText('Reports better sleep.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sign note/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Unlock/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download PDF/ })).toBeInTheDocument();
  });

  it('tells the author their signed note is waiting for the co-signature and keeps it locked', async () => {
    vi.mocked(notesApi.get).mockResolvedValue(pending);
    renderEditor(supervisee);

    expect(await screen.findByText("Waiting for Morgan Hale, PhD's co-signature")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Unlock/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Co-sign/ })).not.toBeInTheDocument();
    expect(screen.getByText('awaiting co-signature')).toBeInTheDocument();
  });

  it('lets the author unlock a pending note once the supervisor asked is no longer theirs', async () => {
    vi.mocked(notesApi.get).mockResolvedValue(pending);
    vi.mocked(notesApi.unlock).mockResolvedValue({ ...pending, status: 'draft', signed_at: null });
    const user = userEvent.setup();
    renderEditor(testSession({ staff: { role: 'clinician', supervisor_id: null }, capabilities: [] }));

    await user.click(await screen.findByRole('button', { name: /Unlock to sign again/ }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    expect(within(dialog).getByText('Enter reason for the change')).toBeInTheDocument();
    expect(notesApi.unlock).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText(/Reason for the change/), 'Supervisor left the practice');
    await user.click(within(dialog).getByRole('button', { name: 'Unlock' }));
    expect(notesApi.unlock).toHaveBeenCalledWith(1, 'Supervisor left the practice');
    expect(await screen.findByLabelText('Subjective')).toHaveValue('Reports better sleep.');
  });

  it('lets the supervisor co-sign a note waiting for them', async () => {
    vi.mocked(notesApi.get).mockResolvedValue(pending);
    vi.mocked(notesApi.cosign).mockResolvedValue({ ...pending, status: 'signed', cosigned_at: '2026-10-06T14:00:00Z' });
    const user = userEvent.setup();
    renderEditor(supervisor);

    expect(await screen.findByText('Written by Dana Lee, LCSW')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Unlock/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Co-sign/ }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Co-sign' }));

    expect(notesApi.cosign).toHaveBeenCalledWith(1);
    expect(await screen.findByText(/Co-signed Dana Lee, LCSW's note for Alex Rivera/)).toBeInTheDocument();
    const signatures = screen.getByRole('heading', { name: 'Signatures' }).parentElement!;
    expect(within(signatures).getByText(/Dana Lee, LCSW · /)).toBeInTheDocument();
    expect(within(signatures).getByText(/Morgan Hale, PhD · /)).toBeInTheDocument();
  });

  it('requires a comment when the supervisor sends a note back', async () => {
    vi.mocked(notesApi.get).mockResolvedValue(pending);
    vi.mocked(notesApi.requestChanges).mockResolvedValue({
      ...pending,
      status: 'draft',
      signed_at: null,
      supervisor_comment: 'Add the safety plan.',
    });
    const user = userEvent.setup();
    renderEditor(supervisor);

    await user.click(await screen.findByRole('button', { name: /^Request changes/ }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Send back' }));
    expect(within(dialog).getByText('Tell the author what to change.')).toBeInTheDocument();
    expect(notesApi.requestChanges).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText(/Comment for the author/), 'Add the safety plan.');
    await user.click(within(dialog).getByRole('button', { name: 'Send back' }));
    expect(notesApi.requestChanges).toHaveBeenCalledWith(1, 'Add the safety plan.');
    // Back to a draft that only its author can edit.
    expect(await screen.findByText('Morgan Hale, PhD asked for changes')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('shows the supervisor\'s comment on a returned draft and names them when signing again', async () => {
    vi.mocked(notesApi.get).mockResolvedValue({
      ...draft,
      was_signed: true,
      supervisor: SUPERVISOR,
      supervisor_comment: 'Add the safety plan.',
    });
    vi.mocked(notesApi.sign).mockResolvedValue(pending);
    const user = userEvent.setup();
    renderEditor(supervisee);

    expect(await screen.findByText('Morgan Hale, PhD asked for changes')).toBeInTheDocument();
    expect(screen.getByText('Add the safety plan.')).toBeInTheDocument();
    expect(screen.queryByText('Unlocked for amendment')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Sign note/ }));
    expect(within(screen.getByRole('dialog')).getByText('It then goes to Morgan Hale, PhD to co-sign.')).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Sign and lock' }));
    expect(await screen.findByText('Note signed and sent to Morgan Hale, PhD to co-sign.')).toBeInTheDocument();
    expect(screen.getByText("Waiting for Morgan Hale, PhD's co-signature")).toBeInTheDocument();
  });
});

describe('record integrity', () => {
  const signed: Note = {
    ...draft,
    status: 'signed',
    signed_at: '2026-10-05T16:00:00Z',
    was_signed: true,
    integrity: 'verified',
    revision_count: 2,
    addendum_count: 1,
  };
  const HASH = '0123456789abcdef'.repeat(4);

  it('shows the signature check, addenda and the signed versions', async () => {
    vi.mocked(notesApi.get).mockResolvedValue(signed);
    vi.mocked(notesApi.addenda).mockResolvedValue([
      {
        id: 3,
        note_id: 1,
        author: AUTHOR,
        content: 'Late entry: client called after the session.',
        content_sha256: HASH,
        amendment_request_id: 8,
        created_at: '2026-10-06T12:00:00Z',
        integrity: 'verified',
      },
    ]);
    vi.mocked(notesApi.revisions).mockResolvedValue([
      {
        id: 10,
        version: 1,
        title: 'First version title',
        sections: { subjective: 'Reports poor sleep.' },
        content: '',
        content_sha256: HASH,
        signed_by: AUTHOR,
        signed_at: '2026-10-05T15:30:00Z',
        cosigned_by: null,
        cosigned_at: null,
        reason: '',
        created_at: '2026-10-05T15:30:00Z',
        integrity: 'verified',
      },
      {
        id: 11,
        version: 2,
        title: 'Progress note – Oct 5, 2026',
        sections: { subjective: 'Reports better sleep.' },
        content: '',
        content_sha256: 'f'.repeat(64),
        signed_by: AUTHOR,
        signed_at: '2026-10-05T16:00:00Z',
        cosigned_by: null,
        cosigned_at: null,
        reason: 'Corrected the sleep report',
        created_at: '2026-10-05T16:00:00Z',
        integrity: 'mismatch',
      },
    ]);
    const user = userEvent.setup();
    renderEditor();

    expect(await screen.findByText('Signature verified')).toBeInTheDocument();
    expect(await screen.findByText('Late entry: client called after the session.')).toBeInTheDocument();
    expect(screen.getByText('Client amendment')).toBeInTheDocument();
    expect(notesApi.revisions).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Signed versions \(2\)/ }));
    const versions = await screen.findByRole('list', { name: 'Signed versions' });
    expect(within(versions).getByText('Version 1')).toBeInTheDocument();
    expect(within(versions).getByText('Corrected the sleep report')).toBeInTheDocument();
    expect(within(versions).getByText('Integrity check failed')).toBeInTheDocument();
    expect(within(versions).getByText('ffffffffffff')).toBeInTheDocument();
    await user.click(within(versions).getAllByRole('button', { name: 'Show text' })[0]);
    expect(within(versions).getByText('Reports poor sleep.')).toBeInTheDocument();
  });

  it('adds an addendum to a signed note without unlocking it', async () => {
    vi.mocked(notesApi.get).mockResolvedValue({ ...signed, addendum_count: 0, revision_count: 1 });
    vi.mocked(notesApi.addAddendum).mockResolvedValue({
      id: 4,
      note_id: 1,
      author: AUTHOR,
      content: 'Spoke with the school counselor.',
      content_sha256: HASH,
      amendment_request_id: null,
      created_at: '2026-10-07T12:00:00Z',
      integrity: 'verified',
    });
    const user = userEvent.setup();
    renderEditor();

    await user.click(await screen.findByRole('button', { name: 'Add addendum' }));
    const form = screen.getByRole('form', { name: 'Add addendum' });
    await user.click(within(form).getByRole('button', { name: 'Add addendum' }));
    expect(within(form).getByText('Write the addendum first')).toBeInTheDocument();
    await user.type(within(form).getByLabelText(/Addendum/), 'Spoke with the school counselor.');
    await user.click(within(form).getByRole('button', { name: 'Add addendum' }));
    expect(notesApi.addAddendum).toHaveBeenCalledWith(1, 'Spoke with the school counselor.');
    expect(await screen.findByText('Addendum added')).toBeInTheDocument();
  });

  it("offers addenda to the author's supervisor but not to other readers", async () => {
    vi.mocked(notesApi.get).mockResolvedValue({ ...signed, addendum_count: 0 });
    renderEditor(supervisor);
    expect(await screen.findByRole('button', { name: 'Add addendum' })).toBeInTheDocument();
  });

  it('hides the addendum form from someone who only reads the note', async () => {
    vi.mocked(notesApi.get).mockResolvedValue({ ...signed, addendum_count: 0 });
    renderEditor(testSession({ staff: { id: 5, role: 'owner' } }));
    expect(await screen.findByText('Signature verified')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add addendum' })).not.toBeInTheDocument();
  });

  it('warns when the signed text no longer matches its hash', async () => {
    vi.mocked(notesApi.get).mockResolvedValue({ ...signed, integrity: 'mismatch', addendum_count: 0 });
    renderEditor();
    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer matches the hash taken when it was signed/);
    expect(screen.getAllByText('Integrity check failed').length).toBeGreaterThan(0);
    expect(screen.queryByText('Signature verified')).not.toBeInTheDocument();
  });

  it('labels psychotherapy notes as kept separate from the record', async () => {
    vi.mocked(notesApi.get).mockResolvedValue({ ...signed, note_type: 'psychotherapy', addendum_count: 0 });
    renderEditor();
    expect(await screen.findByText('Psychotherapy note — kept separate from the record')).toBeInTheDocument();
    expect(screen.getByText(/never shared in the portal, included in record exports/)).toBeInTheDocument();
  });

  it('explains the psychotherapy note type while drafting and shows the unlock reason', async () => {
    vi.mocked(notesApi.get).mockResolvedValue({
      ...draft,
      note_type: 'psychotherapy',
      was_signed: true,
      pending_revision_reason: 'Wrong session date',
    });
    renderEditor();
    expect(await screen.findByText('Psychotherapy note — kept separate from the record')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Psychotherapy note' })).toBeInTheDocument();
    expect(screen.getByText('Wrong session date')).toBeInTheDocument();
  });
});
