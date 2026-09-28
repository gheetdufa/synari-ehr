import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, Check } from 'lucide-react';
import { importKeys, importsApi, type ImportJob, type ImportPreview, type ImportStatus } from '../../../api/imports';
import { Button } from '../../../ui/Button';
import { Card, CardBody } from '../../../ui/Card';
import { Alert, Badge, ErrorState } from '../../../ui/Display';
import { ConfirmDialog } from '../../../ui/Modal';
import { SectionSpinner } from '../../../ui/Spinner';
import { useToast } from '../../../ui/Toast';
import { BUSY_STATUSES, FINAL_STATUSES, STATUS_LABELS } from './importLogic';
import { AnalyzingCard, ImportProgress, ImportSummary, ResultTable, WarningList } from './ImportStatusCards';
import { ReviewStep } from './ReviewStep';
import { UploadStep } from './UploadStep';
import { useStoreImportJob } from './useImportJob';

/** How often a busy job is refetched in case a realtime update is missed. */
const POLL_MS = 3_000;

const STEPS = ['Upload files', 'Review', 'Import', 'Done'] as const;

function stepIndex(job: ImportJob): number {
  switch (job.status) {
    case 'uploaded':
    case 'analyzing':
      return 0;
    case 'ready':
      return 1;
    case 'importing':
      return 2;
    case 'failed':
      return job.started_at ? 2 : 0;
    case 'completed':
    case 'canceled':
      return 3;
  }
}

function Steps({ current }: { current: number }) {
  return (
    <ol className="flex flex-wrap gap-x-6 gap-y-2 text-sm" aria-label="Import steps">
      {STEPS.map((label, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={label} aria-current={active ? 'step' : undefined} className="flex items-center gap-2">
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                done ? 'bg-primary-600 text-white' : active ? 'bg-primary-100 text-primary-800' : 'bg-sage-100 text-sage-500'
              }`}
            >
              {done ? <Check aria-hidden="true" className="h-3.5 w-3.5" /> : index + 1}
            </span>
            <span className={active ? 'font-medium text-sage-900' : 'text-sage-600'}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function hasPreview(job: ImportJob): job is ImportJob & { preview: ImportPreview } {
  return job.preview !== null;
}

/** A failed analysis or import: what went wrong and how to carry on. */
function FailedState({ job, onRetry, retrying }: { job: ImportJob; onRetry: () => void; retrying: boolean }) {
  const duringImport = job.started_at !== null && hasPreview(job);
  return (
    <div className="space-y-6">
      <Alert tone="danger" title={duringImport ? 'The import stopped' : "We couldn't read your files"}>
        <p>{job.error || 'Something went wrong.'}</p>
        <p className="mt-1">
          {duringImport
            ? "Anything already imported stays, and trying again won't duplicate it."
            : 'Check the zip password, or remove the file and upload a fresh copy from SimplePractice, then analyze again.'}
        </p>
      </Alert>
      {duringImport && (
        <Card>
          {job.result && <ResultTable result={job.result} />}
          <CardBody className="flex justify-end border-t border-sage-100">
            <Button loading={retrying} onClick={onRetry}>
              Try the import again
            </Button>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

/** One import, shown as the step its status is at. */
export function ImportWizard({ jobId, onBack }: { jobId: number; onBack: () => void }) {
  const toast = useToast();
  const store = useStoreImportJob();
  const [cancelling, setCancelling] = useState(false);
  const job = useQuery({
    queryKey: importKeys.detail(jobId),
    queryFn: () => importsApi.get(jobId),
    refetchInterval: (query) => {
      const status: ImportStatus | undefined = query.state.data?.status;
      return status && BUSY_STATUSES.includes(status) ? POLL_MS : false;
    },
  });
  const kinds = useQuery({ queryKey: importKeys.kinds, queryFn: importsApi.kinds, staleTime: Infinity });

  const cancel = useMutation({
    mutationFn: () => importsApi.cancel(jobId),
    onSuccess: (updated) => {
      setCancelling(false);
      store(updated);
    },
    onError: (error) => {
      setCancelling(false);
      toast.error(error);
    },
  });
  const retry = useMutation({
    mutationFn: () => importsApi.start(jobId),
    onSuccess: store,
    onError: (error) => toast.error(error),
  });

  const back = (
    <Button variant="ghost" size="sm" icon={<ArrowLeft className="h-4 w-4" />} onClick={onBack}>
      All imports
    </Button>
  );
  if (job.isPending) return <SectionSpinner />;
  if (job.error) {
    return (
      <div className="space-y-4">
        {back}
        <Card>
          <ErrorState error={job.error} onRetry={() => void job.refetch()} />
        </Card>
      </div>
    );
  }

  const current = job.data;
  const status = STATUS_LABELS[current.status];
  const importing = current.status === 'importing';
  const canCancel = !FINAL_STATUSES.includes(current.status) && current.status !== 'analyzing';

  const body = () => {
    switch (current.status) {
      case 'uploaded':
        return <UploadStep job={current} kinds={kinds.data} />;
      case 'analyzing':
        return <AnalyzingCard />;
      case 'ready':
        return hasPreview(current) ? (
          <ReviewStep key={current.preview.analyzed_at} job={current} kinds={kinds.data} />
        ) : (
          <UploadStep job={current} kinds={kinds.data} />
        );
      case 'importing':
        return <ImportProgress job={current} />;
      case 'completed':
        return <ImportSummary job={current} />;
      case 'failed':
        return (
          <div className="space-y-6">
            <FailedState job={current} retrying={retry.isPending} onRetry={() => retry.mutate()} />
            {!(current.started_at && current.preview) && <UploadStep job={current} kinds={kinds.data} />}
          </div>
        );
      case 'canceled':
        return (
          <div className="space-y-6">
            <Alert tone="neutral" title="This import was canceled">
              Nothing more will be imported. Anything imported before it was canceled stays in Synari.
            </Alert>
            {current.result && (
              <Card>
                <ResultTable result={current.result} />
              </Card>
            )}
            {current.result && <WarningList warnings={current.result.warnings} />}
          </div>
        );
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {back}
        <div className="flex items-center gap-2">
          <Badge tone={status.tone}>{status.label}</Badge>
          {canCancel && (
            <Button variant="ghost" size="sm" onClick={() => setCancelling(true)}>
              {importing ? 'Stop import' : 'Discard import'}
            </Button>
          )}
        </div>
      </div>
      <Steps current={stepIndex(current)} />
      {body()}
      <ConfirmDialog
        open={cancelling}
        title={importing ? 'Stop this import?' : 'Discard this import?'}
        message={
          importing
            ? 'The import stops after the record it is working on. What was already imported stays in Synari.'
            : 'The uploaded files are deleted and nothing is imported. You can start a new import at any time.'
        }
        confirmLabel={importing ? 'Stop import' : 'Discard import'}
        danger
        loading={cancel.isPending}
        onCancel={() => setCancelling(false)}
        onConfirm={() => cancel.mutate()}
      />
    </div>
  );
}
