import type { ComponentProps } from 'react';
import { Link } from 'react-router-dom';
import { MessageSquare, PenSquare, Search } from 'lucide-react';
import type { Conversation } from '../../api/messages';
import { displayFirstName, initials } from '../../lib/format';
import { useNow } from '../../shared/messages/hooks';
import { staffConversationPath } from '../../shared/messages/links';
import { formatListTime } from '../../shared/messages/threadModel';
import { Button } from '../../ui/Button';
import { Avatar, EmptyState, ErrorState } from '../../ui/Display';
import { Input, Select } from '../../ui/Form';
import { LoadMore } from '../../ui/LoadMore';
import type { ClinicianFilter, ClinicianFilterOption } from './clinicianFilter';

function listName(conversation: Conversation): string {
  return `${displayFirstName(conversation.client)} ${conversation.client.last_name}`;
}

function LoadingRows() {
  return (
    <ul className="space-y-1 p-2" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((row) => (
        <li key={row} className="flex animate-pulse gap-3 rounded-xl px-3 py-3">
          <span className="h-10 w-10 rounded-full bg-sage-100" />
          <span className="flex-1 space-y-2 pt-1">
            <span className="block h-3 w-1/2 rounded bg-sage-100" />
            <span className="block h-3 w-4/5 rounded bg-sage-100" />
          </span>
        </li>
      ))}
    </ul>
  );
}

function UnreadBadge({ count, own, clinicianName }: { count: number; own: boolean; clinicianName: string }) {
  return (
    <>
      <span
        className={`shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-semibold leading-none ${
          own ? 'bg-primary-600 text-white' : 'bg-sage-200 text-sage-700'
        }`}
        aria-hidden="true"
      >
        {count > 99 ? '99+' : count}
      </span>
      <span className="sr-only">{own ? `, ${count} unread` : `, ${count} unread by ${clinicianName}`}</span>
    </>
  );
}

function ConversationRow({
  conversation,
  selected,
  own,
  timeZone,
  now,
}: {
  conversation: Conversation;
  selected: boolean;
  own: boolean;
  timeZone: string;
  now: number;
}) {
  const unread = conversation.unread_count;
  const bold = own && unread > 0;
  return (
    <Link
      to={staffConversationPath(conversation.id)}
      aria-current={selected ? 'page' : undefined}
      className={`flex gap-3 rounded-xl px-3 py-3 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-400 ${
        selected ? 'bg-primary-50' : 'hover:bg-sage-50'
      }`}
    >
      <Avatar label={initials(conversation.client)} className="h-10 w-10 text-sm" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className={`truncate text-sm ${bold ? 'font-semibold text-sage-900' : 'font-medium text-sage-800'}`}>
            {listName(conversation)}
            {conversation.has_urgent && (
              <span className="ml-2 inline-flex items-center rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-700">
                Urgent
              </span>
            )}
          </span>
          {conversation.last_message_at && (
            <time dateTime={conversation.last_message_at} className="shrink-0 text-xs text-sage-500">
              {formatListTime(conversation.last_message_at, timeZone, now)}
            </time>
          )}
        </span>
        {!own && <span className="block truncate text-xs text-sage-500">with {conversation.clinician.name}</span>}
        <span className="mt-0.5 flex items-center gap-2">
          <span
            className={`min-w-0 flex-1 truncate text-sm ${
              conversation.last_message_preview ? (bold ? 'text-sage-800' : 'text-sage-500') : 'italic text-sage-400'
            }`}
          >
            {conversation.last_message_preview || 'No messages yet'}
          </span>
          {unread > 0 && <UnreadBadge count={unread} own={own} clinicianName={conversation.clinician.name} />}
        </span>
      </span>
    </Link>
  );
}

/**
 * Inbox column: an optional clinician filter, search, "New message", one row per conversation
 * and "Load more" for older ones. The search runs on the server (client name, email or phone).
 * Rows for someone else's conversation name its clinician.
 */
export function ConversationList({
  conversations,
  filtered,
  search,
  searchedFor,
  onSearchChange,
  isLoading,
  error,
  onRetry,
  loadMore,
  staffId,
  ownUnread,
  selectedConversationId,
  timeZone,
  filterOptions,
  filter,
  onFilterChange,
  onNewMessage,
}: {
  /** The loaded conversations matching the clinician filter and search, most recent first. */
  conversations: Conversation[] | undefined;
  /** Whether the clinician filter hides some conversations the viewer can read. */
  filtered: boolean;
  /** What's typed in the search box. */
  search: string;
  /** The search the shown conversations match (the typed text once it settles), or ''. */
  searchedFor: string;
  onSearchChange: (search: string) => void;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  /** The "Load more" footer's state (see usePagedQuery). */
  loadMore: Omit<ComponentProps<typeof LoadMore>, 'noun'>;
  staffId: number;
  ownUnread: number;
  selectedConversationId: number | null;
  timeZone: string;
  filterOptions: ClinicianFilterOption[];
  filter: ClinicianFilter;
  onFilterChange: (filter: ClinicianFilter) => void;
  onNewMessage: () => void;
}) {
  const now = useNow();
  const empty = conversations !== undefined && conversations.length === 0;

  return (
    <>
      <div className="space-y-3 border-b border-sage-100 px-4 pb-3 pt-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-lg font-semibold text-sage-900">
            Messages
            {ownUnread > 0 && <span className="ml-2 text-sm font-medium text-primary-700">{ownUnread} unread</span>}
          </h1>
          <Button size="sm" icon={<PenSquare className="h-4 w-4" aria-hidden="true" />} onClick={onNewMessage}>
            New message
          </Button>
        </div>
        {filterOptions.length > 0 && (
          <Select
            aria-label="Show conversations for"
            value={String(filter)}
            onChange={(event) => onFilterChange(event.target.value === 'all' ? 'all' : Number(event.target.value))}
          >
            {filterOptions.map((option) => (
              <option key={option.value} value={String(option.value)}>
                {option.label}
              </option>
            ))}
          </Select>
        )}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-sage-400" aria-hidden="true" />
          <Input
            type="search"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search by name, email or phone"
            aria-label="Search conversations"
            className="pl-9"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading && <LoadingRows />}
        {error !== null && !isLoading && <ErrorState error={error} onRetry={onRetry} />}
        {empty && !searchedFor && !filtered && (
          <EmptyState
            icon={<MessageSquare />}
            title="No conversations yet"
            description="Secure messages with clients will appear here."
            action={
              <Button size="sm" onClick={onNewMessage}>
                Start a conversation
              </Button>
            }
          />
        )}
        {empty && !searchedFor && filtered && (
          <p className="px-4 py-8 text-center text-sm text-sage-500">No conversations to show.</p>
        )}
        {empty && searchedFor && (
          <p className="px-4 py-8 text-center text-sm text-sage-500">No conversations match “{searchedFor}”.</p>
        )}
        {conversations && conversations.length > 0 && (
          <ul className="space-y-0.5 p-2" aria-label="Conversations">
            {conversations.map((conversation) => (
              <li key={conversation.id}>
                <ConversationRow
                  conversation={conversation}
                  selected={conversation.id === selectedConversationId}
                  own={conversation.clinician.id === staffId}
                  timeZone={timeZone}
                  now={now}
                />
              </li>
            ))}
          </ul>
        )}
        {conversations && conversations.length > 0 && <LoadMore noun="conversations" {...loadMore} />}
      </div>
    </>
  );
}
