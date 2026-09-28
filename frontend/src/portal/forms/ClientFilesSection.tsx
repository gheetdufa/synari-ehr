import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileText, FolderOpen, Lock, Upload, XCircle } from 'lucide-react';
import type { ClientDetail } from '../../api/clients';
import { PSYCHOTHERAPY_NOTES_CATEGORY, fileKeys, filesApi, type StoredFile } from '../../api/files';
import { teamApi, teamKeys, type TeamMember } from '../../api/team';
import { useSession } from '../../auth/StaffAuth';
import { formatBytes, formatDate } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Badge, EmptyState, ErrorState } from '../../ui/Display';
import { Select } from '../../ui/Form';
import { ConfirmDialog } from '../../ui/Modal';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import { ShareDocumentModal } from './ShareDocumentModal';

/** Who put a file on the record: "you", a team member's name, or the client portal. */
export function uploaderLabel(file: StoredFile, staffId: number, team: TeamMember[] | undefined): string {
  if (file.purpose === 'imported_document') return 'Imported from SimplePractice';
  if (file.uploaded_by === 'client') return 'Uploaded from the client portal';
  if (file.uploaded_by_staff_id === staffId) return 'Uploaded by you';
  const member = team?.find((candidate) => candidate.id === file.uploaded_by_staff_id);
  return `Uploaded by ${member?.display_name ?? 'a team member'}`;
}

/** Filter value for files that weren't imported (shared documents and client uploads). */
const NOT_IMPORTED = '__not_imported__';

/** The source folders of a client's imported documents, in a stable order. */
export function importedCategories(files: StoredFile[]): string[] {
  const categories = new Set(
    files.filter((file) => file.purpose === 'imported_document').map((file) => file.category || 'Imported'),
  );
  return [...categories].sort((a, b) => a.localeCompare(b));
}

function matchesFilter(file: StoredFile, filter: string): boolean {
  if (!filter) return true;
  if (filter === NOT_IMPORTED) return file.purpose !== 'imported_document';
  return file.purpose === 'imported_document' && (file.category || 'Imported') === filter;
}

/** The badge for an imported document: its source folder, and who can see psychotherapy notes. */
function ImportedBadge({ file }: { file: StoredFile }) {
  if (file.category === PSYCHOTHERAPY_NOTES_CATEGORY) {
    return (
      <Badge tone="warning">
        <Lock aria-hidden="true" className="h-3 w-3" />
        Psychotherapy note · only you can see it
      </Badge>
    );
  }
  return <Badge tone="primary">Imported · {file.category || 'Documents'}</Badge>;
}

/**
 * Documents shared with the client and files uploaded from their portal (part of the clinical
 * record; the chart tab shows this section only to staff with clinical access).
 */
export function ClientFilesSection({ client, timeZone }: { client: ClientDetail; timeZone: string }) {
  const { staff } = useSession();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [unsharing, setUnsharing] = useState<StoredFile | null>(null);
  const [downloading, setDownloading] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const files = useQuery({ queryKey: fileKeys.forClient(client.id), queryFn: () => filesApi.forClient(client.id) });
  const team = useQuery({ queryKey: teamKeys.members, queryFn: teamApi.list });

  const stopSharing = useMutation({
    mutationFn: (file: StoredFile) => filesApi.stopSharing(file.id),
    onSuccess: (_, file) => {
      toast.success(`${file.filename} is no longer shared`);
      setUnsharing(null);
      void queryClient.invalidateQueries({ queryKey: fileKeys.forClient(client.id) });
    },
    onError: (error) => toast.error(error),
  });

  const download = async (file: StoredFile) => {
    setDownloading(file.id);
    try {
      await filesApi.download(file);
    } catch (error) {
      toast.error(error);
    } finally {
      setDownloading(null);
    }
  };

  const all = useMemo(() => files.data ?? [], [files.data]);
  const categories = useMemo(() => importedCategories(all), [all]);
  const list = all.filter((file) => matchesFilter(file, filter));
  return (
    <Card>
      <CardHeader
        title="Files"
        description="Documents shared with the client and files uploaded from their portal"
        actions={
          <Button size="sm" variant="secondary" icon={<Upload className="h-4 w-4" />} onClick={() => setUploadOpen(true)}>
            Share a document
          </Button>
        }
      />
      {files.isPending && <SectionSpinner />}
      {files.error && <ErrorState error={files.error} onRetry={() => void files.refetch()} />}
      {categories.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-sage-100 px-5 py-3">
          <label htmlFor={`file-filter-${client.id}`} className="text-sm font-medium text-sage-700">
            Show
          </label>
          <Select
            id={`file-filter-${client.id}`}
            className="w-auto"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="">All files</option>
            <option value={NOT_IMPORTED}>Shared and uploaded files</option>
            {categories.map((category) => (
              <option key={category} value={category}>
                Imported: {category}
              </option>
            ))}
          </Select>
        </div>
      )}
      {files.data && all.length === 0 && (
        <EmptyState
          icon={<FolderOpen />}
          title="No files yet"
          description="Share documents such as your Notice of Privacy Practices. Files the client uploads, like an insurance card, appear here too."
        />
      )}
      {list.length > 0 && (
        <ul className="divide-y divide-sage-100">
          {list.map((file) => {
            const imported = file.purpose === 'imported_document';
            const fromClient = !imported && file.uploaded_by === 'client';
            const shared = file.purpose === 'shared_document' && file.shared_with_client;
            return (
              <li key={file.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <FileText aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-primary-700" />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate font-medium text-sage-900">{file.filename}</p>
                      {imported ? (
                        <ImportedBadge file={file} />
                      ) : fromClient ? (
                        <Badge tone="info">From client</Badge>
                      ) : shared ? (
                        <Badge tone="success">Shared</Badge>
                      ) : (
                        <Badge>Not shared</Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-sm text-sage-600">
                      {formatBytes(file.size_bytes)} · {uploaderLabel(file, staff.id, team.data)} on{' '}
                      {formatDate(file.created_at, timeZone)}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 pl-8 sm:pl-0">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Download className="h-4 w-4" />}
                    loading={downloading === file.id}
                    onClick={() => void download(file)}
                    aria-label={`Download ${file.filename}`}
                  >
                    Download
                  </Button>
                  {shared && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<XCircle className="h-4 w-4" />}
                      onClick={() => setUnsharing(file)}
                      aria-label={`Stop sharing ${file.filename}`}
                    >
                      Stop sharing
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {uploadOpen && <ShareDocumentModal client={client} onClose={() => setUploadOpen(false)} />}
      <ConfirmDialog
        open={unsharing !== null}
        title="Stop sharing this document?"
        message={`${unsharing?.filename ?? 'The document'} will be removed from the client's portal. It stays in their record here.`}
        confirmLabel="Stop sharing"
        danger
        loading={stopSharing.isPending}
        onCancel={() => setUnsharing(null)}
        onConfirm={() => unsharing && stopSharing.mutate(unsharing)}
      />
    </Card>
  );
}
