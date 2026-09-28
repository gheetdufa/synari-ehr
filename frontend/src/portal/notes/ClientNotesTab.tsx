import { useQuery } from '@tanstack/react-query';
import { FileText, Plus } from 'lucide-react';
import { noteKeys, notesApi } from '../../api/notes';
import { useSession } from '../../auth/StaffAuth';
import { usePagedQuery } from '../../lib/paging';
import { LinkButton } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { EmptyState, ErrorState } from '../../ui/Display';
import { LoadMore } from '../../ui/LoadMore';
import { SectionSpinner } from '../../ui/Spinner';
import { NoteList } from './components/NoteList';
import { useNoteFormats, useNotesRealtime } from './hooks';

/** The Notes tab on a client's page: their notes, newest first, and a New note button. */
export default function ClientNotesTab({ clientId }: { clientId: number }) {
  const { staff } = useSession();
  useNotesRealtime();
  const formats = useNoteFormats();
  const notes = usePagedQuery({
    queryKey: noteKeys.pages({ client_id: clientId }),
    fetchPage: (page) => notesApi.list({ client_id: clientId, ...page }),
  });
  // Only the count of unsigned notes is needed, so ask for the smallest page.
  const draftParams = { client_id: clientId, status: 'draft', limit: 1 } as const;
  const drafts = useQuery({
    queryKey: noteKeys.list(draftParams),
    queryFn: () => notesApi.list(draftParams),
    select: (page) => page.total,
  });
  const newNote = staff.is_clinician ? (
    <LinkButton to={`/portal/notes?new=1&client=${clientId}`} size="sm" icon={<Plus className="h-4 w-4" />}>
      New note
    </LinkButton>
  ) : undefined;
  const unsigned = drafts.data ?? 0;

  return (
    <Card>
      <CardHeader
        title="Notes"
        description={
          notes.total > 0
            ? `${notes.total} note${notes.total === 1 ? '' : 's'}${unsigned ? ` · ${unsigned} unsigned` : ''}`
            : undefined
        }
        actions={newNote}
      />
      {notes.isLoading ? (
        <SectionSpinner />
      ) : notes.isError && !notes.data ? (
        <ErrorState error={notes.error} onRetry={() => void notes.refetch()} />
      ) : notes.items.length === 0 ? (
        <EmptyState
          icon={<FileText />}
          title="No notes yet"
          description={staff.is_clinician ? 'Notes you write for this client appear here.' : 'Notes about this client appear here.'}
          action={newNote}
        />
      ) : (
        <>
          <NoteList notes={notes.items} formats={formats.data} timeZone={staff.time_zone} showClient={false} label="Client notes" />
          <LoadMore noun="notes" {...notes.loadMore} />
        </>
      )}
    </Card>
  );
}
