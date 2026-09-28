import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ArrowDown, Check, CheckCheck, Clock } from 'lucide-react';
import type { Realm } from '../../api/client';
import type { SenderRole } from '../../api/messages';
import { formatDateTime, formatTime } from '../../lib/format';
import { Button } from '../../ui/Button';
import { useNow } from './hooks';
import { MessageBubble } from './MessageBubble';
import { buildThreadItems, readReceipts, type DescribeSender, type ThreadMessage } from './threadModel';

/** Distance from the bottom (px) within which the thread counts as "at the latest message". */
const PINNED_THRESHOLD_PX = 96;

interface Announcement {
  sequence: number;
  text: string;
}

/**
 * Keeps the thread scrolled sensibly as data changes: starts at the newest message, follows new
 * messages while the reader is at the bottom (or just sent one), keeps the reading position
 * when older pages load above, and otherwise counts unseen messages for a "jump" button.
 */
function useThreadScroll(messages: ThreadMessage[], describeSender: DescribeSender) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const snapshot = useRef<{ firstId: number | null; lastId: number | null; height: number } | null>(null);
  const [unseen, setUnseen] = useState(0);
  const [announcement, setAnnouncement] = useState<Announcement>({ sequence: 0, text: '' });

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < PINNED_THRESHOLD_PX;
    if (pinned.current) setUnseen(0);
  }, []);

  const scrollToLatest = useCallback((smooth: boolean) => {
    const element = scrollRef.current;
    if (!element) return;
    if (smooth && typeof element.scrollTo === 'function') {
      element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
    } else {
      element.scrollTop = element.scrollHeight;
    }
    pinned.current = true;
    setUnseen(0);
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    // Stay on the latest message when the thread gets shorter, e.g. while the composer grows.
    const observer = new ResizeObserver(() => {
      if (pinned.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const firstId = messages.length ? messages[0].id : null;
    const lastId = messages.length ? messages[messages.length - 1].id : null;
    const previous = snapshot.current;

    if (previous === null) {
      element.scrollTop = element.scrollHeight;
    } else if (lastId !== null && (previous.lastId === null || lastId > previous.lastId)) {
      const added = messages.filter((message) => previous.lastId === null || message.id > previous.lastId);
      const incoming = added.filter((message) => !describeSender(message).own && !message.removed);
      const sentByViewer = added.some((message) => describeSender(message).own && !message.is_automatic);
      if (pinned.current || sentByViewer) {
        element.scrollTop = element.scrollHeight;
        pinned.current = true;
      } else if (incoming.length > 0) {
        setUnseen((count) => count + incoming.length);
      }
      if (incoming.length > 0) {
        const text =
          incoming.length === 1 ? `New message from ${describeSender(incoming[0]).name}` : `${incoming.length} new messages`;
        setAnnouncement((current) => ({ sequence: current.sequence + 1, text }));
      }
    } else if (firstId !== previous.firstId) {
      element.scrollTop += element.scrollHeight - previous.height;
    } else if (pinned.current) {
      element.scrollTop = element.scrollHeight;
    }
    snapshot.current = { firstId, lastId, height: element.scrollHeight };
  }, [messages, describeSender]);

  return { scrollRef, onScroll, scrollToLatest, unseen, announcement };
}

/** Loads older messages when the top of the thread scrolls into view. */
function useLoadOlderOnScroll(
  scrollRef: RefObject<HTMLDivElement>,
  enabled: boolean,
  onLoadOlder: () => void,
) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadRef = useRef(onLoadOlder);
  loadRef.current = onLoadOlder;

  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!enabled || !root || !sentinel || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadRef.current();
      },
      { root, rootMargin: '240px 0px 0px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [enabled, scrollRef]);

  return sentinelRef;
}

export interface MessageThreadProps {
  messages: ThreadMessage[];
  /** The viewer's side of the conversation; its messages sit on the right. */
  viewerSide: SenderRole;
  /** Who wrote a message as the viewer sees it (see staffViewSender and portalViewSender). */
  describeSender: DescribeSender;
  /** Who the conversation is with, for the scroll region's label. */
  otherName: string;
  timeZone: string;
  /** Which account downloads attachments. */
  realm: Realm;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  /** Offered on the viewer's own messages; omit to hide the remove action. */
  onRemove?: (message: ThreadMessage) => void;
  /** Shown when the conversation has no messages yet. */
  empty: ReactNode;
}

/**
 * A scrollable conversation: day separators, sender groups named when someone other than the
 * usual two people writes, read receipts and paging back in time.
 */
export function MessageThread({
  messages,
  viewerSide,
  describeSender,
  otherName,
  timeZone,
  realm,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  onRemove,
  empty,
}: MessageThreadProps) {
  const now = useNow();
  const items = useMemo(() => buildThreadItems(messages, timeZone, now), [messages, timeZone, now]);
  const receipts = useMemo(() => readReceipts(messages, viewerSide), [messages, viewerSide]);
  const { scrollRef, onScroll, scrollToLatest, unseen, announcement } = useThreadScroll(messages, describeSender);
  const sentinelRef = useLoadOlderOnScroll(scrollRef, hasOlder && !loadingOlder, onLoadOlder);

  const receiptLabel = (messageId: number) => {
    if (messageId === receipts.readId) {
      return (
        <span className="inline-flex items-center gap-0.5 text-primary-700">
          <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" /> Read
        </span>
      );
    }
    if (messageId === receipts.sentId) {
      return (
        <span className="inline-flex items-center gap-0.5">
          <Check className="h-3.5 w-3.5" aria-hidden="true" /> Sent
        </span>
      );
    }
    return null;
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        role="region"
        aria-label={`Conversation with ${otherName}`}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-300 sm:px-5"
      >
        {hasOlder && (
          <div ref={sentinelRef} className="flex justify-center pb-4">
            <Button variant="ghost" size="sm" loading={loadingOlder} onClick={onLoadOlder}>
              {loadingOlder ? 'Loading earlier messages…' : 'Load earlier messages'}
            </Button>
          </div>
        )}
        {!hasOlder && messages.length > 0 && (
          <p className="pb-2 text-center text-xs text-sage-400">This is the beginning of your conversation.</p>
        )}
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center">{empty}</div>
        ) : (
          <ol className="space-y-3" aria-label="Messages">
            {items.map((item) => {
              if (item.kind === 'day') {
                return (
                  <li key={item.key} className="flex items-center gap-3 py-2" aria-label={item.label}>
                    <span className="h-px flex-1 bg-sage-200" aria-hidden="true" />
                    <span className="text-xs font-medium text-sage-500">{item.label}</span>
                    <span className="h-px flex-1 bg-sage-200" aria-hidden="true" />
                  </li>
                );
              }
              const sender = describeSender(item.messages[0]);
              const alignEnd = item.senderRole === viewerSide;
              const senderLabel = item.automatic ? 'Automatic reply' : sender.name;
              const last = item.messages[item.messages.length - 1];
              return (
                <li key={item.key} className={`flex flex-col gap-1 ${alignEnd ? 'items-end' : 'items-start'}`}>
                  {item.automatic && (
                    <p className="flex items-center gap-1 px-1 text-xs font-medium text-sage-500">
                      <Clock className="h-3.5 w-3.5" aria-hidden="true" /> Automatic reply
                    </p>
                  )}
                  {!item.automatic && sender.showName && (
                    <p className="px-1 text-xs font-medium text-sage-600" aria-hidden="true">
                      {sender.name}
                    </p>
                  )}
                  {item.messages.map((message) => (
                    <div key={message.id} className="w-full">
                      <MessageBubble
                        message={message}
                        own={sender.own}
                        alignEnd={alignEnd}
                        lastInGroup={message.id === last.id}
                        realm={realm}
                        senderLabel={senderLabel}
                        timeZone={timeZone}
                        onRemove={onRemove}
                      />
                      {message.id !== last.id && receiptLabel(message.id) && (
                        <p className="mt-0.5 flex justify-end px-1 text-[11px] text-sage-500">{receiptLabel(message.id)}</p>
                      )}
                    </div>
                  ))}
                  {(item.showTime || receiptLabel(last.id)) && (
                    <p className="flex items-center gap-1.5 px-1 text-[11px] text-sage-500">
                      <time dateTime={last.created_at} title={formatDateTime(last.created_at, timeZone)}>
                        {formatTime(last.created_at, timeZone)}
                      </time>
                      {receiptLabel(last.id) && (
                        <>
                          <span aria-hidden="true">·</span>
                          {receiptLabel(last.id)}
                        </>
                      )}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
      {unseen > 0 && (
        <button
          type="button"
          onClick={() => scrollToLatest(true)}
          className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-primary-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-lg hover:bg-primary-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 focus-visible:ring-offset-2"
        >
          <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
          {unseen === 1 ? '1 new message' : `${unseen} new messages`}
        </button>
      )}
      <div aria-live="polite" className="sr-only">
        {announcement.text && <p key={announcement.sequence}>{announcement.text}</p>}
      </div>
    </div>
  );
}
