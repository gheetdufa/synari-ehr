import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MessagesSquare } from 'lucide-react';
import { ApiError } from '../../api/client';
import { messageKeys, messagesApi, type Conversation } from '../../api/messages';
import { teamApi, teamKeys } from '../../api/team';
import { useSession } from '../../auth/StaffAuth';
import { usePagedQuery } from '../../lib/paging';
import { useRealtimeEvent } from '../../lib/realtime';
import { parseIdParam } from '../../shared/messages/links';
import { Button } from '../../ui/Button';
import { EmptyState, ErrorState } from '../../ui/Display';
import { SectionSpinner } from '../../ui/Spinner';
import { useDebouncedValue } from '../clients/useDebouncedValue';
import { useUnreadMessages } from '../PortalLayout';
import { clinicianFilterOptions, defaultClinicianFilter, readableClinicians, type ClinicianFilter } from './clinicianFilter';
import { ConversationList } from './ConversationList';
import { ConversationThread } from './ConversationThread';
import { NewMessageDialog } from './NewMessageDialog';
import { OpenClientConversation } from './OpenClientConversation';

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center">{children}</div>;
}

const SEARCH_DELAY_MS = 300;

function inboxParams(filter: ClinicianFilter, search: string): { clinician_id?: number; q?: string } {
  return { ...(filter === 'all' ? {} : { clinician_id: filter }), ...(search ? { q: search } : {}) };
}

/**
 * The conversation a `?conversation=` link names: its row when it's on a loaded page of the inbox
 * (`loaded`, undefined until the first page arrives), else fetched on its own. `missing` means it
 * doesn't exist or is out of the viewer's reach.
 */
function useLinkedConversation(conversationId: number | null, loaded: Conversation[] | undefined) {
  const inLoaded = loaded?.find((conversation) => conversation.id === conversationId);
  const fetched = useQuery({
    queryKey: messageKeys.conversation(conversationId ?? 0),
    queryFn: () => messagesApi.conversation(conversationId!),
    enabled: conversationId !== null && loaded !== undefined && inLoaded === undefined,
  });
  const missing = fetched.error instanceof ApiError && fetched.error.status === 404;
  return {
    conversation: inLoaded ?? fetched.data,
    loading: loaded === undefined || fetched.isLoading,
    missing,
    error: fetched.isError && !missing ? fetched.error : null,
    retry: () => void fetched.refetch(),
  };
}

/**
 * Secure messaging inbox. Conversations on the left and the open one (?conversation=ID) on the
 * right; on phones only one of the two shows at a time. ?client=ID opens your own conversation
 * with that client, creating it if needed.
 */
export default function MessagesPage() {
  const session = useSession();
  const { staff } = session;
  const [params, setParams] = useSearchParams();
  const conversationId = parseIdParam(params.get('conversation'));
  const clientId = conversationId === null ? parseIdParam(params.get('client')) : null;
  const [filter, setFilter] = useState<ClinicianFilter>(() => defaultClinicianFilter(session));
  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState('');
  const searchedFor = useDebouncedValue(search.trim(), SEARCH_DELAY_MS);
  const queryClient = useQueryClient();

  const inbox = inboxParams(filter, searchedFor);
  const conversations = usePagedQuery({
    queryKey: messageKeys.inbox(inbox),
    fetchPage: (page) => messagesApi.conversations({ ...inbox, ...page }),
    keepPreviousPages: true,
  });
  const team = useQuery({ queryKey: teamKeys.members, queryFn: teamApi.list, staleTime: 5 * 60_000 });
  const ownUnread = useUnreadMessages(staff.is_clinician);

  useRealtimeEvent(['message.created', 'message.removed', 'conversation.read'], (event) => {
    void queryClient.invalidateQueries({ queryKey: messageKeys.conversations() });
    const eventConversationId = Number(event.data.conversation_id);
    if (Number.isSafeInteger(eventConversationId)) {
      void queryClient.invalidateQueries({ queryKey: messageKeys.thread(eventConversationId) });
    }
  });

  const filterOptions = useMemo(
    () => clinicianFilterOptions(session, readableClinicians(session, team.data ?? [])),
    [session, team.data],
  );
  const linked = useLinkedConversation(conversationId, conversations.isPending ? undefined : conversations.items);
  const selected = linked.conversation;
  const threadOpen = conversationId !== null || clientId !== null;

  const close = () => setParams({});
  // A conversation opened from a client's chart may not be on a loaded page, so it's cached as is.
  const openConversation = useCallback(
    (conversation: Conversation) => {
      queryClient.setQueryData(messageKeys.conversation(conversation.id), conversation);
      setParams({ conversation: String(conversation.id) }, { replace: true });
    },
    [queryClient, setParams],
  );

  let thread: ReactNode;
  if (conversationId !== null) {
    if (selected) {
      thread = <ConversationThread key={selected.id} conversation={selected} onBack={close} />;
    } else if (linked.loading) {
      thread = (
        <Centered>
          <SectionSpinner />
        </Centered>
      );
    } else if (linked.error) {
      thread = (
        <Centered>
          <ErrorState error={linked.error} onRetry={linked.retry} />
        </Centered>
      );
    } else {
      thread = (
        <Centered>
          <EmptyState
            title="Conversation not found"
            description="You may no longer have access to it, or the link is out of date."
            action={
              <Button variant="secondary" size="sm" onClick={close}>
                Back to conversations
              </Button>
            }
          />
        </Centered>
      );
    }
  } else if (clientId !== null) {
    thread = (
      <OpenClientConversation key={clientId} clientId={clientId} onOpen={openConversation} onBack={close} />
    );
  } else {
    thread = (
      <Centered>
        <EmptyState
          icon={<MessagesSquare />}
          title="Select a conversation"
          description="Choose a conversation on the left, or start a new secure message."
          action={
            <Button variant="secondary" size="sm" onClick={() => setPicking(true)}>
              New message
            </Button>
          }
        />
      </Centered>
    );
  }

  return (
    <div className="-mx-4 -my-6 flex h-[calc(100dvh-4rem)] min-h-[28rem] overflow-hidden bg-white sm:mx-0 sm:my-0 sm:h-[calc(100dvh-7rem)] sm:rounded-xl sm:border sm:border-sage-100 sm:shadow-sm lg:h-[calc(100dvh-8rem)]">
      <section
        aria-label="Conversations"
        className={`${threadOpen ? 'hidden md:flex' : 'flex'} w-full shrink-0 flex-col border-sage-100 md:w-80 md:border-r lg:w-96`}
      >
        <ConversationList
          conversations={conversations.data ? conversations.items : undefined}
          filtered={filterOptions.length > 0 && filter !== 'all'}
          search={search}
          searchedFor={searchedFor}
          onSearchChange={setSearch}
          isLoading={conversations.isLoading}
          error={conversations.isError && !conversations.data ? conversations.error : null}
          onRetry={() => void conversations.refetch()}
          loadMore={conversations.loadMore}
          staffId={staff.id}
          ownUnread={ownUnread}
          selectedConversationId={conversationId}
          timeZone={staff.time_zone}
          filterOptions={filterOptions}
          filter={filter}
          onFilterChange={setFilter}
          onNewMessage={() => setPicking(true)}
        />
      </section>
      <section
        aria-label="Conversation"
        className={`${threadOpen ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col bg-sage-50/40`}
      >
        {thread}
      </section>
      <NewMessageDialog
        open={picking}
        onClose={() => setPicking(false)}
        onSelect={(pickedClientId) => {
          setPicking(false);
          setParams({ client: String(pickedClientId) });
        }}
      />
    </div>
  );
}
