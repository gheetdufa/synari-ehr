import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FilePlus2 } from 'lucide-react';
import { MAX_ADDENDUM_CHARS, noteKeys, notesApi, type Note } from '../../../api/notes';
import { formatDateTime } from '../../../lib/format';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { Badge, ErrorState } from '../../../ui/Display';
import { Field, Textarea } from '../../../ui/Form';
import { SectionSpinner } from '../../../ui/Spinner';
import { useToast } from '../../../ui/Toast';
import { IntegrityBadge } from './NoteBadges';
import { shortHash } from './NoteHistory';

function AddAddendumForm({ note, onDone }: { note: Note; onDone: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: (content: string) => notesApi.addAddendum(note.id, content),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: noteKeys.addenda(note.id) });
      void queryClient.invalidateQueries({ queryKey: noteKeys.detail(note.id) });
      toast.success('Addendum added');
      onDone();
    },
    onError: (err) => toast.error(err),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const content = text.trim();
    if (!content) {
      setError('Write the addendum first');
      return;
    }
    add.mutate(content);
  };
  return (
    <form onSubmit={submit} noValidate aria-label="Add addendum" className="space-y-3 px-4 py-4 sm:px-5">
      <Field
        label="Addendum"
        required
        error={error}
        hint="Added below the signed note with your name and the time. The signed text isn't changed, and addenda can't be edited or removed."
      >
        {(props) => (
          <Textarea
            {...props}
            rows={4}
            maxLength={MAX_ADDENDUM_CHARS}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              if (error) setError(null);
            }}
          />
        )}
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={add.isPending}>
          Add addendum
        </Button>
      </div>
    </form>
  );
}

/**
 * Additions to a signed note that leave the signed text untouched (including accepted amendment
 * requests). The author and their supervisor may add one; the API enforces who.
 */
export function NoteAddenda({ note, canAdd, timeZone }: { note: Note; canAdd: boolean; timeZone: string }) {
  const [adding, setAdding] = useState(false);
  const signed = note.status !== 'draft';
  const addenda = useQuery({
    queryKey: noteKeys.addenda(note.id),
    queryFn: () => notesApi.addenda(note.id),
    enabled: note.addendum_count > 0,
    refetchOnWindowFocus: false,
  });
  if (!signed && note.addendum_count === 0) return null;
  if (note.addendum_count === 0 && !canAdd) return null;
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-sage-100 px-4 py-3 sm:px-5">
        <h2 className="text-sm font-semibold text-sage-900">Addenda</h2>
        {canAdd && signed && !adding && (
          <Button variant="secondary" size="sm" icon={<FilePlus2 className="h-4 w-4" />} onClick={() => setAdding(true)}>
            Add addendum
          </Button>
        )}
      </div>
      {note.addendum_count > 0 && addenda.isPending && <SectionSpinner />}
      {addenda.isError && <ErrorState error={addenda.error} onRetry={() => void addenda.refetch()} />}
      {addenda.data && addenda.data.length > 0 && (
        <ol className="divide-y divide-sage-100" aria-label="Addenda">
          {addenda.data.map((addendum) => (
            <li key={addendum.id} className="px-4 py-3 sm:px-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="text-sm text-sage-600">
                  {addendum.author.name} · {formatDateTime(addendum.created_at, timeZone)}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {addendum.amendment_request_id !== null && <Badge tone="info">Client amendment</Badge>}
                  <IntegrityBadge integrity={addendum.integrity} quiet />
                </div>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-sage-800">{addendum.content}</p>
              <p className="mt-1 text-xs text-sage-500">
                SHA-256{' '}
                <code className="font-mono" title={addendum.content_sha256}>
                  {shortHash(addendum.content_sha256)}
                </code>
              </p>
            </li>
          ))}
        </ol>
      )}
      {note.addendum_count === 0 && !adding && (
        <p className="px-4 py-3 text-sm text-sage-500 sm:px-5">
          Add to this signed note without unlocking it, for example a late entry or a correction.
        </p>
      )}
      {adding && <AddAddendumForm note={note} onDone={() => setAdding(false)} />}
    </Card>
  );
}
