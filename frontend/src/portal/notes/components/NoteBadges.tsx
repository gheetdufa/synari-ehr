import {
  AlertTriangle,
  FileLock2,
  Hourglass,
  Lock,
  MessageSquareWarning,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Users,
} from 'lucide-react';
import { PSYCHOTHERAPY_NOTE_BADGE, RISK_LEVEL_LABELS, type Integrity, type NoteSummary } from '../../../api/notes';
import { formatDate } from '../../../lib/format';
import { Badge } from '../../../ui/Display';

/**
 * Where a note stands: Draft, Changes requested, Unlocked for amendment, Awaiting co-sign, or
 * Signed (and co-signed) with the date.
 */
export function NoteStatusBadge({ note, timeZone }: { note: NoteSummary; timeZone: string }) {
  if (note.status === 'signed' && note.signed_at) {
    return (
      <Badge tone="success">
        <Lock className="h-3 w-3" aria-hidden="true" />
        {note.cosigned_at ? 'Co-signed' : 'Signed'} {formatDate(note.cosigned_at ?? note.signed_at, timeZone)}
      </Badge>
    );
  }
  if (note.status === 'pending_cosign') {
    return (
      <Badge tone="info">
        <Hourglass className="h-3 w-3" aria-hidden="true" />
        Awaiting co-sign{note.supervisor ? ` · ${note.supervisor.name}` : ''}
      </Badge>
    );
  }
  if (note.supervisor_comment) {
    return (
      <Badge tone="danger">
        <MessageSquareWarning className="h-3 w-3" aria-hidden="true" />
        Changes requested
      </Badge>
    );
  }
  if (note.was_signed) return <Badge tone="warning">Unlocked for amendment</Badge>;
  return <Badge tone="warning">Draft</Badge>;
}

export function AiDraftBadge() {
  return (
    <Badge tone="primary">
      <Sparkles className="h-3 w-3" aria-hidden="true" />
      AI draft
    </Badge>
  );
}

/** Shown when the clinician recorded a risk level on the note. */
export function RiskBadge({ note }: { note: NoteSummary }) {
  if (note.risk_level === 'none') return null;
  return (
    <Badge tone={note.risk_level === 'high' ? 'danger' : note.risk_level === 'moderate' ? 'warning' : 'neutral'}>
      <AlertTriangle className="h-3 w-3" aria-hidden="true" />
      Risk: {RISK_LEVEL_LABELS[note.risk_level]}
    </Badge>
  );
}

/** Marks a psychotherapy note, which only its author (and supervisor, to co-sign) can read. */
export function PsychotherapyBadge({ note }: { note: Pick<NoteSummary, 'note_type'> }) {
  if (note.note_type !== 'psychotherapy') return null;
  return (
    <Badge tone="info">
      <FileLock2 className="h-3 w-3" aria-hidden="true" />
      {PSYCHOTHERAPY_NOTE_BADGE}
    </Badge>
  );
}

/**
 * Whether signed text still matches the hash taken when it was signed. `quiet` hides the
 * verified state (lists only call out problems).
 */
export function IntegrityBadge({ integrity, quiet = false }: { integrity: Integrity | null; quiet?: boolean }) {
  if (integrity === 'mismatch') {
    return (
      <Badge tone="danger">
        <ShieldAlert className="h-3 w-3" aria-hidden="true" />
        Integrity check failed
      </Badge>
    );
  }
  if (integrity !== 'verified' || quiet) return null;
  return (
    <Badge tone="success">
      <ShieldCheck className="h-3 w-3" aria-hidden="true" />
      Signature verified
    </Badge>
  );
}

/** Marks a note from a couples, family or group session (each client has their own note). */
export function SessionSizeBadge({ note }: { note: NoteSummary }) {
  if (note.appointment_participant_count < 2) return null;
  return (
    <Badge>
      <Users className="h-3 w-3" aria-hidden="true" />
      {note.appointment_participant_count}-client session
    </Badge>
  );
}
