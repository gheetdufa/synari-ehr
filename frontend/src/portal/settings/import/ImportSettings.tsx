import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Import } from 'lucide-react';
import { importKeys, importsApi } from '../../../api/imports';
import { useSession } from '../../../auth/StaffAuth';
import { formatDateTime } from '../../../lib/format';
import { useRealtimeEvent } from '../../../lib/realtime';
import { Button } from '../../../ui/Button';
import { Card, CardHeader } from '../../../ui/Card';
import { Badge, ErrorState, Table, Td, Th } from '../../../ui/Display';
import { SectionSpinner } from '../../../ui/Spinner';
import { useToast } from '../../../ui/Toast';
import { ImportGuide } from './ImportGuide';
import { FINAL_STATUSES, STATUS_LABELS, countLabel } from './importLogic';
import { ImportWizard } from './ImportWizard';
import { useStoreImportJob } from './useImportJob';

/** The `?import=` search parameter holding the open import's id. */
const IMPORT_PARAM = 'import';

/** Earlier imports, newest first, with a way to open or resume each. */
function PastImports({ onOpen }: { onOpen: (jobId: number) => void }) {
  const { staff } = useSession();
  const imports = useQuery({ queryKey: importKeys.list, queryFn: importsApi.list });
  if (imports.isPending) return <SectionSpinner />;
  if (imports.error) {
    return (
      <Card>
        <ErrorState error={imports.error} onRetry={() => void imports.refetch()} />
      </Card>
    );
  }
  if (imports.data.length === 0) return null;
  return (
    <Card>
      <CardHeader title="Your imports" />
      <Table>
        <thead>
          <tr>
            <Th>Started</Th>
            <Th>Status</Th>
            <Th>Files</Th>
            <Th>
              <span className="sr-only">Actions</span>
            </Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-sage-100">
          {imports.data.map((job) => {
            const status = STATUS_LABELS[job.status];
            const unfinished = !FINAL_STATUSES.includes(job.status);
            return (
              <tr key={job.id}>
                <Td>{formatDateTime(job.created_at, staff.time_zone)}</Td>
                <Td>
                  <Badge tone={status.tone}>{status.label}</Badge>
                </Td>
                <Td>{countLabel(job.file_count, 'file')}</Td>
                <Td className="text-right">
                  <Button
                    size="sm"
                    variant={unfinished ? 'primary' : 'secondary'}
                    onClick={() => onOpen(job.id)}
                    aria-label={`${unfinished ? 'Continue' : 'Open'} the import started ${formatDateTime(job.created_at, staff.time_zone)}`}
                  >
                    {unfinished ? 'Continue' : 'Open'}
                  </Button>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}

/**
 * Settings > Import from SimplePractice: what to download, earlier imports, and the step-by-step
 * wizard for the open import (kept in `?import=` so a reload or a notification link resumes it).
 */
export function ImportSettings() {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const store = useStoreImportJob();
  const jobId = Number(params.get(IMPORT_PARAM)) || null;

  const open = (id: number | null) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (id === null) next.delete(IMPORT_PARAM);
      else next.set(IMPORT_PARAM, String(id));
      return next;
    });

  useRealtimeEvent('import.updated', (event) => {
    void queryClient.invalidateQueries({ queryKey: importKeys.list });
    const updatedId = Number(event.data.import_id);
    if (updatedId) void queryClient.invalidateQueries({ queryKey: importKeys.detail(updatedId) });
  });

  const create = useMutation({
    mutationFn: importsApi.create,
    onSuccess: (job) => {
      store(job);
      open(job.id);
    },
    onError: (error) => toast.error(error),
  });

  if (jobId !== null) return <ImportWizard jobId={jobId} onBack={() => open(null)} />;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-sage-600">
          Move clients, contacts, insurance, past appointments, documents and balances from SimplePractice into
          Synari.
        </p>
        <Button icon={<Import className="h-4 w-4" />} loading={create.isPending} onClick={() => create.mutate()}>
          Start an import
        </Button>
      </div>
      <PastImports onOpen={open} />
      <ImportGuide />
    </div>
  );
}
