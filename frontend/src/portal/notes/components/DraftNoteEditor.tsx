import { useEffect, useId, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Lock, Trash2 } from 'lucide-react';
import type { NoteProposal } from '../../../api/ai';
import { ApiError } from '../../../api/client';
import {
  MAX_CONTENT_CHARS,
  MAX_SECTION_CHARS,
  NOTE_TYPE_LABELS,
  noteKeys,
  notesApi,
  PSYCHOTHERAPY_NOTE_BADGE,
  PSYCHOTHERAPY_NOTE_HELP,
  RISK_LEVEL_LABELS,
  type Note,
  type NoteFormat,
  type NoteFormatId,
  type NoteType,
  type NoteUpdate,
  type RiskLevel,
} from '../../../api/notes';
import { useSession } from '../../../auth/StaffAuth';
import { usePublicConfig } from '../../../lib/usePublicConfig';
import { Button, IconButton } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { Alert } from '../../../ui/Display';
import { Field, Select } from '../../../ui/Form';
import { ConfirmDialog } from '../../../ui/Modal';
import { useToast } from '../../../ui/Toast';
import { AUTOSAVE_DELAY_MS, Autosaver, notePatch, toEditable, useAutosaver, type EditableNote } from '../autosave';
import { appointmentLabel, findFormat, useClientAppointments, useSupervision } from '../hooks';
import {
  applyProposalAll,
  applyProposalSection,
  convertNoteText,
  isFreeform,
  mergeRiskFlags,
  noteTextIsEmpty,
  proposalApplied,
  type NoteText,
  type TextMove,
} from '../noteText';
import { AiDraftPanel, AiUnavailableNotice } from './AiDraftPanel';
import { AutoGrowTextarea } from './AutoGrowTextarea';
import { EditorToolbar } from './EditorToolbar';
import { NoteMeta, RiskFlagsAlert, SessionNotesLink } from './NoteMeta';
import { ProposalBanner, ProposalBox } from './Proposal';
import { SaveIndicator } from './SaveIndicator';

const NO_APPOINTMENT = 'none';
const FREEFORM_GUIDANCE = 'Write the note in your own words and structure.';

interface PendingFormat {
  format: NoteFormat;
  text: NoteText;
  moves: TextMove[];
}

/** One labeled, auto-growing field of the note, with the AI's suggestion beside it when there is one. */
function SectionField({
  label,
  guidance,
  value,
  minRows,
  maxLength,
  readOnly,
  onChange,
  onBlur,
  suggestion,
}: {
  label: string;
  guidance: string;
  value: string;
  minRows: number;
  maxLength: number;
  readOnly: boolean;
  onChange: (text: string) => void;
  onBlur: () => void;
  suggestion?: ReactNode;
}) {
  const id = useId();
  return (
    <div className={`px-4 py-4 sm:px-5 ${suggestion ? 'grid gap-4 lg:grid-cols-2' : ''}`}>
      <div>
        <label htmlFor={id} className="block text-sm font-semibold text-sage-900">
          {label}
        </label>
        <p id={`${id}-hint`} className="mb-2 mt-0.5 text-xs leading-relaxed text-sage-500">
          {guidance}
        </p>
        <AutoGrowTextarea
          id={id}
          aria-describedby={`${id}-hint`}
          value={value}
          minRows={minRows}
          maxLength={maxLength}
          readOnly={readOnly}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          className="leading-relaxed"
        />
      </div>
      {suggestion}
    </div>
  );
}

function moveSummary(moves: TextMove[]): string[] {
  const byTarget = new Map<string, string[]>();
  for (const move of moves) byTarget.set(move.to, [...(byTarget.get(move.to) ?? []), move.from]);
  return Array.from(byTarget, ([to, from]) => `${from.join(', ')} → ${to}`);
}

/**
 * Editor for a draft note: autosaves (debounced, on blur, on Ctrl/⌘+S and when leaving),
 * switches formats without losing text, applies AI drafts, and signs or deletes the note.
 */
export function DraftNoteEditor({ note, formats }: { note: Note; formats: NoteFormat[] }) {
  const { staff } = useSession();
  const { supervisor } = useSupervision();
  const { ai_enabled: aiEnabled } = usePublicConfig();
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const noteId = note.id;

  const [snapshot, saver] = useAutosaver(
    () =>
      new Autosaver<EditableNote, NoteUpdate>({
        initial: toEditable(note),
        diff: notePatch,
        delayMs: AUTOSAVE_DELAY_MS,
        save: async (patch, value) => {
          // The cache holds the newest text so reopening the note mid-save never shows older text.
          const key = noteKeys.detail(noteId);
          const previous = queryClient.getQueryData<Note>(key);
          if (previous) queryClient.setQueryData<Note>(key, { ...previous, ...value });
          try {
            const saved = await notesApi.update(noteId, patch);
            queryClient.setQueryData<Note>(key, (current) => (current ? { ...saved, ...toEditable(current) } : saved));
            void queryClient.invalidateQueries({ queryKey: noteKeys.lists });
          } catch (error) {
            if (previous) queryClient.setQueryData(key, previous);
            throw error;
          }
        },
      }),
  );
  const value = snapshot.value;
  const format = findFormat(formats, value.format)!;

  const [proposal, setProposal] = useState<NoteProposal | null>(null);
  const [undo, setUndo] = useState<NoteText | null>(null);
  const [pendingFormat, setPendingFormat] = useState<PendingFormat | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [confirmSign, setConfirmSign] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { appointments, isLoading: appointmentsLoading } = useClientAppointments(note.client.id, value.appointment_id);

  const change = (changes: Partial<EditableNote>) => saver.update({ ...saver.getSnapshot().value, ...changes });
  const editText = (changes: Partial<EditableNote>) => {
    setUndo(null);
    change(changes);
  };
  const saveNow = () => void saver.flush();

  // A 409 means the note was signed elsewhere; a 404 that it was deleted. Either way, stop saving.
  const error = snapshot.error;
  useEffect(() => {
    if (!(error instanceof ApiError) || (error.status !== 409 && error.status !== 404)) return;
    saver.stop();
    if (error.status === 409) {
      toast.error("This note was signed in another window, so your latest edits weren't saved.");
      void queryClient.invalidateQueries({ queryKey: noteKeys.detail(noteId) });
    } else {
      toast.error('This note no longer exists.');
      navigate('/portal/notes', { replace: true });
    }
  }, [error, saver, toast, queryClient, noteId, navigate]);

  // Save when leaving: in-app navigation (unmount), tab close, or the page going to the background.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (saver.isStopped() || (!saver.isDirty() && saver.getSnapshot().status !== 'saving')) return;
      void saver.flush();
      event.preventDefault();
      event.returnValue = '';
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void saver.flush();
    };
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saver.flush();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('keydown', onKey);
      if (saver.isStopped()) return;
      void saver.flush().then((saved) => {
        if (!saved) toast.error("Your latest changes to a note couldn't be saved. Open it again to check.");
      });
    };
  }, [saver, toast]);

  const invalidateOverview = () => {
    void queryClient.invalidateQueries({ queryKey: noteKeys.lists });
    void queryClient.invalidateQueries({ queryKey: noteKeys.backlog });
  };

  const sign = useMutation({
    mutationFn: async () => {
      if (!(await saver.flush())) {
        throw new Error("Your latest changes couldn't be saved, so the note wasn't signed. Try again.");
      }
      return notesApi.sign(noteId);
    },
    onSuccess: (signed) => {
      saver.stop();
      setConfirmSign(false);
      queryClient.setQueryData(noteKeys.detail(noteId), signed);
      invalidateOverview();
      toast.success(
        signed.status === 'pending_cosign'
          ? `Note signed and sent to ${signed.supervisor?.name ?? 'your supervisor'} to co-sign.`
          : 'Note signed and locked.',
      );
    },
    onError: (failure) => {
      setConfirmSign(false);
      toast.error(failure);
    },
  });

  const remove = useMutation({
    mutationFn: async () => {
      saver.stop();
      await saver.flush();
      await notesApi.remove(noteId);
    },
    onSuccess: () => {
      navigate('/portal/notes', { replace: true });
      queryClient.removeQueries({ queryKey: noteKeys.detail(noteId) });
      invalidateOverview();
      toast.success('Draft deleted.');
    },
    onError: (failure) => {
      saver.resume();
      setConfirmDelete(false);
      toast.error(failure);
    },
  });

  const locked = sign.isPending || remove.isPending;
  const empty = noteTextIsEmpty(value);

  const requestFormat = (nextId: NoteFormatId) => {
    const next = findFormat(formats, nextId);
    if (!next || next.id === value.format) return;
    const converted = convertNoteText(format, next, value);
    if (converted.moves.length > 0) setPendingFormat({ format: next, ...converted });
    else editText({ format: next.id, ...converted.text });
  };

  const usable = proposal !== null && proposal.format === value.format;
  const applyText = (text: NoteText) => {
    if (!proposal) return;
    const current = saver.getSnapshot().value;
    setUndo({ sections: current.sections, content: current.content });
    saver.update({ ...current, ...text, risk_flags: mergeRiskFlags(current.risk_flags, proposal.risk_flags) });
  };
  const replaceAll = () => {
    if (!proposal) return;
    if (noteTextIsEmpty(value)) applyText(applyProposalAll(format, proposal));
    else setConfirmReplace(true);
  };

  const restoreTitle = () => {
    const current = saver.getSnapshot();
    if (!current.value.title.trim()) change({ title: current.saved.title });
    saveNow();
  };

  const suggestionFor = (label: string, text: string, applied: boolean, onUse: () => void) =>
    proposal ? <ProposalBox label={label} text={text} applied={applied} usable={usable} onUse={onUse} /> : undefined;

  return (
    <div>
      <EditorToolbar>
        <SaveIndicator status={snapshot.status} lastSavedAt={snapshot.lastSavedAt} onRetry={saveNow} />
        {!note.was_signed && (
          <IconButton label="Delete draft" onClick={() => setConfirmDelete(true)} disabled={locked}>
            <Trash2 className="h-4 w-4" />
          </IconButton>
        )}
        <Button
          icon={<Lock className="h-4 w-4" />}
          onClick={() => setConfirmSign(true)}
          disabled={empty || locked}
          title={empty ? 'Add some content before signing' : 'Sign and lock this note'}
        >
          Sign note
        </Button>
      </EditorToolbar>

      <div className="space-y-5">
        <header className="space-y-2">
          <input
            aria-label="Note title"
            value={value.title}
            maxLength={200}
            readOnly={locked}
            onChange={(event) => change({ title: event.target.value })}
            onBlur={restoreTitle}
            placeholder="Note title"
            className="w-full rounded-lg border border-transparent bg-transparent px-2 py-1 -ml-2 text-2xl font-semibold tracking-tight text-sage-900 placeholder:text-sage-400 hover:border-sage-200 focus:border-primary-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-200"
          />
          {!value.title.trim() && <p className="text-xs text-red-600">A title is required. Leave it empty to keep the previous one.</p>}
          <NoteMeta client={note.client} appointmentId={value.appointment_id} timeZone={staff.time_zone}>
            <SessionNotesLink note={note} />
          </NoteMeta>
        </header>

        {note.ai_generated && (
          <Alert tone="primary" title="AI draft from session recording — review before signing">
            Synari drafted this note from the session recording. Check each section against the session and correct
            anything inaccurate or missing before you sign.
          </Alert>
        )}
        {note.supervisor_comment ? (
          <Alert tone="warning" title={`${note.supervisor?.name ?? 'Your supervisor'} asked for changes`}>
            <p className="whitespace-pre-wrap">{note.supervisor_comment}</p>
            <p className="mt-1 text-amber-800">Make the changes, then sign the note again to send it back for co-signature.</p>
          </Alert>
        ) : (
          note.was_signed && (
            <Alert tone="warning" title="Unlocked for amendment">
              This note was signed before. Sign it again when your amendment is complete; the earlier signed version
              stays in the note&apos;s history and the unlock is recorded in the audit log.
              {note.pending_revision_reason && (
                <span className="mt-1 block">
                  <span className="font-medium">Reason for the change:</span> {note.pending_revision_reason}
                </span>
              )}
            </Alert>
          )
        )}
        {value.note_type === 'psychotherapy' && (
          <Alert tone="info" title={PSYCHOTHERAPY_NOTE_BADGE}>
            {PSYCHOTHERAPY_NOTE_HELP}
          </Alert>
        )}
        <RiskFlagsAlert flags={value.risk_flags} />

        <Card className="grid gap-4 px-4 py-4 sm:grid-cols-2 sm:px-5 xl:grid-cols-4">
          <Field label="Note type">
            {(props) => (
              <Select
                {...props}
                value={value.note_type}
                disabled={locked}
                onChange={(event) => change({ note_type: event.target.value as NoteType })}
              >
                {(Object.keys(NOTE_TYPE_LABELS) as NoteType[]).map((type) => (
                  <option key={type} value={type}>
                    {NOTE_TYPE_LABELS[type]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Format">
            {(props) => (
              <Select
                {...props}
                value={value.format}
                disabled={locked}
                onChange={(event) => requestFormat(event.target.value as NoteFormatId)}
              >
                {formats.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Appointment">
            {(props) => (
              <Select
                {...props}
                value={value.appointment_id === null ? NO_APPOINTMENT : String(value.appointment_id)}
                disabled={locked || appointmentsLoading}
                onChange={(event) =>
                  change({ appointment_id: event.target.value === NO_APPOINTMENT ? null : Number(event.target.value) })
                }
              >
                <option value={NO_APPOINTMENT}>{appointmentsLoading ? 'Loading…' : 'No appointment'}</option>
                {appointments.map((appointment) => (
                  <option key={appointment.id} value={appointment.id}>
                    {appointmentLabel(appointment, staff.time_zone)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Risk level">
            {(props) => (
              <Select
                {...props}
                value={value.risk_level}
                disabled={locked}
                onChange={(event) => change({ risk_level: event.target.value as RiskLevel })}
              >
                {(Object.keys(RISK_LEVEL_LABELS) as RiskLevel[]).map((level) => (
                  <option key={level} value={level}>
                    {RISK_LEVEL_LABELS[level]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </Card>

        {aiEnabled ? (
          <AiDraftPanel
            clientId={note.client.id}
            appointmentId={value.appointment_id}
            format={value.format}
            noteType={value.note_type}
            defaultOpen={empty}
            disabled={locked}
            onProposal={(next) => {
              setProposal(next);
              setUndo(null);
            }}
          />
        ) : (
          <AiUnavailableNotice />
        )}

        {proposal && (
          <ProposalBanner
            proposal={proposal}
            formatName={findFormat(formats, proposal.format)?.name ?? proposal.format}
            usable={usable}
            canUndo={undo !== null}
            onReplaceAll={replaceAll}
            onDiscard={() => {
              setProposal(null);
              setUndo(null);
            }}
            onUndo={() => {
              if (!undo) return;
              change(undo);
              setUndo(null);
            }}
          />
        )}

        <Card className="divide-y divide-sage-100">
          {isFreeform(format) ? (
            <SectionField
              label="Note"
              guidance={FREEFORM_GUIDANCE}
              value={value.content}
              minRows={14}
              maxLength={MAX_CONTENT_CHARS}
              readOnly={locked}
              onChange={(content) => editText({ content })}
              onBlur={saveNow}
              suggestion={suggestionFor('the note', proposal?.content ?? '', proposal ? proposalApplied(value, proposal) : false, () =>
                proposal && applyText(applyProposalAll(format, proposal)),
              )}
            />
          ) : (
            format.sections.map((section) => (
              <SectionField
                key={section.id}
                label={section.label}
                guidance={section.guidance}
                value={value.sections[section.id] ?? ''}
                minRows={3}
                maxLength={MAX_SECTION_CHARS}
                readOnly={locked}
                onChange={(text) => editText({ sections: { ...saver.getSnapshot().value.sections, [section.id]: text } })}
                onBlur={saveNow}
                suggestion={suggestionFor(
                  section.label,
                  proposal?.sections[section.id] ?? '',
                  proposal ? proposalApplied(value, proposal, section.id) : false,
                  () => proposal && applyText(applyProposalSection(value, proposal, section.id)),
                )}
              />
            ))
          )}
        </Card>
        <p className="text-xs text-sage-500">Drafts save automatically. Press Ctrl/⌘ + S to save right away.</p>
      </div>

      <ConfirmDialog
        open={confirmSign}
        title="Sign this note?"
        confirmLabel="Sign and lock"
        loading={sign.isPending}
        onConfirm={() => sign.mutate()}
        onCancel={() => setConfirmSign(false)}
        message={
          <div className="space-y-2">
            <p>Signing locks this note. Session audio and transcript linked to it will be deleted.</p>
            {supervisor && <p>It then goes to {supervisor.display_name} to co-sign.</p>}
            {value.risk_flags.length > 0 && (
              <p className="font-medium text-red-700">This note has AI safety flags. Make sure you've reviewed them.</p>
            )}
            <p className="text-sage-600">You can unlock it later to make an amendment.</p>
          </div>
        }
      />
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this draft?"
        confirmLabel="Delete draft"
        danger
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setConfirmDelete(false)}
        message="The draft and its text will be permanently deleted. This can't be undone."
      />
      <ConfirmDialog
        open={confirmReplace}
        title="Replace your note with the AI draft?"
        confirmLabel="Replace all"
        onConfirm={() => {
          if (proposal) applyText(applyProposalAll(format, proposal));
          setConfirmReplace(false);
        }}
        onCancel={() => setConfirmReplace(false)}
        message={`${isFreeform(format) ? 'Your note text' : 'Every section'} will be replaced with the AI draft. You can undo this right after.`}
      />
      <ConfirmDialog
        open={pendingFormat !== null}
        title={`Switch to ${pendingFormat?.format.name ?? ''}?`}
        confirmLabel="Switch format"
        onConfirm={() => {
          if (pendingFormat) editText({ format: pendingFormat.format.id, ...pendingFormat.text });
          setPendingFormat(null);
        }}
        onCancel={() => setPendingFormat(null)}
        message={
          <div className="space-y-2">
            <p>Nothing will be lost. Text without a matching section moves, labeled with its old heading:</p>
            <ul className="list-disc space-y-0.5 pl-5">
              {moveSummary(pendingFormat?.moves ?? []).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="text-sage-600">Review the moved text afterwards.</p>
          </div>
        }
      />
    </div>
  );
}
