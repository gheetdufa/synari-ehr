import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { ArrowLeft, MessageSquare } from 'lucide-react';
import { ApiError } from '../../api/client';
import { clientKeys, clientsApi, type ClientDetail } from '../../api/clients';
import {
  MESSAGE_PAGE_SIZE,
  messageKeys,
  messagesApi,
  type Conversation,
  type SendMessageInput,
  type StaffMessage,
} from '../../api/messages';
import { practiceApi, practiceKeys } from '../../api/practice';
import { useSession } from '../../auth/StaffAuth';
import { displayFirstName, fullName, initials } from '../../lib/format';
import { notificationKeys } from '../../shared/NotificationBell';
import { useMarkReadWhenVisible, useNow } from '../../shared/messages/hooks';
import { MessageComposer } from '../../shared/messages/MessageComposer';
import { MessageThread } from '../../shared/messages/MessageThread';
import { RemoveMessageDialog } from '../../shared/messages/RemoveMessageDialog';
import {
  mergePages,
  newestUnreadIncomingId,
  nextBeforeId,
  relativeTime,
  staffViewSender,
  upsertIntoPages,
  type ThreadMessage,
} from '../../shared/messages/threadModel';
import { Alert, Avatar, Badge, EmptyState, ErrorState } from '../../ui/Display';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import { unreadMessagesKey } from '../PortalLayout';
import { blockerFromReason, messagingBlocker, type MessagingBlocker } from './messagingBlocker';

type ThreadData = InfiniteData<StaffMessage[], number | undefined>;

const linkClasses = 'font-medium underline underline-offset-2 hover:no-underline';

/** Where to fix what stops a client from receiving messages: practice settings or their chart. */
export function BlockerFixLink({ blocker, clientId, name }: { blocker: MessagingBlocker; clientId: number; name: string | null }) {
  if (blocker.fixIn === 'settings') {
    return (
      <Link to="/portal/settings" className={linkClasses}>
        Turn on secure messaging in Settings
      </Link>
    );
  }
  return (
    <Link to={`/portal/clients/${clientId}`} className={linkClasses}>
      {name ? `Review portal access in ${name}’s chart` : 'Review portal access in the client’s chart'}
    </Link>
  );
}

function PortalStatus({ client, blocker, timeZone }: { client: ClientDetail; blocker: MessagingBlocker | null; timeZone: string }) {
  const now = useNow();
  if (blocker) return <Badge tone="warning">Can’t receive messages</Badge>;
  if (!client.portal_last_login_at) {
    return <p className="truncate text-xs text-sage-500">Hasn’t signed in to the client portal yet</p>;
  }
  return (
    <p className="truncate text-xs text-sage-500">
      Client portal · last signed in {relativeTime(client.portal_last_login_at, timeZone, now)}
    </p>
  );
}

/**
 * One conversation between a client and a clinician: header, paged thread, composer and message
 * removal. Anyone who can read it may reply under their own name; only the conversation's
 * clinician reading it counts as read.
 */
export function ConversationThread({ conversation, onBack }: { conversation: Conversation; onBack: () => void }) {
  const { staff } = useSession();
  const timeZone = staff.time_zone;
  const queryClient = useQueryClient();
  const toast = useToast();
  const [removing, setRemoving] = useState<ThreadMessage | null>(null);
  const conversationId = conversation.id;
  const clientId = conversation.client.id;
  const clinician = conversation.clinician;
  const isOwn = clinician.id === staff.id;

  const client = useQuery({ queryKey: clientKeys.detail(clientId), queryFn: () => clientsApi.get(clientId) });
  const practice = useQuery({ queryKey: practiceKeys.settings, queryFn: practiceApi.settings });
  const thread = useInfiniteQuery({
    queryKey: messageKeys.thread(conversationId),
    queryFn: ({ pageParam }) => messagesApi.messages(conversationId, { before_id: pageParam, limit: MESSAGE_PAGE_SIZE }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (page) => nextBeforeId(page, MESSAGE_PAGE_SIZE),
  });
  const messages = useMemo(() => mergePages(thread.data?.pages ?? []), [thread.data]);

  const person = client.data ?? conversation.client;
  const name = displayFirstName(person);
  const blocker = client.data ? messagingBlocker(client.data, practice.data) : null;
  const describeSender = useMemo(
    () => staffViewSender({ staffId: staff.id, conversationClinicianId: clinician.id, clientName: name }),
    [staff.id, clinician.id, name],
  );

  const storeMessage = (message: StaffMessage) => {
    queryClient.setQueryData<ThreadData>(messageKeys.thread(conversationId), (data) =>
      data ? { ...data, pages: upsertIntoPages(data.pages, message) } : data,
    );
    void queryClient.invalidateQueries({ queryKey: messageKeys.conversations() });
  };

  const markRead = useMutation({
    mutationFn: () => messagesApi.markRead(conversationId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: unreadMessagesKey });
      void queryClient.invalidateQueries({ queryKey: messageKeys.conversations() });
      void queryClient.invalidateQueries({ queryKey: notificationKeys.unread('staff') });
      void queryClient.invalidateQueries({ queryKey: notificationKeys.list('staff') });
    },
  });
  // Only the conversation's clinician reading it counts, so nobody else marks it read.
  useMarkReadWhenVisible(isOwn ? newestUnreadIncomingId(messages, 'staff') : null, markRead.mutateAsync);

  const send = useMutation({
    mutationFn: (input: SendMessageInput) => messagesApi.send(conversationId, input),
    onSuccess: storeMessage,
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: clientKeys.detail(clientId) });
        void queryClient.invalidateQueries({ queryKey: practiceKeys.settings });
      }
    },
  });

  const remove = useMutation({
    mutationFn: (messageId: number) => messagesApi.remove(messageId),
    onSuccess: (message) => {
      storeMessage(message);
      setRemoving(null);
    },
    onError: (error) => toast.error(error),
  });

  const renderSendError = (error: unknown) => {
    const message = error instanceof Error ? error.message : 'Your message could not be sent.';
    const refusal = error instanceof ApiError && error.status === 409 ? blockerFromReason(message) : null;
    if (refusal) {
      // Once the refreshed client record shows the same problem, the notice above the composer explains it.
      if (blocker) return null;
      return (
        <Alert tone="warning" title="Your message wasn’t sent">
          {message}. <BlockerFixLink blocker={refusal} clientId={clientId} name={name} />
        </Alert>
      );
    }
    return (
      <Alert tone="danger" title="Your message wasn’t sent">
        {message}
      </Alert>
    );
  };

  const threadMissing = thread.error instanceof ApiError && thread.error.status === 404;

  return (
    <>
      <header className="flex items-center gap-3 border-b border-sage-100 px-3 py-3 sm:px-4">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to conversations"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sage-600 hover:bg-sage-100 hover:text-sage-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 md:hidden"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <Avatar label={initials(person)} className="h-10 w-10 text-sm" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold text-sage-900">
            <Link
              to={`/portal/clients/${clientId}`}
              className="rounded hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
            >
              {fullName(person)}
            </Link>
          </h2>
          {!isOwn && <p className="truncate text-xs font-medium text-sage-700">Conversation with {clinician.name}</p>}
          {client.data && <PortalStatus client={client.data} blocker={blocker} timeZone={timeZone} />}
        </div>
      </header>

      {threadMissing ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState title="Conversation not found" description="You may no longer have access to it, or the link is out of date." />
        </div>
      ) : thread.isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <SectionSpinner />
        </div>
      ) : thread.error ? (
        <div className="flex flex-1 items-center justify-center">
          <ErrorState error={thread.error} onRetry={() => void thread.refetch()} />
        </div>
      ) : (
        <>
          <MessageThread
            messages={messages}
            viewerSide="staff"
            describeSender={describeSender}
            otherName={name}
            timeZone={timeZone}
            realm="staff"
            hasOlder={thread.hasNextPage}
            loadingOlder={thread.isFetchingNextPage}
            onLoadOlder={() => void thread.fetchNextPage()}
            onRemove={setRemoving}
            empty={
              <EmptyState
                icon={<MessageSquare />}
                title={blocker || !isOwn ? `No messages with ${name} yet` : `Start a conversation with ${name}`}
                description={
                  blocker
                    ? undefined
                    : 'Messages appear in their client portal. They’ll get an email saying a new message is waiting; the email never includes what you wrote.'
                }
              />
            }
          />
          {blocker && (
            <div className="border-t border-sage-100 px-3 pt-3 sm:px-4">
              <Alert tone="warning" title={`${name} can’t receive secure messages`}>
                {blocker.reason}. <BlockerFixLink blocker={blocker} clientId={clientId} name={name} />
              </Alert>
            </div>
          )}
          <MessageComposer
            placeholder={`Message ${name}`}
            disabled={blocker !== null}
            onSend={send.mutateAsync}
            upload={(file, options) => messagesApi.uploadAttachment(conversationId, file, options)}
            discard={messagesApi.discardAttachment}
            renderError={renderSendError}
            footer={
              isOwn ? undefined : (
                <p className="mt-2 text-xs text-sage-500">
                  You’re replying in {clinician.name}’s conversation. {name} will see your name on your messages.
                </p>
              )
            }
          />
        </>
      )}

      <RemoveMessageDialog
        open={removing !== null}
        loading={remove.isPending}
        otherName={name}
        onConfirm={() => removing && remove.mutate(removing.id)}
        onCancel={() => setRemoving(null)}
      />
    </>
  );
}
