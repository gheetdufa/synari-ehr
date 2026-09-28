import { useMemo, useState } from 'react';
import { skipToken, useInfiniteQuery, useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { ArrowLeft, Clock, Lock, MessageSquare } from 'lucide-react';
import {
  MESSAGE_PAGE_SIZE,
  portalMessageKeys,
  portalMessagesApi,
  type PortalConversation,
  type PortalMessage,
  type SendMessageInput,
} from '../../api/messages';
import { usePortalClient } from '../../auth/ClientAuth';
import { displayFirstName } from '../../lib/format';
import { notificationKeys } from '../../shared/NotificationBell';
import { useMarkReadWhenVisible } from '../../shared/messages/hooks';
import { MessageComposer } from '../../shared/messages/MessageComposer';
import { MessageThread } from '../../shared/messages/MessageThread';
import { RemoveMessageDialog } from '../../shared/messages/RemoveMessageDialog';
import {
  mergePages,
  newestUnreadIncomingId,
  nextBeforeId,
  portalViewSender,
  upsertIntoPages,
  type ThreadMessage,
} from '../../shared/messages/threadModel';
import { Avatar, EmptyState, ErrorState } from '../../ui/Display';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import { portalUnreadMessagesKey } from '../ClientLayout';
import { nameInitials } from './ClinicianList';
import { CrisisResourcesPanel } from './CrisisResourcesPanel';

type ThreadData = InfiniteData<PortalMessage[], number | undefined>;

/**
 * The client's conversation with one clinician. A conversation that hasn't started yet is
 * created when the first message is sent; the inbox then carries its id.
 */
export function ClientConversation({
  conversation,
  heading: Heading,
  onBack,
}: {
  conversation: PortalConversation;
  /** h1 when the conversation fills the page, h2 next to the list of clinicians. */
  heading: 'h1' | 'h2';
  /** Back to the list of clinicians on phones; omitted when there's only one clinician. */
  onBack?: () => void;
}) {
  const client = usePortalClient();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [showCrisisResources, setShowCrisisResources] = useState(false);
  const [removing, setRemoving] = useState<ThreadMessage | null>(null);
  const conversationId = conversation.id;
  const clinicianName = conversation.clinician.name;
  const clientFirstName = displayFirstName(client);

  const thread = useInfiniteQuery({
    queryKey: portalMessageKeys.thread(conversationId),
    // Nothing to load until the conversation starts.
    queryFn:
      conversationId === null
        ? skipToken
        : ({ pageParam }) => portalMessagesApi.messages(conversationId, { before_id: pageParam, limit: MESSAGE_PAGE_SIZE }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (page) => nextBeforeId(page, MESSAGE_PAGE_SIZE),
  });
  const messages = useMemo(() => mergePages(thread.data?.pages ?? []), [thread.data]);
  const describeSender = useMemo(
    () => portalViewSender({ clinicianName, clientFirstName }),
    [clinicianName, clientFirstName],
  );

  const storeMessage = (message: PortalMessage) => {
    queryClient.setQueryData<ThreadData>(portalMessageKeys.thread(message.conversation_id), (data) =>
      data
        ? { ...data, pages: upsertIntoPages(data.pages, message) }
        : { pages: [[message]], pageParams: [undefined] },
    );
    void queryClient.invalidateQueries({ queryKey: portalMessageKeys.conversations() });
  };

  const markRead = useMutation({
    mutationFn: (id: number) => portalMessagesApi.markRead(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: portalUnreadMessagesKey });
      void queryClient.invalidateQueries({ queryKey: portalMessageKeys.conversations() });
      void queryClient.invalidateQueries({ queryKey: notificationKeys.unread('client') });
      void queryClient.invalidateQueries({ queryKey: notificationKeys.list('client') });
    },
  });
  useMarkReadWhenVisible(
    conversationId === null ? null : newestUnreadIncomingId(messages, 'client'),
    () => (conversationId === null ? Promise.resolve() : markRead.mutateAsync(conversationId)),
  );

  /** The conversation's id, starting it first if this is the first message. */
  const startedId = async (): Promise<number> => {
    if (conversationId !== null) return conversationId;
    const started = await portalMessagesApi.start(conversation.clinician.id);
    if (started.id === null) throw new Error('The conversation couldn’t be started. Please try again.');
    queryClient.setQueryData<PortalConversation[]>(portalMessageKeys.conversations(), (rows) =>
      rows?.map((row) => (row.clinician.id === started.clinician.id ? started : row)),
    );
    return started.id;
  };

  const send = useMutation({
    mutationFn: async (input: SendMessageInput) => portalMessagesApi.send(await startedId(), input),
    onSuccess: ({ crisis_resources: crisisResources, ...message }) => {
      storeMessage(message);
      if (crisisResources) setShowCrisisResources(true);
    },
  });

  const remove = useMutation({
    mutationFn: (messageId: number) => portalMessagesApi.remove(messageId),
    onSuccess: (message) => {
      storeMessage(message);
      setRemoving(null);
    },
    onError: (error) => toast.error(error),
  });

  return (
    <>
      <header className="flex items-center gap-3 border-b border-sage-100 px-3 py-3 sm:px-5">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to your clinicians"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sage-600 hover:bg-sage-100 hover:text-sage-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 md:hidden"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
        )}
        <Avatar label={nameInitials(clinicianName)} className="h-10 w-10 text-sm" />
        <div className="min-w-0 flex-1">
          <Heading className="truncate text-base font-semibold text-sage-900">{clinicianName}</Heading>
          <p className="flex items-center gap-1 truncate text-xs text-sage-500">
            <Lock className="h-3 w-3 shrink-0" aria-hidden="true" />
            Secure messaging · {client.practice_name}
          </p>
        </div>
      </header>
      {thread.isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <SectionSpinner />
        </div>
      ) : thread.error ? (
        <div className="flex flex-1 items-center justify-center">
          <ErrorState error={thread.error} onRetry={() => void thread.refetch()} />
        </div>
      ) : (
        <>
          {conversation.away_message && (
            <div className="flex gap-2.5 border-b border-warm-200 bg-warm-50 px-4 py-3 text-sm text-sage-800 sm:px-5" role="status">
              <Clock className="mt-0.5 h-4 w-4 shrink-0 text-warm-800" aria-hidden="true" />
              <div className="min-w-0">
                <p className="font-semibold text-sage-900">{clinicianName} is away</p>
                <p className="mt-0.5 whitespace-pre-wrap break-words">{conversation.away_message}</p>
              </div>
            </div>
          )}
          <MessageThread
            messages={messages}
            viewerSide="client"
            describeSender={describeSender}
            otherName={clinicianName}
            timeZone={client.time_zone}
            realm="client"
            hasOlder={thread.hasNextPage}
            loadingOlder={thread.isFetchingNextPage}
            onLoadOlder={() => void thread.fetchNextPage()}
            onRemove={setRemoving}
            empty={
              <EmptyState
                icon={<MessageSquare />}
                title={`Send ${clinicianName} a message`}
                description="Use secure messaging for scheduling questions and non-urgent updates."
              />
            }
          />
          {showCrisisResources && (
            <CrisisResourcesPanel clinicianName={clinicianName} onClose={() => setShowCrisisResources(false)} />
          )}
          <MessageComposer
            placeholder={`Message ${clinicianName}`}
            onSend={send.mutateAsync}
            upload={portalMessagesApi.uploadAttachment}
            discard={portalMessagesApi.discardAttachment}
            footer={
              <p className="mt-2 text-xs text-sage-500">
                Messages aren’t monitored around the clock. In an emergency call 911 or 988.
              </p>
            }
          />
        </>
      )}
      <RemoveMessageDialog
        open={removing !== null}
        loading={remove.isPending}
        otherName={clinicianName}
        onConfirm={() => removing && remove.mutate(removing.id)}
        onCancel={() => setRemoving(null)}
      />
    </>
  );
}
