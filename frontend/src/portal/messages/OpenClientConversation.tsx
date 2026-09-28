import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, MessageSquareOff } from 'lucide-react';
import { ApiError, MAX_PAGE_SIZE } from '../../api/client';
import { messageKeys, messagesApi, type Conversation } from '../../api/messages';
import { useSession } from '../../auth/StaffAuth';
import { displayFirstName } from '../../lib/format';
import { staffConversationPath } from '../../shared/messages/links';
import { EmptyState, ErrorState } from '../../ui/Display';
import { SectionSpinner } from '../../ui/Spinner';
import { BlockerFixLink } from './ConversationThread';
import { blockerFromReason } from './messagingBlocker';

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center">{children}</div>;
}

/** Other people's conversations with the client that the viewer can still read. */
function ReadableConversations({ conversations }: { conversations: Conversation[] }) {
  if (conversations.length === 0) return null;
  return (
    <ul className="space-y-1 text-sm">
      {conversations.map((conversation) => (
        <li key={conversation.id}>
          <Link to={staffConversationPath(conversation.id)} className="font-medium text-primary-700 hover:underline">
            Open {displayFirstName(conversation.client)}’s conversation with {conversation.clinician.name}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Resolves `?client=ID` (the "Message" buttons elsewhere in the app) to your own conversation
 * with that client, opening or creating it, then shows it as `?conversation=ID`. Explains when
 * you can't message the client and links any of their conversations you can still read.
 */
export function OpenClientConversation({
  clientId,
  onOpen,
  onBack,
}: {
  clientId: number;
  onOpen: (conversation: Conversation) => void;
  onBack: () => void;
}) {
  const { staff } = useSession();
  const queryClient = useQueryClient();
  // Every conversation with this client the viewer can read (a handful at most).
  const withClient = useQuery({
    queryKey: messageKeys.withClient(clientId),
    queryFn: () => messagesApi.conversations({ client_id: clientId, limit: MAX_PAGE_SIZE }),
    select: (page) => page.items,
  });
  const conversations = withClient.data;
  const existing = conversations?.find((conversation) => conversation.clinician.id === staff.id);
  const open = useMutation({
    mutationFn: () => messagesApi.openWithClient(clientId),
    onSuccess: (opened) => {
      void queryClient.invalidateQueries({ queryKey: messageKeys.conversations() });
      onOpen(opened);
    },
  });
  const { mutate, status } = open;
  const loaded = conversations !== undefined;

  useEffect(() => {
    if (!loaded) return;
    if (existing !== undefined) onOpen(existing);
    else if (status === 'idle') mutate();
  }, [loaded, existing, status, mutate, onOpen]);

  const back = (
    <div className="border-b border-sage-100 px-3 py-3 md:hidden">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-sage-700 hover:bg-sage-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Conversations
      </button>
    </div>
  );

  if (withClient.isError) {
    return (
      <>
        {back}
        <Centered>
          <ErrorState error={withClient.error} onRetry={() => void withClient.refetch()} />
        </Centered>
      </>
    );
  }
  const error = open.error;
  if (!error) {
    return (
      <Centered>
        <SectionSpinner />
      </Centered>
    );
  }
  if (!(error instanceof ApiError) || ![403, 404, 409].includes(error.status)) {
    return (
      <>
        {back}
        <Centered>
          <ErrorState error={error} onRetry={() => mutate()} />
        </Centered>
      </>
    );
  }
  if (error.status === 404) {
    return (
      <>
        {back}
        <Centered>
          <EmptyState title="Client not found" description="This client may have been removed, or the link is out of date." />
        </Centered>
      </>
    );
  }
  const others = conversations ?? [];
  const name = others.length > 0 ? displayFirstName(others[0].client) : null;
  const blocker = error.status === 409 ? blockerFromReason(error.message) : null;
  return (
    <>
      {back}
      <Centered>
        <EmptyState
          icon={<MessageSquareOff />}
          title={name ? `You can’t message ${name}` : 'You can’t message this client'}
          description={
            <>
              {error.message}.{' '}
              {blocker && <BlockerFixLink blocker={blocker} clientId={clientId} name={name} />}
            </>
          }
          action={<ReadableConversations conversations={others} />}
        />
      </Centered>
    </>
  );
}
