import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileDown, Hourglass, Lock, Unlock } from 'lucide-react';
import { downloadFile } from '../../../api/client';
import {
  MAX_UNLOCK_REASON_CHARS,
  NOTE_TYPE_LABELS,
  PSYCHOTHERAPY_NOTE_BADGE,
  PSYCHOTHERAPY_NOTE_HELP,
  noteKeys,
  notesApi,
  type Note,
  type NoteFormat,
} from '../../../api/notes';
import type { TeamMember } from '../../../api/team';
import { useSession } from '../../../auth/StaffAuth';
import { formatDateTime } from '../../../lib/format';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { Alert } from '../../../ui/Display';
import { ReasonDialog } from '../../../ui/ReasonDialog';
import { useToast } from '../../../ui/Toast';
import { useTeam } from '../hooks';
import { isFreeform } from '../noteText';
import { CosignActions } from './CosignActions';
import { AiDraftBadge, IntegrityBadge } from './NoteBadges';
import { EditorToolbar } from './EditorToolbar';
import { NoteAddenda } from './NoteAddenda';
import { NoteHistory } from './NoteHistory';
import { NoteMeta, RiskFlagsAlert, SessionNotesLink } from './NoteMeta';

function NoteBlock({ label, text }: { label?: string; text: string }) {
  return (
    <div className="px-4 py-4 sm:px-5">
      {label && <h2 className="mb-1.5 text-sm font-semibold text-sage-900">{label}</h2>}
      {text.trim() ? (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-sage-800">{text}</p>
      ) : (
        <p className="text-sm italic text-sage-400">Not documented</p>
      )}
    </div>
  );
}

/** The author's signature and the supervisor's co-signature (or that it's still awaited). */
function Signatures({ note, timeZone }: { note: Note; timeZone: string }) {
  if (!note.signed_at || note.status === 'draft') return null;
  return (
    <Card className="px-4 py-3 sm:px-5">
      <h2 className="text-sm font-semibold text-sage-900">Signatures</h2>
      <dl className="mt-2 space-y-1.5 text-sm">
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-sage-600">Signed by</dt>
          <dd className="text-sage-900">
            {note.author.name} · {formatDateTime(note.signed_at, timeZone)}
          </dd>
        </div>
        {note.supervisor && (
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-sage-600">Co-signed by</dt>
            <dd className="text-sage-900">
              {note.supervisor.name} ·{' '}
              {note.cosigned_at ? formatDateTime(note.cosigned_at, timeZone) : <em className="text-sage-500">awaiting co-signature</em>}
            </dd>
          </div>
        )}
      </dl>
    </Card>
  );
}

/** What this note is and what the viewer may do with it, above its text. */
function StatusBanner({
  note,
  timeZone,
  isAuthor,
  canResign,
}: {
  note: Note;
  timeZone: string;
  isAuthor: boolean;
  canResign: boolean;
}) {
  const { staff } = useSession();
  const signedOn = note.signed_at ? formatDateTime(note.signed_at, timeZone) : '';
  const supervisor = note.supervisor?.name ?? 'the supervisor';

  if (!isAuthor) {
    const detail: Record<Note['status'], ReactNode> = {
      draft: `This draft isn't signed yet. Only ${note.author.name} can edit or sign it.`,
      pending_cosign:
        note.supervisor?.id === staff.id
          ? `Signed on ${signedOn} and waiting for your co-signature. Co-sign it, or request changes to send it back as a draft.`
          : `Signed on ${signedOn} and waiting for ${supervisor}'s co-signature.`,
      signed: `This note is part of the clinical record. Only ${note.author.name} can amend it.`,
    };
    return (
      <Alert tone={note.status === 'signed' ? 'success' : 'info'} title={`Written by ${note.author.name}`}>
        {detail[note.status]}
      </Alert>
    );
  }
  if (note.status === 'pending_cosign') {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900" role="status">
        <Hourglass className="mt-0.5 h-4 w-4 shrink-0 text-sky-700" aria-hidden="true" />
        <div>
          <p className="font-semibold">Waiting for {supervisor}&apos;s co-signature</p>
          <p className="mt-0.5 text-sky-800">
            {canResign
              ? `${supervisor} is no longer your supervisor, so this note can't be co-signed. Unlock it and sign it again.`
              : `You signed this note on ${signedOn}. It stays locked until ${supervisor} co-signs it or sends it back with comments.`}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900" role="status">
      <Lock className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" aria-hidden="true" />
      <div>
        <p className="font-semibold">
          {note.cosigned_at ? 'Signed and co-signed' : 'Signed'} {signedOn} · Locked
        </p>
        <p className="mt-0.5 text-emerald-800">This note is part of the clinical record. Unlock it to make an amendment.</p>
      </div>
    </div>
  );
}

/**
 * Read-only view of a note: someone else's (at any stage), or your own once it's signed or
 * waiting for co-signature. Authors can unlock signed notes to amend them; the supervisor asked
 * to co-sign gets Co-sign and Request changes.
 */
export function NoteView({ note, format }: { note: Note; format: NoteFormat }) {
  const { staff } = useSession();
  const team = useTeam();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [confirmUnlock, setConfirmUnlock] = useState(false);
  const timeZone = staff.time_zone;

  const isAuthor = note.author.id === staff.id;
  const awaitingMe = note.status === 'pending_cosign' && note.supervisor?.id === staff.id;
  // A note waiting for co-signature stays locked for its author while the supervisor asked is
  // still their active supervisor; otherwise they unlock it and sign it again.
  const supervisorId = note.supervisor?.id;
  const supervisorActive =
    supervisorId === staff.supervisor_id &&
    (team.data?.some((member) => member.id === supervisorId && member.status === 'active') ?? true);
  const canResign = isAuthor && note.status === 'pending_cosign' && !supervisorActive;
  const canUnlock = isAuthor && (note.status === 'signed' || canResign);
  const canAddAddendum = mayAddAddendum(note, staff.id, team.data);

  const unlock = useMutation({
    mutationFn: (reason: string) => notesApi.unlock(note.id, reason),
    onSuccess: (unlocked) => {
      setConfirmUnlock(false);
      queryClient.setQueryData(noteKeys.detail(note.id), unlocked);
      void queryClient.invalidateQueries({ queryKey: noteKeys.lists });
      void queryClient.invalidateQueries({ queryKey: noteKeys.backlog });
      toast.success('Note unlocked. Sign it again when your amendment is done.');
    },
    onError: (error) => {
      setConfirmUnlock(false);
      toast.error(error);
    },
  });

  return (
    <div>
      <EditorToolbar>
        <Button
          variant="secondary"
          icon={<FileDown className="h-4 w-4" />}
          onClick={() => void downloadFile(`/notes/${note.id}/pdf`).catch((error: unknown) => toast.error(error))}
        >
          Download PDF
        </Button>
        {canUnlock && (
          <Button variant="secondary" icon={<Unlock className="h-4 w-4" />} onClick={() => setConfirmUnlock(true)}>
            {canResign ? 'Unlock to sign again' : 'Unlock to amend'}
          </Button>
        )}
        {awaitingMe && <CosignActions note={note} />}
      </EditorToolbar>

      <div className="space-y-5">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight text-sage-900">{note.title || 'Untitled note'}</h1>
          <NoteMeta client={note.client} appointmentId={note.appointment_id} timeZone={timeZone}>
            <span>{NOTE_TYPE_LABELS[note.note_type]}</span>
            <span>{format.name}</span>
            {note.ai_generated && <AiDraftBadge />}
            <IntegrityBadge integrity={note.integrity} />
            <SessionNotesLink note={note} />
          </NoteMeta>
        </header>

        {note.note_type === 'psychotherapy' && (
          <Alert tone="info" title={PSYCHOTHERAPY_NOTE_BADGE}>
            {PSYCHOTHERAPY_NOTE_HELP}
          </Alert>
        )}
        {note.integrity === 'mismatch' && (
          <Alert tone="danger" title="Integrity check failed">
            This note&apos;s text no longer matches the hash taken when it was signed, so it may have been changed
            outside Synari. The practice owners have been alerted. Compare it with the signed versions below.
          </Alert>
        )}
        <StatusBanner note={note} timeZone={timeZone} isAuthor={isAuthor} canResign={canResign} />
        {note.supervisor_comment && note.status !== 'signed' && (
          <Alert
            tone="warning"
            title={
              note.status === 'draft'
                ? `${note.supervisor?.name ?? 'The supervisor'} asked for changes`
                : `Earlier request from ${note.supervisor?.name ?? 'the supervisor'}`
            }
          >
            <p className="whitespace-pre-wrap">{note.supervisor_comment}</p>
          </Alert>
        )}

        <RiskFlagsAlert flags={note.risk_flags} title="AI flagged possible safety concerns while drafting" />

        <Card className="divide-y divide-sage-100">
          {isFreeform(format) ? (
            <NoteBlock text={note.content} />
          ) : (
            format.sections.map((section) => (
              <NoteBlock key={section.id} label={section.label} text={note.sections[section.id] ?? ''} />
            ))
          )}
        </Card>

        <Signatures note={note} timeZone={timeZone} />
        <NoteAddenda note={note} canAdd={canAddAddendum} timeZone={timeZone} />
        <NoteHistory noteId={note.id} count={note.revision_count} format={format} timeZone={timeZone} />
      </div>

      <ReasonDialog
        open={confirmUnlock}
        title="Unlock this note?"
        label="Reason for the change"
        hint="Saved with the next signed version, so the history shows why the note changed. Don't include more client information than needed."
        confirmLabel="Unlock"
        maxLength={MAX_UNLOCK_REASON_CHARS}
        loading={unlock.isPending}
        onSubmit={(reason) => unlock.mutate(reason)}
        onCancel={() => setConfirmUnlock(false)}
      >
        <div className="space-y-2 text-sm text-sage-700">
          <p>
            Unlocking returns the note to draft so you can amend it. It must be signed again (and co-signed, if you have
            a supervisor). The signed version is kept in the note&apos;s history.
          </p>
          <p className="text-sage-600">
            To add to the note without changing what was signed, add an addendum instead. The unlock is recorded in the
            audit log.
          </p>
        </div>
      </ReasonDialog>
    </div>
  );
}

/**
 * Addenda can be added to signed notes by their author, the supervisor asked to co-sign, or the
 * author's supervisor (the API enforces the same rule).
 */
export function mayAddAddendum(note: Note, staffId: number, team: TeamMember[] | undefined): boolean {
  if (note.status === 'draft') return false;
  if (note.author.id === staffId || note.supervisor?.id === staffId) return true;
  return team?.some((member) => member.id === note.author.id && member.supervisor_id === staffId) ?? false;
}
