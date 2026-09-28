import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, History } from 'lucide-react';
import { noteKeys, notesApi, type NoteFormat, type NoteRevision } from '../../../api/notes';
import { formatDateTime } from '../../../lib/format';
import { Button } from '../../../ui/Button';
import { Card } from '../../../ui/Card';
import { ErrorState } from '../../../ui/Display';
import { SectionSpinner } from '../../../ui/Spinner';
import { isFreeform } from '../noteText';
import { IntegrityBadge } from './NoteBadges';

/** The first characters of a SHA-256 hash, enough to compare by eye. */
export function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

/** Section text of a version, labeled by the note's format (unknown sections keep their ids). */
function RevisionText({ revision, format }: { revision: NoteRevision; format: NoteFormat }) {
  if (isFreeform(format) || Object.keys(revision.sections).length === 0) {
    return <p className="whitespace-pre-wrap text-sm text-sage-800">{revision.content || 'No content.'}</p>;
  }
  const labels = new Map(format.sections.map((section) => [section.id, section.label]));
  return (
    <dl className="space-y-3">
      {Object.entries(revision.sections).map(([id, text]) => (
        <div key={id}>
          <dt className="text-sm font-semibold text-sage-900">{labels.get(id) ?? id}</dt>
          <dd className="whitespace-pre-wrap text-sm text-sage-800">{text.trim() || 'Not documented.'}</dd>
        </div>
      ))}
    </dl>
  );
}

function RevisionItem({ revision, format, timeZone }: { revision: NoteRevision; format: NoteFormat; timeZone: string }) {
  const [open, setOpen] = useState(false);
  const textId = `revision-${revision.id}-text`;
  return (
    <li className="px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 text-sm">
          <p className="font-medium text-sage-900">
            Version {revision.version}
            {revision.cosigned_by ? ' · co-signed' : ''}
          </p>
          <p className="text-sage-600">
            Signed by {revision.signed_by.name} · {formatDateTime(revision.signed_at, timeZone)}
          </p>
          {revision.cosigned_by && revision.cosigned_at && (
            <p className="text-sage-600">
              Co-signed by {revision.cosigned_by.name} · {formatDateTime(revision.cosigned_at, timeZone)}
            </p>
          )}
          {revision.reason && (
            <p className="mt-1 text-sage-700">
              <span className="font-medium">Reason for change:</span> {revision.reason}
            </p>
          )}
          <p className="mt-1 text-xs text-sage-500">
            SHA-256{' '}
            <code className="font-mono" title={revision.content_sha256}>
              {shortHash(revision.content_sha256)}
            </code>
          </p>
        </div>
        <IntegrityBadge integrity={revision.integrity} />
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="mt-1 -ml-2"
        aria-expanded={open}
        aria-controls={textId}
        icon={open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? 'Hide text' : 'Show text'}
      </Button>
      {open && (
        <div id={textId} className="mt-2 rounded-lg border border-sage-100 bg-sage-50/60 px-3 py-3">
          <p className="mb-2 font-medium text-sage-900">{revision.title || 'Untitled note'}</p>
          <RevisionText revision={revision} format={format} />
        </div>
      )}
    </li>
  );
}

/**
 * Every signed version of a note (each signature and co-signature keeps one). Loaded only when
 * opened, since viewing the history is recorded in the audit log.
 */
export function NoteHistory({
  noteId,
  count,
  format,
  timeZone,
}: {
  noteId: number;
  count: number;
  format: NoteFormat;
  timeZone: string;
}) {
  const [open, setOpen] = useState(false);
  const revisions = useQuery({
    queryKey: noteKeys.revisions(noteId),
    queryFn: () => notesApi.revisions(noteId),
    enabled: open,
    refetchOnWindowFocus: false,
  });
  if (count === 0) return null;
  const panelId = `note-${noteId}-history`;
  return (
    <Card>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold text-sage-900 hover:bg-sage-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 sm:px-5"
      >
        <History className="h-4 w-4 text-sage-500" aria-hidden="true" />
        Signed versions ({count})
        {open ? (
          <ChevronDown className="ml-auto h-4 w-4 text-sage-500" aria-hidden="true" />
        ) : (
          <ChevronRight className="ml-auto h-4 w-4 text-sage-500" aria-hidden="true" />
        )}
      </button>
      {open && (
        <div id={panelId} className="border-t border-sage-100">
          {revisions.isPending && <SectionSpinner />}
          {revisions.isError && <ErrorState error={revisions.error} onRetry={() => void revisions.refetch()} />}
          {revisions.data && (
            <ol className="divide-y divide-sage-100" aria-label="Signed versions">
              {revisions.data.map((revision) => (
                <RevisionItem key={revision.id} revision={revision} format={format} timeZone={timeZone} />
              ))}
            </ol>
          )}
        </div>
      )}
    </Card>
  );
}
