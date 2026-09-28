import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useChat, type ReceivedChatMessage } from '@livekit/components-react';
import { Send } from 'lucide-react';

export interface CallChat {
  messages: ReceivedChatMessage[];
  send: (message: string) => Promise<unknown>;
  isSending: boolean;
  /** Messages from others that arrived while the chat panel was closed. */
  unread: number;
}

/**
 * In-call text chat over LiveKit's data channel. Messages live only in memory for the length of the
 * call and are never stored. Call once per room and pass the result down.
 */
export function useCallChat(open: boolean): CallChat {
  const { chatMessages, send, isSending } = useChat();
  const [seen, setSeen] = useState(0);
  useEffect(() => {
    if (open) setSeen(chatMessages.length);
  }, [open, chatMessages.length]);
  const unread = open ? 0 : chatMessages.slice(seen).filter((message) => !message.from?.isLocal).length;
  return { messages: chatMessages, send, isSending, unread };
}

function senderName(message: ReceivedChatMessage): string {
  if (message.from?.isLocal) return 'You';
  return message.from?.name || 'Participant';
}

const timeFormat = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

export function ChatPanel({ chat }: { chat: CallChat }) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLOListElement>(null);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [chat.messages.length]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setError(null);
    try {
      await chat.send(text);
      setDraft('');
    } catch {
      setError("Your message wasn't sent. Check your connection and try again.");
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <p className="border-b border-white/5 px-4 py-2 text-xs text-white/50">
        Messages are only visible during this call and aren&apos;t saved.
      </p>
      <ol ref={list} aria-live="polite" className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {chat.messages.length === 0 && <li className="py-8 text-center text-sm text-white/50">No messages yet.</li>}
        {chat.messages.map((message) => {
          const mine = !!message.from?.isLocal;
          return (
            <li key={message.id} className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
              <span className="mb-0.5 text-[11px] text-white/50">
                {senderName(message)} · {timeFormat.format(new Date(message.timestamp))}
              </span>
              <span
                className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm ${
                  mine ? 'rounded-br-md bg-primary-600 text-white' : 'rounded-bl-md bg-white/10 text-white'
                }`}
              >
                {message.message}
              </span>
            </li>
          );
        })}
      </ol>
      <form onSubmit={submit} className="border-t border-white/5 p-3">
        {error && (
          <p role="alert" className="mb-2 text-xs text-red-300">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2">
          <label htmlFor="call-chat-input" className="sr-only">
            Message
          </label>
          <input
            id="call-chat-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={2000}
            autoComplete="off"
            placeholder="Type a message"
            className="h-10 min-w-0 flex-1 rounded-full border border-white/10 bg-white/5 px-4 text-sm text-white placeholder:text-white/40 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-400/30"
          />
          <button
            type="submit"
            disabled={chat.isSending || !draft.trim()}
            aria-label="Send message"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-500 text-[#042f2e] hover:bg-primary-400 disabled:opacity-40"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </form>
    </div>
  );
}
