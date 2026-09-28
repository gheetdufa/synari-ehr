import { Link } from 'react-router-dom';
import type { PortalConversation } from '../../api/messages';
import { useNow } from '../../shared/messages/hooks';
import { portalClinicianPath, portalConversationPath } from '../../shared/messages/links';
import { formatListTime } from '../../shared/messages/threadModel';
import { Avatar, Badge } from '../../ui/Display';

/** "Jordan Lee, LCSW" -> "JL": initials from a display name, ignoring credentials. */
export function nameInitials(name: string): string {
  const words = name.split(',')[0].trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? words[words.length - 1][0] : '';
  return `${first}${last}`.toUpperCase();
}

function listStatus({ last_message_at: lastMessageAt, unread_count: unread }: PortalConversation): string {
  if (!lastMessageAt) return 'Start a conversation';
  if (unread === 0) return 'No new messages';
  return unread === 1 ? '1 new message' : `${unread} new messages`;
}

/** The clinicians a client can message, each opening their conversation (or starting one). */
export function ClinicianList({
  conversations,
  selectedClinicianId,
  timeZone,
}: {
  conversations: PortalConversation[];
  selectedClinicianId: number | null;
  timeZone: string;
}) {
  const now = useNow();
  return (
    <>
      <div className="border-b border-sage-100 px-4 pb-3 pt-4">
        <h1 className="text-lg font-semibold text-sage-900">Messages</h1>
        <p className="mt-0.5 text-xs text-sage-500">Choose who you’d like to message.</p>
      </div>
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2" aria-label="Your clinicians">
        {conversations.map((conversation) => {
          const { clinician, unread_count: unread } = conversation;
          const selected = clinician.id === selectedClinicianId;
          return (
            <li key={clinician.id}>
              <Link
                to={conversation.id === null ? portalClinicianPath(clinician.id) : portalConversationPath(conversation.id)}
                aria-current={selected ? 'page' : undefined}
                className={`flex gap-3 rounded-xl px-3 py-3 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-400 ${
                  selected ? 'bg-primary-50' : 'hover:bg-sage-50'
                }`}
              >
                <Avatar label={nameInitials(clinician.name)} className="h-10 w-10 text-sm" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className={`truncate text-sm ${unread > 0 ? 'font-semibold text-sage-900' : 'font-medium text-sage-800'}`}>
                      {clinician.name}
                    </span>
                    {conversation.last_message_at && (
                      <time dateTime={conversation.last_message_at} className="shrink-0 text-xs text-sage-500">
                        {formatListTime(conversation.last_message_at, timeZone, now)}
                      </time>
                    )}
                  </span>
                  <span className="mt-1 flex items-center gap-2">
                    <span className={`min-w-0 flex-1 truncate text-sm ${unread > 0 ? 'text-sage-800' : 'text-sage-500'}`}>
                      {listStatus(conversation)}
                    </span>
                    {conversation.away_message && <Badge tone="warning">Away</Badge>}
                    {unread > 0 && (
                      <span
                        className="shrink-0 rounded-full bg-primary-600 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white"
                        aria-hidden="true"
                      >
                        {unread > 99 ? '99+' : unread}
                      </span>
                    )}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );
}
