import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteSummary } from '../../api/notes';
import type { AmendmentRequest, RecordRequest } from '../../api/records';
import { page } from '../../test/page';
import { testSession, WithSession } from '../../test/session';
import { ToastProvider } from '../../ui/Toast';
import { byDeadline, dueText, dueTone } from './recordHelpers';
import RecordsPage from './RecordsPage';

const mocks = vi.hoisted(() => ({
  requests: vi.fn(),
  extend: vi.fn(),
  fulfill: vi.fn(),
  deny: vi.fn(),
  downloadPackage: vi.fn(),
  amendments: vi.fn(),
  acceptAmendment: vi.fn(),
  denyAmendment: vi.fn(),
  addRebuttal: vi.fn(),
  notes: vi.fn(),
}));

vi.mock('../../api/records', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/records')>();
  return {
    ...actual,
    recordsApi: {
      ...actual.recordsApi,
      requests: mocks.requests,
      extend: mocks.extend,
      fulfill: mocks.fulfill,
      deny: mocks.deny,
      downloadPackage: mocks.downloadPackage,
      amendments: mocks.amendments,
      acceptAmendment: mocks.acceptAmendment,
      denyAmendment: mocks.denyAmendment,
      addRebuttal: mocks.addRebuttal,
    },
  };
});
vi.mock('../../api/notes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/notes')>();
  return { ...actual, notesApi: { ...actual.notesApi, list: mocks.notes } };
});

const ALEX = { id: 7, first_name: 'Alex', last_name: 'Rivera', preferred_name: '' };
const JO = { id: 8, first_name: 'Jo', last_name: 'Park', preferred_name: '' };

function request(id: number, changes: Partial<RecordRequest> = {}): RecordRequest {
  return {
    id,
    client: ALEX,
    requested_by: 'client',
    requested_by_contact_id: null,
    received_at: '2026-09-01T14:00:00Z',
    due_on: '2026-10-01',
    days_left: 5,
    overdue: false,
    extended_on: null,
    extension_reason: '',
    scope: 'Complete record',
    delivery: 'portal',
    recipient: '',
    status: 'open',
    fulfilled_at: null,
    fulfilled_by: null,
    release_expires_at: null,
    release_available: false,
    denial_reason: '',
    created_at: '2026-09-01T14:00:00Z',
    ...changes,
  };
}

function amendment(id: number, changes: Partial<AmendmentRequest> = {}): AmendmentRequest {
  return {
    id,
    client: ALEX,
    note_id: null,
    note_title: '',
    requested_by: 'client',
    received_at: '2026-09-01T14:00:00Z',
    due_on: '2026-10-31',
    days_left: 35,
    overdue: false,
    request: 'My intake lists the wrong medication.',
    status: 'open',
    decided_at: null,
    decided_by: null,
    denial_reason: '',
    disagreement: '',
    rebuttal: '',
    addendum_id: null,
    created_at: '2026-09-01T14:00:00Z',
    ...changes,
  };
}

function signedNote(id: number, changes: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id,
    client: ALEX,
    author: { id: 1, name: 'Dana Lee, LCSW' },
    appointment_id: null,
    note_type: 'intake',
    format: 'SOAP',
    title: `Note ${id}`,
    status: 'signed',
    signed_at: '2026-08-01T15:00:00Z',
    supervisor: null,
    cosigned_at: null,
    supervisor_comment: '',
    was_signed: true,
    ai_generated: false,
    risk_level: 'none',
    risk_flags: [],
    appointment_starts_at: null,
    appointment_participant_count: 0,
    integrity: 'verified',
    created_at: '2026-08-01T14:00:00Z',
    updated_at: '2026-08-01T15:00:00Z',
    ...changes,
  };
}

function renderPage(path = '/portal/records') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WithSession session={testSession()}>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <Routes>
              <Route path="/portal/records" element={<RecordsPage />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </WithSession>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.requests.mockResolvedValue([]);
  mocks.amendments.mockResolvedValue([]);
  mocks.notes.mockResolvedValue(page([]));
});

describe('record request helpers', () => {
  it('describes deadlines and colors them from day 20', () => {
    expect(dueText(12)).toBe('Due in 12 days');
    expect(dueText(1)).toBe('Due tomorrow');
    expect(dueText(0)).toBe('Due today');
    expect(dueText(-3)).toBe('Overdue by 3 days');
    expect(dueTone(11)).toBe('neutral');
    expect(dueTone(10)).toBe('warning');
    expect(dueTone(-1)).toBe('danger');
  });

  it('puts open requests first by deadline, then closed ones newest first', () => {
    const items = [
      { id: 1, status: 'fulfilled', due_on: '2026-09-01', received_at: '2026-08-01T00:00:00Z' },
      { id: 2, status: 'open', due_on: '2026-10-20', received_at: '2026-09-20T00:00:00Z' },
      { id: 3, status: 'open', due_on: '2026-10-02', received_at: '2026-09-02T00:00:00Z' },
      { id: 4, status: 'denied', due_on: '2026-09-15', received_at: '2026-08-15T00:00:00Z' },
    ];
    expect(byDeadline(items).map((item) => item.id)).toEqual([3, 2, 4, 1]);
  });
});

describe('copies of records', () => {
  it('lists open requests soonest first with their deadlines', async () => {
    mocks.requests.mockResolvedValue([
      request(1, { client: JO, due_on: '2026-10-20', days_left: 24 }),
      request(2, { due_on: '2026-09-28', days_left: -2, overdue: true }),
    ]);
    renderPage();
    const list = await screen.findByRole('list', { name: 'Record requests' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Alex Rivera');
    expect(items[0]).toHaveTextContent('Overdue by 2 days');
    expect(items[1]).toHaveTextContent('Jo Park');
    expect(items[1]).toHaveTextContent('Due in 24 days');
    expect(mocks.requests).toHaveBeenCalledWith({ status: 'open' });
  });

  it('extends once with a reason the client is told', async () => {
    mocks.requests.mockResolvedValue([request(1)]);
    mocks.extend.mockResolvedValue(request(1, { extended_on: '2026-09-26' }));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Extend' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Extend' }));
    expect(within(dialog).getByText('Enter reason for the extension')).toBeInTheDocument();
    expect(mocks.extend).not.toHaveBeenCalled();
    await user.type(within(dialog).getByLabelText(/Reason for the extension/), 'Records are stored off site');
    await user.click(within(dialog).getByRole('button', { name: 'Extend' }));
    expect(mocks.extend).toHaveBeenCalledWith(1, 'Records are stored off site');
    expect(await screen.findByText('Deadline extended by 30 days')).toBeInTheDocument();
  });

  it('hides Extend once a request was extended', async () => {
    mocks.requests.mockResolvedValue([request(1, { extended_on: '2026-09-20', extension_reason: 'Off site' })]);
    renderPage();
    expect(await screen.findByText('Off site')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Extend' })).not.toBeInTheDocument();
  });

  it('releases a portal request with or without billing records', async () => {
    mocks.requests.mockResolvedValue([request(1)]);
    mocks.fulfill.mockResolvedValue(request(1, { status: 'fulfilled' }));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Fulfill' }));
    const dialog = screen.getByRole('dialog', { name: 'Release the record in the portal' });
    await user.click(within(dialog).getByRole('switch', { name: /Include billing records/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Release to client' }));
    expect(mocks.fulfill).toHaveBeenCalledWith(1, { include_billing: false });
    expect(await screen.findByText('Released in the client portal')).toBeInTheDocument();
  });

  it('downloads the package for a third-party request and records how it was sent', async () => {
    mocks.requests.mockResolvedValue([
      request(1, { delivery: 'third_party', recipient: 'Dr. Kim, 12 Elm St, Springfield' }),
    ]);
    mocks.downloadPackage.mockResolvedValue(undefined);
    mocks.fulfill.mockResolvedValue(request(1, { status: 'fulfilled' }));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Fulfill' }));
    const dialog = screen.getByRole('dialog', { name: 'Send the record to the recipient' });
    expect(within(dialog).getByText('Dr. Kim, 12 Elm St, Springfield')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Download record' }));
    expect(mocks.downloadPackage).toHaveBeenCalledWith(1, true);
    await user.type(within(dialog).getByLabelText('How it was sent'), 'Mailed by certified post');
    await user.click(within(dialog).getByRole('button', { name: 'Mark as sent' }));
    expect(mocks.fulfill).toHaveBeenCalledWith(1, { include_billing: true, note: 'Mailed by certified post' });
  });

  it('denies with a reason', async () => {
    mocks.requests.mockResolvedValue([request(1)]);
    mocks.deny.mockResolvedValue(request(1, { status: 'denied' }));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Deny' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Reason for the denial/), 'Requester is not the personal representative');
    await user.click(within(dialog).getByRole('button', { name: 'Deny request' }));
    expect(mocks.deny).toHaveBeenCalledWith(1, 'Requester is not the personal representative');
  });

  it('shows closed requests when asked', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('No open requests');
    await user.selectOptions(screen.getByLabelText('Show requests'), 'fulfilled');
    await waitFor(() => expect(mocks.requests).toHaveBeenLastCalledWith({ status: 'fulfilled' }));
  });
});

describe('links from notifications', () => {
  it('opens the linked request, even a closed one, and marks it', async () => {
    mocks.requests.mockResolvedValue([request(1), request(2, { status: 'fulfilled', client: JO })]);
    renderPage('/portal/records?request=2');
    const list = await screen.findByRole('list', { name: 'Record requests' });
    expect(mocks.requests).toHaveBeenCalledWith({});
    const linked = within(list).getAllByRole('listitem').find((item) => item.getAttribute('aria-current') === 'true');
    expect(linked).toHaveTextContent('Jo Park');
    await waitFor(() => expect(linked).toHaveFocus());
    expect(screen.getByRole('tab', { name: 'Copies of records' })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens the amendments tab for a linked amendment', async () => {
    mocks.amendments.mockResolvedValue([amendment(5), amendment(6, { client: JO })]);
    renderPage('/portal/records?amendment=6');
    const list = await screen.findByRole('list', { name: 'Amendment requests' });
    expect(screen.getByRole('tab', { name: 'Amendments' })).toHaveAttribute('aria-selected', 'true');
    const linked = within(list).getAllByRole('listitem').find((item) => item.getAttribute('aria-current') === 'true');
    expect(linked).toHaveTextContent('Jo Park');
    expect(mocks.requests).not.toHaveBeenCalled();
  });

  it('ignores ids that are not numbers', async () => {
    renderPage('/portal/records?request=abc');
    await screen.findByText('No open requests');
    expect(mocks.requests).toHaveBeenCalledWith({ status: 'open' });
  });
});

describe('amendments', () => {
  it('accepts by adding an addendum to a chosen signed note', async () => {
    mocks.amendments.mockResolvedValue([amendment(5)]);
    mocks.notes.mockResolvedValue(
      page([
        signedNote(20, { title: 'Intake assessment' }),
        signedNote(21, { title: 'Private notes', note_type: 'psychotherapy' }),
        signedNote(22, { title: 'Draft note', status: 'draft' }),
      ]),
    );
    mocks.acceptAmendment.mockResolvedValue(amendment(5, { status: 'accepted' }));
    const user = userEvent.setup();
    renderPage('/portal/records?tab=amendments');

    await user.click(await screen.findByRole('button', { name: 'Accept' }));
    const dialog = screen.getByRole('dialog', { name: 'Accept the amendment' });
    await user.click(within(dialog).getByRole('button', { name: 'Accept and add addendum' }));
    expect(within(dialog).getByText('Choose the note the amendment applies to')).toBeInTheDocument();
    expect(within(dialog).getByText('Write the amendment to add to the note')).toBeInTheDocument();

    const picker = within(dialog).getByLabelText(/Note to amend/);
    await waitFor(() => expect(within(picker).getAllByRole('option')).toHaveLength(2));
    expect(within(picker).queryByRole('option', { name: /Private notes/ })).not.toBeInTheDocument();
    await user.selectOptions(picker, '20');
    await user.type(within(dialog).getByLabelText(/^Amendment/), 'Medication corrected to sertraline 50 mg.');
    await user.click(within(dialog).getByRole('button', { name: 'Accept and add addendum' }));
    expect(mocks.acceptAmendment).toHaveBeenCalledWith(5, {
      content: 'Medication corrected to sertraline 50 mg.',
      note_id: 20,
    });
    expect(mocks.notes).toHaveBeenCalledWith({ client_id: 7, limit: 200 });
  });

  it('accepts against the note the client named without asking again', async () => {
    mocks.amendments.mockResolvedValue([amendment(5, { note_id: 20, note_title: 'Intake assessment' })]);
    mocks.acceptAmendment.mockResolvedValue(amendment(5, { status: 'accepted' }));
    const user = userEvent.setup();
    renderPage('/portal/records?tab=amendments');

    await user.click(await screen.findByRole('button', { name: 'Accept' }));
    const dialog = screen.getByRole('dialog', { name: 'Accept the amendment' });
    expect(within(dialog).getByRole('link', { name: 'Intake assessment' })).toHaveAttribute('href', '/portal/notes/20');
    await user.type(within(dialog).getByLabelText(/^Amendment/), 'Corrected.');
    await user.click(within(dialog).getByRole('button', { name: 'Accept and add addendum' }));
    expect(mocks.acceptAmendment).toHaveBeenCalledWith(5, { content: 'Corrected.' });
    expect(mocks.notes).not.toHaveBeenCalled();
  });

  it('denies with a reason, then answers a disagreement with a rebuttal', async () => {
    mocks.amendments.mockResolvedValue([amendment(5)]);
    mocks.denyAmendment.mockResolvedValue(amendment(5, { status: 'denied' }));
    const user = userEvent.setup();
    const { unmount } = renderPage('/portal/records?tab=amendments');

    await user.click(await screen.findByRole('button', { name: 'Deny' }));
    let dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Reason for the denial/), 'The record is accurate and complete');
    await user.click(within(dialog).getByRole('button', { name: 'Deny amendment' }));
    expect(mocks.denyAmendment).toHaveBeenCalledWith(5, 'The record is accurate and complete');
    unmount();

    mocks.amendments.mockResolvedValue([
      amendment(5, {
        status: 'denied',
        denial_reason: 'The record is accurate and complete',
        disagreement: 'I never took that medication.',
      }),
    ]);
    mocks.addRebuttal.mockResolvedValue(amendment(5, { status: 'denied', rebuttal: 'Pharmacy records confirm it.' }));
    renderPage('/portal/records?tab=amendments');
    await user.selectOptions(await screen.findByLabelText('Show amendments'), 'denied');
    expect(await screen.findByText('I never took that medication.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add rebuttal' }));
    dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^Rebuttal/), 'Pharmacy records confirm it.');
    await user.click(within(dialog).getByRole('button', { name: 'Add rebuttal' }));
    expect(mocks.addRebuttal).toHaveBeenCalledWith(5, 'Pharmacy records confirm it.');
  });
});
