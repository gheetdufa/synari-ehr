import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { FileQuestion } from 'lucide-react';
import { ApiError } from '../../api/client';
import { noteKeys, notesApi } from '../../api/notes';
import { useSession } from '../../auth/StaffAuth';
import { LinkButton } from '../../ui/Button';
import { EmptyState, ErrorState } from '../../ui/Display';
import { SectionSpinner } from '../../ui/Spinner';
import { DraftNoteEditor } from './components/DraftNoteEditor';
import { NoteView } from './components/NoteView';
import { findFormat, useNoteFormats } from './hooks';

function NoteNotFound() {
  return (
    <EmptyState
      icon={<FileQuestion />}
      title="Note not found"
      description="It may have been deleted, or the link is wrong."
      action={<LinkButton to="/portal/notes">Back to notes</LinkButton>}
    />
  );
}

/**
 * /portal/notes/:noteId — the editor for your own draft; otherwise the read-only view (your note
 * once it's signed or waiting for co-signature, or anyone else's note).
 */
export default function NoteEditorPage() {
  const { staff } = useSession();
  const { noteId } = useParams();
  const id = Number(noteId);
  const valid = Number.isInteger(id) && id > 0;

  // Every read of a note is audited, so don't refetch it just because the window regained focus.
  const note = useQuery({
    queryKey: noteKeys.detail(id),
    queryFn: () => notesApi.get(id),
    enabled: valid,
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
  });
  const formats = useNoteFormats();

  if (!valid || (note.error instanceof ApiError && note.error.status === 404)) return <NoteNotFound />;
  if (note.error) return <ErrorState error={note.error} onRetry={() => void note.refetch()} />;
  if (formats.error) return <ErrorState error={formats.error} onRetry={() => void formats.refetch()} />;
  if (!note.data || !formats.data) return <SectionSpinner />;

  const format = findFormat(formats.data, note.data.format);
  if (!format) return <ErrorState error={new Error('This note uses a format this app doesn’t recognize.')} />;

  if (note.data.status === 'draft' && note.data.author.id === staff.id) {
    return <DraftNoteEditor key={note.data.id} note={note.data} formats={formats.data} />;
  }
  return <NoteView note={note.data} format={format} />;
}
