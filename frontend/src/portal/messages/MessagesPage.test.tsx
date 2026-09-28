import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { Session } from '../../api/auth';
import { ApiError } from '../../api/client';
import { clientsApi, type ClientDetail } from '../../api/clients';
import { messagesApi, type Conversation, type ConversationListParams } from '../../api/messages';
import { practiceApi, type PracticeSettings } from '../../api/practice';
import { teamApi } from '../../api/team';
import { page } from '../../test/page';
import { WithSession, testSession } from '../../test/session';
import { teamMember } from '../../test/team';
import { ToastProvider } from '../../ui/Toast';
import MessagesPage from './MessagesPage';

vi.mock('../../api/messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/messages')>();
  return {
    ...actual,
    messagesApi: {
      conversations: vi.fn(),
      conversation: vi.fn(),
      unreadCount: vi.fn(),
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
vi.mock('../../api/team', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/team')>();
  return { ...actual, teamApi: { ...actual.teamApi, list: vi.fn() } };
});
vi.mock('../../api/practice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/practice')>();
  return { ...actual, practiceApi: { ...actual.practiceApi, settings: vi.fn() } };
});

const DANA = { id: 1, name: 'Dana Lee, LCSW' };
const SAM = { id: 2, name: 'Sam Ortiz, PhD' };

function conversation(id: number, clientId: number, firstName: string, clinician: Conversation['clinician'], changes: Partial<Conversation> = {}): Conversation {
  return {
    id,
    client: { id: clientId, first_name: firstName, last_name: 'Rivera', preferred_name: '' },
    clinician,
    last_message_at: '2026-09-25T13:00:00Z',
    unread_count: 0,
    last_message_preview: `Hello from ${firstName}`,
    has_urgent: false,
    ...changes,
  };
}

const alexWithDana = conversation(11, 7, 'Alex', DANA, { unread_count: 2, has_urgent: true });
const blairWithSam = conversation(12, 9, 'Blair', SAM, { unread_count: 3 });
const caseyWithSam = conversation(13, 10, 'Casey', SAM);
const inbox = [alexWithDana, blairWithSam, caseyWithSam];

/** The API's inbox over these conversations: filtered by clinician or client like the server. */
function serveInbox(rows: Conversation[]) {
  vi.mocked(messagesApi.conversations).mockImplementation((params: ConversationListParams = {}) =>
    Promise.resolve(
      page(
        rows.filter(
          (row) =>
            (params.clinician_id === undefined || row.clinician.id === params.clinician_id) &&
            (params.client_id === undefined || row.client.id === params.client_id),
        ),
      ),
    ),
  );
}

const ownerClinician = testSession();
const nonClinicalOwner = testSession({ staff: { id: 5, is_clinician: false } });
const basicClinician = testSession({ staff: { role: 'clinician' }, capabilities: [] });

function Location() {
  const location = useLocation();
  return <output aria-label="Location">{location.pathname + location.search}</output>;
}

function renderPage(path: string, session: Session = ownerClinician) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <WithSession session={session}>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <Routes>
              <Route
                path="/portal/messaging"
                element={
                  <>
                    <MessagesPage />
                    <Location />
                  </>
                }
              />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </WithSession>
    </QueryClientProvider>,
  );
}

const conversationList = () => screen.findByRole('list', { name: 'Conversations' });
const rowNames = (list: HTMLElement) => within(list).getAllByRole('link').map((link) => link.textContent ?? '');

describe('MessagesPage', () => {
  beforeEach(() => {
    serveInbox(inbox);
    vi.mocked(messagesApi.conversation).mockImplementation((id) => {
      const row = inbox.find((candidate) => candidate.id === id);
      return row ? Promise.resolve(row) : Promise.reject(new ApiError(404, 'Conversation not found'));
    });
    vi.mocked(messagesApi.unreadCount).mockResolvedValue({ count: 0 });
    vi.mocked(teamApi.list).mockResolvedValue([
      teamMember(DANA.id, { display_name: DANA.name }),
      teamMember(SAM.id, { display_name: SAM.name }),
    ]);
    vi.mocked(messagesApi.messages).mockResolvedValue([]);
    vi.mocked(messagesApi.markRead).mockResolvedValue(undefined);
    vi.mocked(clientsApi.get).mockImplementation((id) =>
      Promise.resolve({
        id,
        first_name: 'Client',
        last_name: 'Rivera',
        preferred_name: '',
        status: 'active',
        portal_enabled: true,
        portal_messaging: true,
        portal_last_login_at: null,
      } as ClientDetail),
    );
    vi.mocked(practiceApi.settings).mockResolvedValue({ messaging_enabled: true } as PracticeSettings);
  });

  afterEach(() => vi.clearAllMocks());

  describe('clinician filter', () => {
    it('starts a clinician-owner on their own conversations and lets them see everyone’s', async () => {
      const user = userEvent.setup();
      vi.mocked(messagesApi.unreadCount).mockResolvedValue({ count: 2 });
      renderPage('/portal/messaging');

      const list = await conversationList();
      expect(rowNames(list)).toEqual([expect.stringContaining('Alex Rivera')]);
      expect(within(list).getByText('Urgent')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Messages 2 unread' })).toBeInTheDocument();

      const filter = screen.getByRole('combobox', { name: 'Show conversations for' });
      expect(within(filter).getAllByRole('option').map((option) => option.textContent)).toEqual([
        'My conversations',
        'All conversations',
        'Sam Ortiz, PhD',
      ]);
      expect(messagesApi.conversations).toHaveBeenCalledWith({ clinician_id: DANA.id, limit: 50, offset: 0 });
      await user.selectOptions(filter, 'All conversations');
      await waitFor(() => expect(rowNames(list)).toHaveLength(3));
      expect(within(list).getAllByText('with Sam Ortiz, PhD')).toHaveLength(2);

      await user.selectOptions(filter, 'Sam Ortiz, PhD');
      await waitFor(() =>
        expect(rowNames(list)).toEqual([expect.stringContaining('Blair Rivera'), expect.stringContaining('Casey Rivera')]),
      );
      // Sam's unread messages are his to read, so they don't count as the owner's.
      expect(screen.getByRole('heading', { name: 'Messages 2 unread' })).toBeInTheDocument();
    });

    it('shows everyone’s conversations to an owner who doesn’t see clients', async () => {
      renderPage('/portal/messaging', nonClinicalOwner);

      const list = await conversationList();
      expect(rowNames(list)).toHaveLength(3);
      expect(screen.getByRole('combobox', { name: 'Show conversations for' })).toHaveValue('all');
      expect(screen.getByRole('heading', { name: 'Messages' })).toBeInTheDocument();
    });

    it('has no filter for a clinician who only sees their own conversations', async () => {
      serveInbox([alexWithDana]);
      renderPage('/portal/messaging', basicClinician);

      expect(rowNames(await conversationList())).toEqual([expect.stringContaining('Alex Rivera')]);
      expect(screen.queryByRole('combobox', { name: 'Show conversations for' })).not.toBeInTheDocument();
    });
  });

  describe('?client= links from other screens', () => {
    it('opens your existing conversation with the client without creating one', async () => {
      renderPage('/portal/messaging?client=7');

      await waitFor(() => expect(screen.getByRole('status', { name: 'Location' })).toHaveTextContent('?conversation=11'));
      expect(await screen.findByRole('heading', { name: 'Client Rivera' })).toBeInTheDocument();
      expect(messagesApi.openWithClient).not.toHaveBeenCalled();
    });

    it("creates your conversation with a colleague's client when you may message them", async () => {
      vi.mocked(messagesApi.openWithClient).mockResolvedValue(conversation(20, 9, 'Blair', DANA));
      renderPage('/portal/messaging?client=9');

      await waitFor(() => expect(messagesApi.openWithClient).toHaveBeenCalledWith(9));
      await waitFor(() => expect(screen.getByRole('status', { name: 'Location' })).toHaveTextContent('?conversation=20'));
      expect(await screen.findByRole('textbox', { name: 'Message' })).toBeInTheDocument();
      expect(messagesApi.openWithClient).toHaveBeenCalledTimes(1);
    });

    it("explains when you can't message the client and links conversations you can read", async () => {
      vi.mocked(messagesApi.openWithClient).mockRejectedValue(
        new ApiError(403, "Only a clinician on this client's care team can message them"),
      );
      renderPage('/portal/messaging?client=9', basicClinician);

      expect(await screen.findByText('You can’t message Blair')).toBeInTheDocument();
      expect(screen.getByText(/Only a clinician on this client's care team can message them\./)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Open Blair’s conversation with Sam Ortiz, PhD' })).toHaveAttribute(
        'href',
        '/portal/messaging?conversation=12',
      );
    });

    it('explains why a client without portal messaging can’t be messaged', async () => {
      vi.mocked(messagesApi.openWithClient).mockRejectedValue(
        new ApiError(409, "This client doesn't have client portal access"),
      );
      renderPage('/portal/messaging?client=30');

      expect(await screen.findByText('You can’t message this client')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Review portal access in the client’s chart' })).toHaveAttribute(
        'href',
        '/portal/clients/30',
      );
    });
  });

  it('fetches a linked conversation that isn’t on a loaded page', async () => {
    renderPage('/portal/messaging?conversation=13');

    await waitFor(() => expect(messagesApi.messages).toHaveBeenCalledWith(13, expect.anything()));
    expect(messagesApi.conversation).toHaveBeenCalledWith(13);
    expect(screen.queryByText('Conversation not found')).not.toBeInTheDocument();
  });

  it('opens a linked conversation already in the inbox without fetching it again', async () => {
    renderPage('/portal/messaging?conversation=11');

    await waitFor(() => expect(messagesApi.messages).toHaveBeenCalledWith(11, expect.anything()));
    expect(messagesApi.conversation).not.toHaveBeenCalled();
  });

  it('searches conversations on the server', async () => {
    const user = userEvent.setup();
    renderPage('/portal/messaging', nonClinicalOwner);
    await conversationList();

    await user.type(screen.getByRole('searchbox', { name: 'Search conversations' }), 'blair');
    await waitFor(() => expect(messagesApi.conversations).toHaveBeenLastCalledWith({ q: 'blair', limit: 50, offset: 0 }));

    vi.mocked(messagesApi.conversations).mockResolvedValue(page([]));
    await user.clear(screen.getByRole('searchbox', { name: 'Search conversations' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search conversations' }), 'nobody');
    expect(await screen.findByText('No conversations match “nobody”.')).toBeInTheDocument();
  });

  it('says so when a linked conversation is out of reach', async () => {
    renderPage('/portal/messaging?conversation=999');

    expect(await screen.findByText('Conversation not found')).toBeInTheDocument();
    expect(messagesApi.messages).not.toHaveBeenCalled();
  });
});
