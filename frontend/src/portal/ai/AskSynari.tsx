import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { Send, Sparkles, Trash2, X } from 'lucide-react';
import { aiApi, aiErrorMessage, isAbortError, MAX_MESSAGE_CHARS } from '../../api/ai';
import type { ClientRef } from '../../api/clients';
import { useSession } from '../../auth/StaffAuth';
import { displayFirstName } from '../../lib/format';
import { usePublicConfig } from '../../lib/usePublicConfig';
import { Button, IconButton } from '../../ui/Button';
import { Spinner } from '../../ui/Spinner';
import { seesClinicalRecords } from '../navigation';
import { AutoGrowTextarea } from '../notes/components/AutoGrowTextarea';
import { ClientPicker } from '../clients/ClientSearch';
import { toAssistantMessages, type ChatEntry } from './chat';
import { FormattedReply } from './FormattedReply';

/** Pages with their own full-height layout, where the floating button would cover controls. */
const LAUNCHER_HIDDEN_ON = ['/portal/messaging'];

const GENERAL_SUGGESTIONS = [
  'What belongs in the Assessment section of a SOAP note?',
  'Suggest measurable treatment plan goals for generalized anxiety.',
  'How should I document a safety plan?',
];

const CLIENT_SUGGESTIONS = [
  'Summarize the themes from recent sessions.',
  'What should I follow up on next session?',
];

function Message({ entry }: { entry: ChatEntry }) {
  if (entry.role === 'user') {
    return (
      <div className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary-600 px-3.5 py-2 text-sm text-white">
        <span className="sr-only">You: </span>
        {entry.content}
      </div>
    );
  }
  return (
    <div className="max-w-[92%] break-words rounded-2xl rounded-bl-md border border-sage-100 bg-sage-50 px-3.5 py-2.5 text-sm leading-relaxed text-sage-800">
      <span className="sr-only">Synari: </span>
      <FormattedReply text={entry.content} />
    </div>
  );
}

/**
 * "Ask Synari": a floating button that opens a side panel for documentation and practice
 * questions, optionally about one client (for staff who see clinical records). The conversation
 * lives only in memory.
 */
export function AskSynari() {
  const { ai_enabled: aiEnabled } = usePublicConfig();
  const clinical = seesClinicalRecords(useSession());
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [client, setClient] = useState<ClientRef | null>(null);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const titleId = useId();
  const clientFieldId = useId();
  const clientHintId = useId();

  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else if (wasOpen.current) launcherRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [entries, pending, error]);

  if (!aiEnabled) return null;

  const ask = async (history: ChatEntry[]) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setPending(true);
    setError(null);
    try {
      const { reply } = await aiApi.assistant(
        { messages: toAssistantMessages(history), client_id: client?.id ?? null },
        controller.signal,
      );
      setEntries((current) => [...current, { id: nextId.current++, role: 'assistant', content: reply }]);
    } catch (failure) {
      if (!isAbortError(failure)) setError(aiErrorMessage(failure));
    } finally {
      if (abort.current === controller) {
        abort.current = null;
        setPending(false);
      }
    }
  };

  const send = (text: string) => {
    const question = text.trim();
    if (!question || pending) return;
    const history: ChatEntry[] = [...entries, { id: nextId.current++, role: 'user', content: question.slice(0, MAX_MESSAGE_CHARS) }];
    setEntries(history);
    setInput('');
    void ask(history);
  };

  // Stopping puts the unanswered question back in the input so it can be edited and resent.
  const stop = () => {
    abort.current?.abort();
    abort.current = null;
    setPending(false);
    const last = entries[entries.length - 1];
    if (last?.role === 'user') {
      setEntries(entries.slice(0, -1));
      setInput(last.content);
    }
    inputRef.current?.focus();
  };

  const clear = () => {
    abort.current?.abort();
    abort.current = null;
    setPending(false);
    setEntries([]);
    setError(null);
    inputRef.current?.focus();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    send(input);
  };

  const suggestions = client ? CLIENT_SUGGESTIONS : GENERAL_SUGGESTIONS;
  const hideLauncher = LAUNCHER_HIDDEN_ON.some((path) => pathname.startsWith(path));

  return (
    <>
      {!open && !hideLauncher && (
        <button
          ref={launcherRef}
          type="button"
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-30 inline-flex items-center gap-2 rounded-full bg-primary-600 px-4 py-3 text-sm font-semibold text-white shadow-lg transition-colors hover:bg-primary-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2"
        >
          <Sparkles className="h-5 w-5" aria-hidden="true" />
          <span className="sr-only sm:not-sr-only">Ask Synari</span>
        </button>
      )}

      {open && (
        <section
          role="dialog"
          aria-labelledby={titleId}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false);
          }}
          className="fixed inset-0 z-40 flex flex-col bg-white shadow-2xl sm:inset-y-0 sm:left-auto sm:right-0 sm:w-[26rem] sm:border-l sm:border-sage-100"
        >
          <header className="flex items-center gap-2 border-b border-sage-100 px-4 py-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-100 text-primary-700">
              <Sparkles className="h-4 w-4" aria-hidden="true" />
            </span>
            <h2 id={titleId} className="flex-1 text-base font-semibold text-sage-900">
              Ask Synari
            </h2>
            {(entries.length > 0 || error) && (
              <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={clear}>
                Clear chat
              </Button>
            )}
            <IconButton label="Close Ask Synari" onClick={() => setOpen(false)}>
              <X className="h-5 w-5" />
            </IconButton>
          </header>

          {clinical && (
            <div className="border-b border-sage-100 px-4 py-3">
              <label htmlFor={clientFieldId} className="mb-1 block text-xs font-medium text-sage-700">
                About client (optional)
              </label>
              <ClientPicker
                access="clinical"
                id={clientFieldId}
                value={client}
                onChange={setClient}
                placeholder="Search for a client…"
                clearLabel="Remove client context"
                aria-describedby={clientHintId}
              />
              <p id={clientHintId} className="mt-1 text-xs text-sage-500">
                {client
                  ? `Synari can see ${displayFirstName(client)}'s profile and three most recent signed notes.`
                  : 'Choose a client to ask about their care. Without one, no client information is shared.'}
              </p>
            </div>
          )}

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4" aria-live="polite">
            {entries.length === 0 && !pending && !error && (
              <div className="space-y-3 text-sm text-sage-600">
                <p>Ask about documentation, treatment planning or running your practice.</p>
                <div className="flex flex-col items-start gap-2">
                  {suggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => send(suggestion)}
                      className="rounded-full border border-primary-200 bg-primary-50 px-3 py-1.5 text-left text-xs font-medium text-primary-800 hover:bg-primary-100"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {entries.map((entry) => (
              <Message key={entry.id} entry={entry} />
            ))}
            {pending && (
              <div className="flex items-center gap-2 text-sm text-sage-600">
                <Spinner className="h-4 w-4 text-primary-600" />
                Synari is thinking…
                <button type="button" onClick={stop} className="font-medium text-primary-700 underline-offset-2 hover:underline">
                  Stop
                </button>
              </div>
            )}
            {error && (
              <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800">
                <p>{error}</p>
                {entries[entries.length - 1]?.role === 'user' && (
                  <Button size="sm" variant="secondary" className="mt-2" onClick={() => void ask(entries)}>
                    Try again
                  </Button>
                )}
              </div>
            )}
          </div>

          <form onSubmit={submit} className="border-t border-sage-100 px-4 py-3">
            <div className="flex items-end gap-2">
              <AutoGrowTextarea
                ref={inputRef}
                aria-label="Message Synari"
                value={input}
                minRows={1}
                maxHeight={160}
                maxLength={MAX_MESSAGE_CHARS}
                placeholder="Ask a question…"
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    send(input);
                  }
                }}
              />
              <button
                type="submit"
                aria-label="Send"
                title="Send (Enter)"
                disabled={!input.trim() || pending}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-600 text-white shadow-sm hover:bg-primary-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-2 text-xs text-sage-500">
              Synari can make mistakes. Clinical decisions are yours. Shift + Enter for a new line.
            </p>
          </form>
        </section>
      )}
    </>
  );
}
