import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, MessageSquareOff, UserRound } from 'lucide-react';
import { ApiError } from '../../api/client';
import { portalMessageKeys, portalMessagesApi } from '../../api/messages';
import { usePortalClient } from '../../auth/ClientAuth';
import { useRealtimeEvent } from '../../lib/realtime';
import { parseIdParam } from '../../shared/messages/links';
import { Button } from '../../ui/Button';
import { EmptyState, ErrorState } from '../../ui/Display';
import { SectionSpinner } from '../../ui/Spinner';
import { ClientConversation } from './ClientConversation';
import { ClinicianList } from './ClinicianList';

const shellClasses =
  'flex h-[calc(100dvh-10.5rem)] min-h-[26rem] overflow-hidden rounded-xl border border-sage-100 bg-white shadow-sm sm:h-[calc(100dvh-11.5rem)]';

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center">{children}</div>;
}

function Notice({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <div className="rounded-xl border border-sage-100 bg-white shadow-sm">
      <EmptyState icon={icon} title={title} description={description} />
    </div>
  );
}

/**
 * The client's secure conversations, one per clinician they can message. With a single
 * clinician the page is that conversation; otherwise clinicians are listed beside the open one
 * (?conversation=ID, or ?clinician=ID for one not started yet), one at a time on phones.
 */
export default function ClientMessagesPage() {
  const client = usePortalClient();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const conversationId = parseIdParam(params.get('conversation'));
  const clinicianId = conversationId === null ? parseIdParam(params.get('clinician')) : null;

  const conversations = useQuery({
    queryKey: portalMessageKeys.conversations(),
    queryFn: portalMessagesApi.conversations,
  });

  useRealtimeEvent(['message.created', 'message.removed', 'conversation.read'], (event) => {
    void queryClient.invalidateQueries({ queryKey: portalMessageKeys.conversations() });
    const eventConversationId = Number(event.data.conversation_id);
    if (Number.isSafeInteger(eventConversationId)) {
      void queryClient.invalidateQueries({ queryKey: portalMessageKeys.thread(eventConversationId) });
    }
  });

  if (conversations.error instanceof ApiError && conversations.error.status === 403) {
    return (
      <Notice
        icon={<MessageSquareOff />}
        title="Messaging isn’t available"
        description={`Secure messaging isn’t turned on for your portal right now. To reach your clinician, please contact ${client.practice_name} directly. In an emergency, call 911 or call or text 988.`}
      />
    );
  }
  if (!conversations.data) {
    return (
      <div className={shellClasses}>
        <Centered>
          {conversations.error ? (
            <ErrorState error={conversations.error} onRetry={() => void conversations.refetch()} />
          ) : (
            <SectionSpinner />
          )}
        </Centered>
      </div>
    );
  }

  const rows = conversations.data;
  if (rows.length === 0) {
    return (
      <Notice
        icon={<UserRound />}
        title="No one to message yet"
        description={`Once a clinician at ${client.practice_name} is working with you, you can message them here. In an emergency, call 911 or call or text 988.`}
      />
    );
  }

  const single = rows.length === 1;
  const selected =
    conversationId !== null
      ? rows.find((row) => row.id === conversationId)
      : clinicianId !== null
        ? rows.find((row) => row.clinician.id === clinicianId)
        : single
          ? rows[0]
          : undefined;
  const requested = conversationId !== null || clinicianId !== null;
  const backToList = () => setParams({});

  let pane: ReactNode;
  if (selected) {
    pane = (
      <ClientConversation
        key={selected.clinician.id}
        conversation={selected}
        heading={single ? 'h1' : 'h2'}
        onBack={single ? undefined : backToList}
      />
    );
  } else if (requested) {
    pane = (
      <Centered>
        <EmptyState
          title="This conversation isn’t available"
          description="It may have ended, or the link is out of date."
          action={
            <Button variant="secondary" size="sm" onClick={backToList}>
              See your conversations
            </Button>
          }
        />
      </Centered>
    );
  } else {
    pane = (
      <Centered>
        <EmptyState icon={<MessageSquare />} title="Choose a conversation" description="Pick who you’d like to message." />
      </Centered>
    );
  }

  if (single && selected) return <div className={`${shellClasses} flex-col`}>{pane}</div>;

  const paneOpen = selected !== undefined || requested;
  return (
    <div className={shellClasses}>
      <section
        aria-label="Your clinicians"
        className={`${paneOpen ? 'hidden md:flex' : 'flex'} w-full shrink-0 flex-col border-sage-100 md:w-72 md:border-r`}
      >
        <ClinicianList
          conversations={rows}
          selectedClinicianId={selected?.clinician.id ?? null}
          timeZone={client.time_zone}
        />
      </section>
      <section aria-label="Conversation" className={`${paneOpen ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
        {pane}
      </section>
    </div>
  );
}
