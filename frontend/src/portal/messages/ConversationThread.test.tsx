import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Session } from '../../api/auth';
import { ApiError } from '../../api/client';
import type { ClientDetail } from '../../api/clients';
import { clientsApi } from '../../api/clients';
import { messagesApi, type Conversation, type StaffMessage } from '../../api/messages';
import { practiceApi, type PracticeSettings } from '../../api/practice';
import { WithSession, testSession } from '../../test/session';
import { ToastProvider } from '../../ui/Toast';
import { ConversationThread } from './ConversationThread';

vi.mock('../../api/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/messages')>();
  return {
    ...actual,
    messagesApi: {
      conversations: vi.fn(),
      openWithClient: vi.fn(),
      messages: vi.fn(),
      uploadAttachment: vi.fn(),
      discardAttachment: vi.fn(),
      send: vi.fn(),
      markRead: vi.fn(),
      remove: vi.fn(),
    },
  };
});
vi.mock('../../api/clients', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/clients')>();
  return { ...actual, clientsApi: { ...actual.clientsApi, get: vi.fn() } };
});
vi.mock('../../api/practice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/practice')>();
  return { ...actual, practiceApi: { ...actual.practiceApi, settings: vi.fn() } };
});

const CLIENT_ID = 7;
const CONVERSATION_ID = 3;
const DANA = { id: 1, name: 'Dana Lee, LCSW' };

const clientRecord = {
  id: CLIENT_ID,
  first_name: 'Alex',
  last_name: 'Rivera',
  preferred_name: '',
  status: 'active',
  portal_enabled: true,
  portal_messaging: true,
  portal_last_login_at: '2026-09-24T15:00:00Z',
} as ClientDetail;

const conversation: Conversation = {
  id: CONVERSATION_ID,
  client: { id: CLIENT_ID, first_name: 'Alex', last_name: 'Rivera', preferred_name: '' },
  clinician: DANA,
  last_message_at: '2026-09-25T13:01:00Z',
  unread_count: 2,
  last_message_preview: 'Here is my worksheet',
  has_urgent: true,
};

function message(id: number, changes: Partial<StaffMessage>): StaffMessage {
  return {
    id,
    conversation_id: CONVERSATION_ID,
    sender_role: 'client',
    sender_name: null,
    sender_staff_id: null,
    sender_contact_id: null,
    body: '',
    removed: false,
    is_automatic: false,
    attachments: [],
    created_at: '2026-09-25T13:00:00Z',
    read_by_recipient: false,
    risk_level: 'none',
    ...changes,
  };
}

const byDana = { sender_role: 'staff', sender_name: DANA.name, sender_staff_id: DANA.id } as const;

const thread: StaffMessage[] = [
  message(1, { ...byDana, body: 'How was the week?', created_at: '2026-09-24T14:00:00Z', read_by_recipient: true }),
  message(2, { body: 'Honestly rough. I feel like I want to die.', created_at: '2026-09-25T13:00:00Z', risk_level: 'high' }),
  message(3, {
    body: 'Here is my worksheet',
    created_at: '2026-09-25T13:01:00Z',
    attachments: [{ id: 40, filename: 'worksheet.pdf', content_type: 'application/pdf', size_bytes: 2048 }],
  }),
];

function renderThread(session: Session = testSession()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WithSession session={session}>
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <ToastProvider>
            <ConversationThread conversation={conversation} onBack={() => undefined} />
          </ToastProvider>
        </MemoryRouter>
      </WithSession>
    </QueryClientProvider>,
  );
}

describe('ConversationThread', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-25T16:00:00Z'));
    vi.mocked(clientsApi.get).mockResolvedValue(clientRecord);
    vi.mocked(practiceApi.settings).mockResolvedValue({ messaging_enabled: true } as PracticeSettings);
    vi.mocked(messagesApi.messages).mockResolvedValue(thread);
    vi.mocked(messagesApi.markRead).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('shows the conversation with day separators, receipts, attachments and crisis flags', async () => {
    renderThread();

    expect(await screen.findByText('Honestly rough. I feel like I want to die.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Alex Rivera' })).toHaveAttribute('href', `/portal/clients/${CLIENT_ID}`);
    expect(screen.getByText('Yesterday')).toBeInTheDocument();
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('Flagged for possible crisis language')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download worksheet.pdf, 2 KB' })).toBeInTheDocument();
    expect(screen.queryByText(/Conversation with/)).not.toBeInTheDocument();
    expect(messagesApi.messages).toHaveBeenCalledWith(CONVERSATION_ID, { before_id: undefined, limit: 50 });
    await waitFor(() => expect(messagesApi.markRead).toHaveBeenCalledWith(CONVERSATION_ID));
  });

  it('sends with Enter, keeps Shift+Enter as a new line, and shows the sent message', async () => {
    const user = userEvent.setup();
    vi.mocked(messagesApi.send).mockResolvedValue(
      message(4, { ...byDana, body: 'Thank you for telling me.\nCan we talk today?', created_at: '2026-09-25T15:59:00Z' }),
    );
    renderThread();

    const input = await screen.findByRole('textbox', { name: 'Message' });
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();

    await user.type(input, 'Thank you for telling me.{Shift>}{Enter}{/Shift}Can we talk today?');
    expect(messagesApi.send).not.toHaveBeenCalled();
    expect(send).toBeEnabled();
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(messagesApi.send).toHaveBeenCalledWith(CONVERSATION_ID, {
        body: 'Thank you for telling me.\nCan we talk today?',
        attachment_ids: [],
      }),
    );
    await waitFor(() => expect(input).toHaveValue(''));
    const messages = screen.getByRole('list', { name: 'Messages' });
    expect(within(messages).getByText(/Can we talk today\?/)).toBeInTheDocument();
    expect(screen.getByText('Sent')).toBeInTheDocument();
  });

  it("explains a refused send and links to the client's chart", async () => {
    const user = userEvent.setup();
    vi.mocked(messagesApi.send).mockRejectedValue(new ApiError(409, 'Secure messaging is turned off for this client'));
    renderThread();

    const input = await screen.findByRole('textbox', { name: 'Message' });
    await user.type(input, 'Checking in{Enter}');

    expect(await screen.findByText(/Secure messaging is turned off for this client\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review portal access in Alex’s chart' })).toHaveAttribute(
      'href',
      `/portal/clients/${CLIENT_ID}`,
    );
    expect(input).toHaveValue('Checking in');
  });

  it('disables the composer when the client has no portal access', async () => {
    vi.mocked(clientsApi.get).mockResolvedValue({ ...clientRecord, portal_enabled: false });
    renderThread();

    expect(await screen.findByText('Alex can’t receive secure messages')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
  });

  it('removes your own message after confirmation', async () => {
    const user = userEvent.setup();
    vi.mocked(messagesApi.remove).mockResolvedValue({ ...thread[0], body: '', removed: true });
    renderThread();

    await screen.findByText('How was the week?');
    await user.click(screen.getByRole('button', { name: 'Message options' }));
    await user.click(screen.getByRole('menuitem', { name: 'Remove message' }));
    await user.click(await screen.findByRole('button', { name: 'Remove message' }));

    await waitFor(() => expect(messagesApi.remove).toHaveBeenCalledWith(1));
    expect(await screen.findByText('Message removed')).toBeInTheDocument();
    expect(screen.queryByText('How was the week?')).not.toBeInTheDocument();
  });

  it("names everyone in a supervisee's conversation and leaves it unread for its clinician", async () => {
    const user = userEvent.setup();
    const supervisor = testSession({
      staff: { id: 2, first_name: 'Sam', last_name: 'Ortiz', display_name: 'Sam Ortiz, PhD', role: 'clinician' },
      capabilities: [],
    });
    vi.mocked(messagesApi.messages).mockResolvedValue([
      ...thread,
      message(5, { sender_name: 'Pat Rivera (for Alex)', sender_contact_id: 9, body: 'Alex is at school today.', created_at: '2026-09-25T13:10:00Z' }),
      message(6, { sender_role: 'staff', sender_name: 'Sam Ortiz, PhD', sender_staff_id: 2, body: 'Thanks, Pat.', created_at: '2026-09-25T13:20:00Z' }),
    ]);
    renderThread(supervisor);

    expect(await screen.findByText('Alex is at school today.')).toBeInTheDocument();
    expect(screen.getByText('Conversation with Dana Lee, LCSW')).toBeInTheDocument();
    expect(screen.getByText('Dana Lee, LCSW')).toBeInTheDocument();
    expect(screen.getByText('Pat Rivera (for Alex)')).toBeInTheDocument();
    expect(screen.getByText(/You’re replying in Dana Lee, LCSW’s conversation/)).toBeInTheDocument();
    // Only the supervisor's own message can be removed.
    expect(screen.getAllByRole('button', { name: 'Message options' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Message options' }));
    expect(screen.getByRole('menuitem', { name: 'Remove message' })).toBeInTheDocument();
    expect(messagesApi.markRead).not.toHaveBeenCalled();
  });
});
