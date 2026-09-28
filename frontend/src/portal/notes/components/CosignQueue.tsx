import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CheckCheck } from 'lucide-react';
import { noteKeys, notesApi, type NoteFormat } from '../../../api/notes';
import { useSession } from '../../../auth/StaffAuth';
import { formatDateTime } from '../../../lib/format';
import { EmptyState, ErrorState } from '../../../ui/Display';
import { SectionSpinner } from '../../../ui/Spinner';
import { CosignActions } from './CosignActions';
import { AiDraftBadge, RiskBadge, SessionSizeBadge } from './NoteBadges';
import { noteDetails } from './NoteList';

/** Supervisees' signed notes waiting for my co-signature, oldest first, each with its actions. */
export function CosignQueue({ formats, timeZone }: { formats: NoteFormat[] | undefined; timeZone: string }) {
  const { staff } = useSession();
  const queue = useQuery({ queryKey: noteKeys.cosignQueue, queryFn: notesApi.cosignQueue });

  if (queue.isLoading) return <SectionSpinner />;
  if (queue.error) return <ErrorState error={queue.error} onRetry={() => void queue.refetch()} />;
  if (!queue.data || queue.data.length === 0) {
    return (
      <EmptyState
        icon={<CheckCheck />}
        title="Nothing to co-sign"
        description="Notes your supervisees sign appear here until you co-sign them or send them back."
      />
    );
  }
  return (
    <ul className="divide-y divide-sage-100" aria-label="Notes awaiting your co-signature">
      {queue.data.map((note) => (
        <li key={note.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:px-5">
          <div className="min-w-0 flex-1">
            <Link
              to={`/portal/notes/${note.id}`}
              className="block truncate font-medium text-sage-900 hover:text-primary-800 hover:underline"
            >
              {note.title || 'Untitled note'}
            </Link>
            <p className="mt-0.5 truncate text-sm text-sage-600">
              {noteDetails(note, formats, timeZone, { showClient: true, viewerId: staff.id })}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {note.signed_at && <span className="text-xs text-sage-500">Signed {formatDateTime(note.signed_at, timeZone)}</span>}
              {note.ai_generated && <AiDraftBadge />}
              <RiskBadge note={note} />
              <SessionSizeBadge note={note} />
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <CosignActions note={note} size="sm" />
          </div>
        </li>
      ))}
    </ul>
  );
}
