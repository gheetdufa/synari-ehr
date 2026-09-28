import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarX2, CheckCheck, ChevronDown, FilePen } from 'lucide-react';
import { appointmentKeys, appointmentsApi } from '../../../api/appointments';
import { MAX_PAGE_SIZE } from '../../../api/client';
import { noteKeys, notesApi, type NoteFormat } from '../../../api/notes';
import { useSession } from '../../../auth/StaffAuth';
import { formatDateTime } from '../../../lib/format';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { Spinner } from '../../../ui/Spinner';
import { NoteList } from './NoteList';

const DRAFT_PREVIEW = 3;
const BACKLOG_DAYS = 30;

function backlogRange(): { start: string; end: string } {
  const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  return { start: new Date(hour - BACKLOG_DAYS * 86_400_000).toISOString(), end: new Date(hour + 3_600_000).toISOString() };
}

/**
 * My attended sessions from the last 30 days that have no note from me yet, each with "Write note"
 * (or, for a session with several clients, a way to its notes).
 */
function MissingNotesList({
  timeZone,
  onWrite,
  onOpenSession,
}: {
  timeZone: string;
  onWrite: (clientId: number, appointmentId: number) => void;
  onOpenSession: (appointmentId: number) => void;
}) {
  const { staff } = useSession();
  const [range] = useState(backlogRange);
  const appointments = useQuery({
    queryKey: appointmentKeys.range(range.start, range.end),
    queryFn: () => appointmentsApi.list({ start: range.start, end: range.end, include_canceled: false }),
  });
  const myNotes = { author_id: staff.id, limit: MAX_PAGE_SIZE };
  const notes = useQuery({
    queryKey: noteKeys.list(myNotes),
    queryFn: () => notesApi.list(myNotes),
    select: (page) => page.items,
  });

  if (appointments.isLoading || notes.isLoading) {
    return (
      <p className="flex items-center gap-2 px-4 py-3 text-sm text-sage-600 sm:px-5">
        <Spinner className="h-4 w-4" /> Finding sessions…
      </p>
    );
  }
  if (appointments.error || notes.error) {
    return <p className="px-4 py-3 text-sm text-red-700 sm:px-5">Couldn't load sessions. Try again later.</p>;
  }
  const documented = new Set((notes.data ?? []).map((note) => note.appointment_id));
  const missing = (appointments.data ?? [])
    .filter(
      (item) =>
        item.kind === 'appointment' &&
        item.status === 'attended' &&
        item.clinician.id === staff.id &&
        item.participants.length > 0 &&
        !documented.has(item.id),
    )
    .sort((a, b) => b.starts_at.localeCompare(a.starts_at));
  if (missing.length === 0) {
    return <p className="px-4 py-3 text-sm text-sage-600 sm:px-5">Every attended session has a note.</p>;
  }
  return (
    <ul className="divide-y divide-sage-100" aria-label="Sessions without notes">
      {missing.map((appointment) => {
        const [only, ...others] = appointment.participants;
        return (
          <li key={appointment.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 sm:px-5">
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium text-sage-900">{appointment.title_label}</p>
              <p className="text-sage-600">
                {formatDateTime(appointment.starts_at, timeZone)}
                {appointment.service_description ? ` · ${appointment.service_description}` : ''}
              </p>
            </div>
            {others.length === 0 ? (
              <Button size="sm" variant="secondary" onClick={() => onWrite(only.client.id, appointment.id)}>
                Write note
              </Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => onOpenSession(appointment.id)}>
                Write notes
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** My unsigned drafts, notes waiting for my co-signature and my undocumented sessions, at the top of the notes list. */
export function NeedsAttention({
  formats,
  timeZone,
  showDrafts,
  showCosign,
  onShowAllDrafts,
  onOpenCosignQueue,
  onWrite,
  onOpenSession,
}: {
  formats: NoteFormat[] | undefined;
  timeZone: string;
  showDrafts: boolean;
  showCosign: boolean;
  onShowAllDrafts: () => void;
  onOpenCosignQueue: () => void;
  onWrite: (clientId: number, appointmentId: number) => void;
  onOpenSession: (appointmentId: number) => void;
}) {
  const { staff } = useSession();
  const [expanded, setExpanded] = useState(false);
  const myDrafts = { status: 'draft', author_id: staff.id } as const;
  const drafts = useQuery({
    queryKey: noteKeys.list(myDrafts),
    queryFn: () => notesApi.list(myDrafts),
    select: (page) => page.items,
  });
  const backlog = useQuery({ queryKey: noteKeys.backlog, queryFn: notesApi.backlog });

  const draftNotes = drafts.data ?? [];
  const draftCount = backlog.data?.draft_notes ?? draftNotes.length;
  const missingCount = backlog.data?.appointments_missing_notes ?? 0;
  const cosignCount = showCosign ? (backlog.data?.notes_awaiting_cosign ?? 0) : 0;
  const listDrafts = showDrafts && draftNotes.length > 0;
  if (!listDrafts && missingCount === 0 && cosignCount === 0) return null;

  return (
    <Card className="mb-6 overflow-hidden border-amber-200">
      <h2 className="border-b border-amber-100 bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-900 sm:px-5">Needs attention</h2>
      {cosignCount > 0 && (
        <section aria-label="Notes to co-sign" className="flex flex-wrap items-center gap-2 border-b border-sage-100 px-4 py-3 text-sm text-sage-700 last:border-b-0 sm:px-5">
          <CheckCheck className="h-4 w-4 text-amber-600" aria-hidden="true" />
          <span className="flex-1">
            {cosignCount === 1 ? '1 note is' : `${cosignCount} notes are`} waiting for your co-signature.
          </span>
          <Button size="sm" variant="secondary" onClick={onOpenCosignQueue}>
            Open co-sign queue
          </Button>
        </section>
      )}
      {listDrafts && (
        <section aria-label="Unsigned drafts" className="border-b border-sage-100 last:border-b-0">
          <div className="flex flex-wrap items-center gap-2 px-4 pt-3 text-sm text-sage-700 sm:px-5">
            <FilePen className="h-4 w-4 text-amber-600" aria-hidden="true" />
            <span className="flex-1">
              {draftCount === 1 ? '1 draft note is' : `${draftCount} draft notes are`} waiting to be signed.
            </span>
            {draftCount > DRAFT_PREVIEW && (
              <Button size="sm" variant="ghost" onClick={onShowAllDrafts}>
                View all drafts
              </Button>
            )}
          </div>
          <NoteList notes={draftNotes.slice(0, DRAFT_PREVIEW)} formats={formats} timeZone={timeZone} label="Drafts to finish" />
        </section>
      )}
      {missingCount > 0 && (
        <section aria-label="Sessions without notes">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm text-sage-700 hover:bg-sage-50 sm:px-5"
          >
            <CalendarX2 className="h-4 w-4 text-amber-600" aria-hidden="true" />
            <span className="flex-1">
              {missingCount === 1 ? '1 attended session' : `${missingCount} attended sessions`} from the last 30 days{' '}
              {missingCount === 1 ? 'has' : 'have'} no note.
            </span>
            <span className="font-medium text-primary-700">{expanded ? 'Hide' : 'Show'}</span>
            <ChevronDown className={`h-4 w-4 text-sage-500 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
          {expanded && (
            <div className="border-t border-sage-100">
              <MissingNotesList timeZone={timeZone} onWrite={onWrite} onOpenSession={onOpenSession} />
            </div>
          )}
        </section>
      )}
    </Card>
  );
}
