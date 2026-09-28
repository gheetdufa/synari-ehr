import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { NOTE_TYPE_LABELS, type NoteFormat, type NoteSummary } from '../../../api/notes';
import { useSession } from '../../../auth/StaffAuth';
import { formatDate, fullName } from '../../../lib/format';
import {
  AiDraftBadge,
  IntegrityBadge,
  NoteStatusBadge,
  PsychotherapyBadge,
  RiskBadge,
  SessionSizeBadge,
} from './NoteBadges';

/** "Alex Rivera · Oct 5, 2026 · Progress note · SOAP · by Jordan Lee, LCSW" (the author only when it isn't me). */
export function noteDetails(
  note: NoteSummary,
  formats: NoteFormat[] | undefined,
  timeZone: string,
  { showClient, viewerId }: { showClient: boolean; viewerId: number },
): string {
  const formatName = formats?.find((format) => format.id === note.format)?.name ?? note.format;
  return [
    showClient ? fullName(note.client) : null,
    formatDate(note.appointment_starts_at ?? note.created_at, timeZone),
    NOTE_TYPE_LABELS[note.note_type],
    formatName,
    note.author.id === viewerId ? null : `by ${note.author.name}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** One note in a list: title, client, date, type, format and author, with status badges. Opens the note. */
export function NoteRow({
  note,
  formats,
  timeZone,
  showClient = true,
}: {
  note: NoteSummary;
  formats: NoteFormat[] | undefined;
  timeZone: string;
  showClient?: boolean;
}) {
  const { staff } = useSession();
  return (
    <li>
      <Link
        to={`/portal/notes/${note.id}`}
        className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-sage-50 focus:outline-none focus-visible:bg-primary-50 sm:px-5"
      >
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-sage-900 group-hover:text-primary-800">{note.title || 'Untitled note'}</p>
          <p className="mt-0.5 truncate text-sm text-sage-600">
            {noteDetails(note, formats, timeZone, { showClient, viewerId: staff.id })}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <NoteStatusBadge note={note} timeZone={timeZone} />
            <IntegrityBadge integrity={note.integrity} quiet />
            <PsychotherapyBadge note={note} />
            {note.ai_generated && <AiDraftBadge />}
            <RiskBadge note={note} />
            <SessionSizeBadge note={note} />
          </div>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-sage-400 group-hover:text-primary-600" aria-hidden="true" />
      </Link>
    </li>
  );
}

export function NoteList({
  notes,
  formats,
  timeZone,
  showClient = true,
  label,
}: {
  notes: NoteSummary[];
  formats: NoteFormat[] | undefined;
  timeZone: string;
  showClient?: boolean;
  label: string;
}) {
  return (
    <ul className="divide-y divide-sage-100" aria-label={label}>
      {notes.map((note) => (
        <NoteRow key={note.id} note={note} formats={formats} timeZone={timeZone} showClient={showClient} />
      ))}
    </ul>
  );
}
