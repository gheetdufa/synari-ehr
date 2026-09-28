import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Sparkles } from 'lucide-react';
import { aiApi, aiErrorMessage, isAbortError, MAX_SOURCE_CHARS, type NoteProposal } from '../../../api/ai';
import type { NoteFormatId, NoteType } from '../../../api/notes';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { Alert } from '../../../ui/Display';
import { Spinner } from '../../../ui/Spinner';
import { AutoGrowTextarea } from './AutoGrowTextarea';
import { Dictation } from './Dictation';

/** Shown instead of the panel when the server has no AI provider configured. */
export function AiUnavailableNotice() {
  return (
    <p className="flex items-start gap-2 rounded-xl border border-dashed border-sage-200 px-4 py-3 text-sm text-sage-600">
      <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-sage-400" aria-hidden="true" />
      AI drafting isn't set up on this server. Notes work the same without it; an administrator can enable it by
      configuring an AI provider.
    </p>
  );
}

/**
 * "Draft from session notes": rough notes, a transcript or dictation go in; an AI draft comes
 * back for the clinician to review section by section. Nothing is saved until they use it.
 */
export function AiDraftPanel({
  clientId,
  appointmentId,
  format,
  noteType,
  defaultOpen,
  disabled,
  onProposal,
}: {
  clientId: number;
  appointmentId: number | null;
  format: NoteFormatId;
  noteType: NoteType;
  defaultOpen: boolean;
  disabled: boolean;
  onProposal: (proposal: NoteProposal) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [source, setSource] = useState('');
  const [pending, setPending] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const panelId = useId();
  const sourceId = useId();

  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    if (!pending) return;
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [pending]);

  const generate = async () => {
    const text = source.trim();
    if (!text || pending) return;
    const controller = new AbortController();
    abort.current = controller;
    setPending(true);
    setError(null);
    try {
      const proposal = await aiApi.generateNote(
        { client_id: clientId, appointment_id: appointmentId, format, note_type: noteType, source_text: text },
        controller.signal,
      );
      onProposal(proposal);
    } catch (failure) {
      if (!isAbortError(failure)) setError(aiErrorMessage(failure));
    } finally {
      if (abort.current === controller) abort.current = null;
      setPending(false);
    }
  };

  const addText = (text: string) =>
    setSource((current) => (current.trim() ? `${current.trimEnd()}\n\n${text}` : text).slice(0, MAX_SOURCE_CHARS));

  return (
    <Card className="border-primary-100">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 rounded-xl px-5 py-3.5 text-left hover:bg-primary-50/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-100 text-primary-700">
          <Sparkles className="h-4 w-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-sage-900">Draft from session notes</span>
          <span className="block text-xs text-sage-600">
            Optional. Paste rough notes or a transcript, or dictate, and get a draft to review.
          </span>
        </span>
        <ChevronDown className={`h-4 w-4 text-sage-500 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {open && (
        <div id={panelId} className="space-y-3 border-t border-sage-100 px-5 py-4">
          <div>
            <label htmlFor={sourceId} className="mb-1 block text-sm font-medium text-sage-800">
              Session material
            </label>
            <AutoGrowTextarea
              id={sourceId}
              value={source}
              minRows={4}
              maxHeight={360}
              maxLength={MAX_SOURCE_CHARS}
              disabled={pending || disabled}
              placeholder="e.g. Client reported sleeping better since starting the wind-down routine. Discussed work stress…"
              onChange={(event) => setSource(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void generate();
                }
              }}
            />
            <p className="mt-1 text-xs text-sage-500">
              Only what you provide is used. This text isn't saved.
              {source.length > MAX_SOURCE_CHARS * 0.9 && ` ${source.length.toLocaleString()} / ${MAX_SOURCE_CHARS.toLocaleString()} characters.`}
            </p>
          </div>

          <Dictation onText={addText} disabled={pending || disabled} />

          {error && (
            <Alert tone="danger" title="Couldn't draft the note">
              {error}
            </Alert>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {pending ? (
              <>
                <span className="inline-flex items-center gap-2 text-sm text-sage-700" role="status">
                  <Spinner className="h-4 w-4 text-primary-600" />
                  Drafting… {elapsed}s <span className="text-sage-500">(usually 10–30 seconds)</span>
                </span>
                <Button size="sm" variant="secondary" onClick={() => abort.current?.abort()}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                icon={<Sparkles className="h-4 w-4" />}
                disabled={!source.trim() || disabled}
                onClick={() => void generate()}
                title="Generate (Ctrl/⌘ + Enter)"
              >
                Generate draft
              </Button>
            )}
          </div>
          <p className="text-xs text-sage-500">
            AI drafts can be wrong or incomplete. Review every section before you sign — the note is yours.
          </p>
        </div>
      )}
    </Card>
  );
}
