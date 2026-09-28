import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { PortalClient } from '../../api/auth';
import { ApiError } from '../../api/client';
import { portalMessagesApi, type PortalConversation, type PortalMessage } from '../../api/messages';
import { ToastProvider } from '../../ui/Toast';
import ClientMessagesPage from './ClientMessagesPage';

const mocks = vi.hoisted(() => ({ client: null as PortalClient | null }));

vi.mock('../../auth/ClientAuth', () => ({ usePortalClient: () => mocks.client }));
vi.mock('../../api/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/messages')>();
  return {
    ...actual,
    portalMessagesApi: {
      conversations: vi.fn(),
      start: vi.fn(),
      messages: vi.fn(),
      uploadAttachment: vi.fn(),
      discardAttachment: vi.fn(),
      send: vi.fn(),
      markRead: vi.fn(),
      remove: vi.fn(),
    },
  };
});

const alex: PortalClient = {
  id: 7,
  first_name: 'Alex',
  last_name: 'Rivera',
  preferred_name: '',
  email: 'alex@example.com',
  clinician_name: 'Dana Lee, LCSW',
  practice_name: 'Harbor Counseling',
  time_zone: 'America/Chicago',
  permissions: { messaging: true, booking: true, billing: true },
  acting_contact: null,
  idle_timeout_minutes: 30,
};

const DANA = { id: 1, name: 'Dana Lee, LCSW' };
const SAM = { id: 2, name: 'Sam Ortiz, PhD' };

function row(clinician: PortalConversation['clinician'], changes: Partial<PortalConversation> = {}): PortalConversation {
  return { id: null, clinician, last_message_at: null, unread_count: 0, away_message: null, ...changes };
}

function message(id: number, changes: Partial<PortalMessage>): PortalMessage {
  return {
    id,
    conversation_id: 3,
    sender_role: 'staff',
    sender_name: DANA.name,
    body: '',
    removed: false,
    is_automatic: false,
    attachments: [],
    created_at: '2026-09-25T13:00:00Z',
    read_by_recipient: false,
    sent_by_me: false,
    ...changes,
  };
}

function renderPage(path = '/client/messages') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ToastProvider>
          <Routes>
            <Route path="/client/messages" element={<ClientMessagesPage />} />
          </Routes>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ClientMessagesPage', () => {
  beforeEach(() => {
    mocks.client = alex;
    vi.mocked(portalMessagesApi.markRead).mockResolvedValue(undefined);
  });

  afterEach(() => vi.clearAllMocks());

  describe('with one clinician', () => {
    it('opens the conversation straight away with the away message and the emergency note', async () => {
      vi.mocked(portalMessagesApi.conversations).mockResolvedValue([
        row(DANA, { id: 3, last_message_at: '2026-09-25T13:01:00Z', unread_count: 1, away_message: 'I am out of the office until Monday.' }),
      ]);
      vi.mocked(portalMessagesApi.messages).mockResolvedValue([
        message(1, { body: 'See you Tuesday.' }),
        message(2, { body: 'I am out of the office until Monday.', is_automatic: true, created_at: '2026-09-25T13:01:00Z' }),
      ]);
      renderPage();

      expect(await screen.findByText('See you Tuesday.')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1, name: 'Dana Lee, LCSW' })).toBeInTheDocument();
      expect(screen.queryByRole('list', { name: 'Your clinicians' })).not.toBeInTheDocument();
      expect(screen.getByText('Dana Lee, LCSW is away')).toBeInTheDocument();
      expect(screen.getByText('Automatic reply')).toBeInTheDocument();
      expect(screen.getByText('Messages aren’t monitored around the clock. In an emergency call 911 or 988.')).toBeInTheDocument();
      expect(portalMessagesApi.messages).toHaveBeenCalledWith(3, { before_id: undefined, limit: 50 });
      await waitFor(() => expect(portalMessagesApi.markRead).toHaveBeenCalledWith(3));
    });

    it('shows crisis resources after a message that needs them', async () => {
      const user = userEvent.setup();
      vi.mocked(portalMessagesApi.conversations).mockResolvedValue([row(DANA, { id: 3, last_message_at: '2026-09-25T13:00:00Z' })]);
      vi.mocked(portalMessagesApi.messages).mockResolvedValue([]);
      vi.mocked(portalMessagesApi.send).mockResolvedValue({
        ...message(5, { sender_role: 'client', sender_name: null, body: 'I do not feel safe', created_at: new Date().toISOString() }),
        crisis_resources: true,
      });
      renderPage();

      const input = await screen.findByRole('textbox', { name: 'Message' });
      await user.type(input, 'I do not feel safe{Enter}');

      const panel = await screen.findByRole('alert');
      expect(panel).toHaveTextContent('call or text 988 (Suicide & Crisis Lifeline) or call 911');
      expect(panel).toHaveTextContent('Dana Lee, LCSW may not see messages right away.');
      expect(screen.getByRole('link', { name: 'Call 988' })).toHaveAttribute('href', 'tel:988');
      expect(screen.getByRole('link', { name: 'Text 988' })).toHaveAttribute('href', 'sms:988');
      expect(screen.getByRole('link', { name: 'Call 911' })).toHaveAttribute('href', 'tel:911');
      expect(screen.getByText('I do not feel safe')).toBeInTheDocument();
      expect(portalMessagesApi.send).toHaveBeenCalledWith(3, { body: 'I do not feel safe', attachment_ids: [] });

      await user.click(screen.getByRole('button', { name: 'Close crisis resources' }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('with several clinicians', () => {
    beforeEach(() => {
      vi.mocked(portalMessagesApi.conversations).mockResolvedValue([
        row(DANA, { id: 3, last_message_at: '2026-09-25T13:00:00Z', unread_count: 2 }),
        row(SAM, { away_message: 'Back on the 30th.' }),
      ]);
      vi.mocked(portalMessagesApi.messages).mockResolvedValue([message(1, { body: 'See you Tuesday.' })]);
    });

    it('lists each clinician and opens their conversation', async () => {
      const user = userEvent.setup();
      renderPage();

      const list = await screen.findByRole('list', { name: 'Your clinicians' });
      const [dana, sam] = within(list).getAllByRole('link');
      expect(dana).toHaveTextContent('Dana Lee, LCSW');
      expect(dana).toHaveTextContent('2 new messages');
      expect(dana).toHaveAttribute('href', '/client/messages?conversation=3');
      expect(sam).toHaveTextContent('Start a conversation');
      expect(sam).toHaveTextContent('Away');
      expect(sam).toHaveAttribute('href', '/client/messages?clinician=2');
      expect(screen.getByText('Choose a conversation')).toBeInTheDocument();

      await user.click(dana);
      expect(await screen.findByText('See you Tuesday.')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 2, name: 'Dana Lee, LCSW' })).toBeInTheDocument();
      expect(dana).toHaveAttribute('aria-current', 'page');
    });

    it('starts a conversation with a care-team clinician on the first message', async () => {
      const user = userEvent.setup();
      const started = row(SAM, { id: 8, away_message: 'Back on the 30th.' });
      vi.mocked(portalMessagesApi.start).mockImplementation(() => {
        vi.mocked(portalMessagesApi.conversations).mockResolvedValue([row(DANA, { id: 3 }), started]);
        return Promise.resolve(started);
      });
      const sent = message(40, {
        conversation_id: 8,
        sender_role: 'client',
        sender_name: null,
        body: 'Hello Dr. Ortiz',
        created_at: new Date().toISOString(),
      });
      vi.mocked(portalMessagesApi.send).mockResolvedValue({ ...sent, crisis_resources: false });
      vi.mocked(portalMessagesApi.messages).mockImplementation((conversationId) =>
        Promise.resolve(conversationId === 8 ? [sent] : []),
      );
      renderPage('/client/messages?clinician=2');

      expect(await screen.findByText('Send Sam Ortiz, PhD a message')).toBeInTheDocument();
      expect(screen.getByText('Sam Ortiz, PhD is away')).toBeInTheDocument();
      expect(portalMessagesApi.messages).not.toHaveBeenCalled();

      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Hello Dr. Ortiz{Enter}');

      expect(await screen.findByText('Hello Dr. Ortiz')).toBeInTheDocument();
      expect(portalMessagesApi.start).toHaveBeenCalledWith(2);
      expect(portalMessagesApi.send).toHaveBeenCalledWith(8, { body: 'Hello Dr. Ortiz', attachment_ids: [] });
      const sam = within(screen.getByRole('list', { name: 'Your clinicians' })).getAllByRole('link')[1];
      await waitFor(() => expect(sam).toHaveAttribute('href', '/client/messages?conversation=8'));
      expect(sam).toHaveAttribute('aria-current', 'page');
    });
  });

  it('names who wrote each message when a parent is signed in', async () => {
    mocks.client = { ...alex, acting_contact: { id: 9, name: 'Pat Rivera' } };
    vi.mocked(portalMessagesApi.conversations).mockResolvedValue([row(DANA, { id: 3, last_message_at: '2026-09-25T13:30:00Z' })]);
    vi.mocked(portalMessagesApi.messages).mockResolvedValue([
      message(1, { sender_role: 'client', sender_name: null, body: 'Can we move Tuesday?', created_at: '2026-09-25T13:00:00Z' }),
      message(2, { sender_role: 'client', sender_name: 'Pat Rivera (for Alex)', sent_by_me: true, body: 'He has a game at 4.', created_at: '2026-09-25T13:10:00Z' }),
      message(3, { sender_name: 'Sam Ortiz, PhD', body: 'Dana is out; 5pm works.', created_at: '2026-09-25T13:20:00Z' }),
      message(4, { body: 'Confirmed for 5pm.', created_at: '2026-09-25T13:30:00Z' }),
    ]);
    renderPage();

    expect(await screen.findByText('He has a game at 4.')).toBeInTheDocument();
    expect(screen.getByText('Alex')).toBeInTheDocument();
    expect(screen.getByText('Sam Ortiz, PhD')).toBeInTheDocument();
    expect(screen.queryByText('Pat Rivera (for Alex)')).not.toBeInTheDocument();
    // Only the parent's own message offers removal.
    expect(screen.getAllByRole('button', { name: 'Message options' })).toHaveLength(1);
  });

  it('explains when messaging is turned off', async () => {
    vi.mocked(portalMessagesApi.conversations).mockRejectedValue(
      new ApiError(403, "Secure messaging isn't available in your portal"),
    );
    renderPage();

    expect(await screen.findByText('Messaging isn’t available')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
  });

  it('explains when there is no one to message yet', async () => {
    vi.mocked(portalMessagesApi.conversations).mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText('No one to message yet')).toBeInTheDocument();
  });
});
