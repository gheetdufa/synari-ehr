import { useRef, type ReactNode } from 'react';
import { AlertTriangle, MoreHorizontal, Trash2 } from 'lucide-react';
import type { Realm } from '../../api/client';
import { formatDateTime } from '../../lib/format';
import { Popover } from '../../ui/Display';
import { AttachmentChip } from './AttachmentChip';
import { isFlagged, type ThreadMessage } from './threadModel';

const LONG_PRESS_MS = 500;

/** Touch handlers that call `onLongPress` after a steady press (the mobile way to open a menu). */
function useLongPress(onLongPress: () => void) {
  const timer = useRef<number | undefined>(undefined);
  const fired = useRef(false);
  const cancel = () => window.clearTimeout(timer.current);
  return {
    onTouchStart: () => {
      fired.current = false;
      cancel();
      timer.current = window.setTimeout(() => {
        fired.current = true;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onTouchEnd: cancel,
    onTouchMove: cancel,
    onTouchCancel: cancel,
    onContextMenu: (event: { preventDefault: () => void }) => {
      if (fired.current) event.preventDefault();
    },
  };
}

function bubbleClasses(message: ThreadMessage, own: boolean, alignEnd: boolean, lastInGroup: boolean): string {
  const tail = lastInGroup ? (alignEnd ? 'rounded-br-md' : 'rounded-bl-md') : '';
  const base = `rounded-2xl px-3.5 py-2 ${tail}`;
  if (message.removed) return `${base} border border-dashed border-sage-300 bg-transparent text-sage-500`;
  if (message.is_automatic) return `${base} border border-dashed border-sage-300 bg-sage-100 text-sage-800`;
  if (isFlagged(message)) {
    return message.risk_level === 'high'
      ? `${base} border-2 border-red-300 bg-red-50 text-sage-900`
      : `${base} border-2 border-amber-300 bg-amber-50 text-sage-900`;
  }
  if (own) return `${base} bg-primary-600 text-white shadow-sm`;
  // Someone else on the viewer's side, e.g. a colleague replying in a clinician's conversation.
  if (alignEnd) return `${base} border border-primary-200 bg-primary-50 text-sage-900 shadow-sm`;
  return `${base} border border-sage-200 bg-white text-sage-900 shadow-sm`;
}

function BubbleContent({
  message,
  own,
  alignEnd,
  lastInGroup,
  realm,
  senderLabel,
  timeZone,
}: {
  message: ThreadMessage;
  own: boolean;
  alignEnd: boolean;
  lastInGroup: boolean;
  realm: Realm;
  senderLabel: string;
  timeZone: string;
}) {
  const onOwnBubble = own && !message.removed && !message.is_automatic;
  return (
    <div
      className={`min-w-0 max-w-full ${bubbleClasses(message, own, alignEnd, lastInGroup)}`}
      title={formatDateTime(message.created_at, timeZone)}
    >
      <span className="sr-only">
        {senderLabel}, {formatDateTime(message.created_at, timeZone)}:{' '}
      </span>
      {message.removed ? (
        <p className="text-sm italic">Message removed</p>
      ) : (
        <>
          {message.body && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.body}</p>}
          {message.attachments.length > 0 && (
            <ul className={`space-y-1.5 ${message.body ? 'mt-2' : ''}`} aria-label="Attachments">
              {message.attachments.map((attachment) => (
                <li key={attachment.id}>
                  <AttachmentChip attachment={attachment} realm={realm} onOwnBubble={onOwnBubble} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/**
 * One message, on the right when it comes from the viewer's side of the conversation. The
 * viewer's own messages get an options menu (hover or focus on desktop, long-press or the
 * always-visible button on touch screens) to remove them.
 */
export function MessageBubble({
  message,
  own,
  alignEnd,
  lastInGroup,
  realm,
  senderLabel,
  timeZone,
  onRemove,
}: {
  message: ThreadMessage;
  own: boolean;
  alignEnd: boolean;
  lastInGroup: boolean;
  realm: Realm;
  senderLabel: string;
  timeZone: string;
  onRemove?: (message: ThreadMessage) => void;
}) {
  const flagged = isFlagged(message) && !message.removed;
  const content = (
    <BubbleContent
      message={message}
      own={own}
      alignEnd={alignEnd}
      lastInGroup={lastInGroup}
      realm={realm}
      senderLabel={senderLabel}
      timeZone={timeZone}
    />
  );
  const removable = own && !message.removed && onRemove !== undefined;

  return (
    <div className={`flex ${alignEnd ? 'justify-end' : 'justify-start'}`}>
      <div className="flex max-w-[88%] flex-col sm:max-w-[75%]">
        {flagged && (
          <p
            className={`mb-1 flex items-center gap-1.5 text-xs font-semibold ${
              message.risk_level === 'high' ? 'text-red-700' : 'text-amber-800'
            }`}
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Flagged for possible crisis language
          </p>
        )}
        {removable ? (
          <RemovableBubble onRemove={() => onRemove(message)}>{content}</RemovableBubble>
        ) : (
          content
        )}
      </div>
    </div>
  );
}

function RemovableBubble({ children, onRemove }: { children: ReactNode; onRemove: () => void }) {
  return (
    <Popover
      align="right"
      className="w-48"
      trigger={({ open, toggle }) => <PressTarget open={open} toggle={toggle}>{children}</PressTarget>}
    >
      {(close) => (
        <div role="menu" aria-label="Message options" className="py-1">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close();
              onRemove();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-700 hover:bg-red-50 focus:bg-red-50 focus:outline-none"
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Remove message
          </button>
        </div>
      )}
    </Popover>
  );
}

function PressTarget({ open, toggle, children }: { open: boolean; toggle: () => void; children: ReactNode }) {
  const longPress = useLongPress(toggle);
  return (
    <div className="group flex min-w-0 items-center justify-end gap-1" {...longPress}>
      <button
        type="button"
        onClick={toggle}
        aria-label="Message options"
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sage-500 opacity-0 transition-opacity hover:bg-sage-100 hover:text-sage-800 focus:outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-primary-400 group-hover:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {children}
    </div>
  );
}
