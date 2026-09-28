import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChevronRight, ClipboardList, Download, FileText, PenLine, Upload } from 'lucide-react';
import { portalFileKeys, portalFilesApi, uploadErrorMessage, uploadProblem, type StoredFile } from '../../api/files';
import { FORM_KIND_LABELS, portalFormKeys, portalFormsApi, type PortalFormSummary } from '../../api/forms';
import { usePortalClient } from '../../auth/ClientAuth';
import { displayFirstName, formatBytes, formatDate } from '../../lib/format';
import { useRealtimeEvent } from '../../lib/realtime';
import { FilePicker } from '../../shared/forms/FilePicker';
import { GoodFaithEstimateNotice } from '../../shared/GoodFaithEstimateNotice';
import { Button } from '../../ui/Button';
import { Card, CardBody, CardHeader } from '../../ui/Card';
import { Badge, EmptyState, ErrorState, PageHeader } from '../../ui/Display';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import { draftStorageKey, hasDraft } from './formDraftStorage';
import { pendingInOrder } from './pendingForms';
import { PortalEstimatesSection } from './PortalEstimatesSection';

function PendingFormRow({ form, timeZone, inProgress }: { form: PortalFormSummary; timeZone: string; inProgress: boolean }) {
  return (
    <li>
      <Link
        to={`/client/documents/forms/${form.id}`}
        className="flex min-h-[72px] items-center gap-4 px-5 py-4 transition-colors hover:bg-sage-50 focus:outline-none focus-visible:bg-primary-50"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-50 text-primary-700">
          {form.requires_signature ? <PenLine aria-hidden="true" className="h-5 w-5" /> : <ClipboardList aria-hidden="true" className="h-5 w-5" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-sage-900">{form.name}</span>
            {inProgress && <Badge tone="info">In progress</Badge>}
          </span>
          <span className="mt-0.5 block text-sm text-sage-600">
            {FORM_KIND_LABELS[form.kind]} · Sent {formatDate(form.sent_at, timeZone)}
            {form.requires_signature ? ' · Signature needed' : ''}
          </span>
        </span>
        <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-sage-400" />
      </Link>
    </li>
  );
}

function CompletedFormRow({ form, timeZone }: { form: PortalFormSummary; timeZone: string }) {
  return (
    <li>
      <Link
        to={`/client/documents/forms/${form.id}`}
        className="flex min-h-[64px] items-center gap-4 px-5 py-3 transition-colors hover:bg-sage-50 focus:outline-none focus-visible:bg-primary-50"
      >
        <CheckCircle2 aria-hidden="true" className="h-5 w-5 shrink-0 text-emerald-600" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-sage-900">{form.name}</span>
          {form.completed_at && (
            <span className="block text-sm text-sage-600">Completed {formatDate(form.completed_at, timeZone)}</span>
          )}
        </span>
        <span className="text-sm font-medium text-primary-700">View</span>
      </Link>
    </li>
  );
}

function FileRow({
  file,
  timeZone,
  downloading,
  onDownload,
}: {
  file: StoredFile;
  timeZone: string;
  downloading: boolean;
  onDownload: () => void;
}) {
  return (
    <li className="flex items-center gap-3 px-5 py-3">
      <FileText aria-hidden="true" className="h-5 w-5 shrink-0 text-primary-700" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-sage-900">{file.filename}</p>
        <p className="text-sm text-sage-600">
          {formatBytes(file.size_bytes)} · {formatDate(file.created_at, timeZone)}
        </p>
      </div>
      <Button
        size="sm"
        variant="secondary"
        icon={<Download className="h-4 w-4" />}
        loading={downloading}
        onClick={onDownload}
        aria-label={`Download ${file.filename}`}
        className="h-10 shrink-0"
      >
        <span className="hidden sm:inline">Download</span>
      </Button>
    </li>
  );
}

function UploadCard({ clinicianName }: { clinicianName: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickerKey, setPickerKey] = useState(0);

  const upload = useMutation({
    mutationFn: portalFilesApi.upload,
    onSuccess: (stored) => {
      toast.success(`${stored.filename} uploaded. ${clinicianName} can now see it.`);
      setFile(null);
      setPickerKey((key) => key + 1);
      void queryClient.invalidateQueries({ queryKey: portalFileKeys.list });
    },
    onError: (failure) => setError(uploadErrorMessage(failure)),
  });

  const choose = (chosen: File | null) => {
    setFile(chosen);
    setError(chosen ? uploadProblem(chosen) : null);
  };

  const submit = () => {
    if (!file) {
      setError('Choose a file to upload');
      return;
    }
    const problem = uploadProblem(file);
    if (problem) {
      setError(problem);
      return;
    }
    upload.mutate(file);
  };

  return (
    <div className="space-y-3">
      <FilePicker
        key={pickerKey}
        file={file}
        onChange={choose}
        error={error}
        disabled={upload.isPending}
        label="Tap to choose a file or take a photo"
      />
      <div className="flex justify-end">
        <Button
          icon={<Upload className="h-4 w-4" />}
          loading={upload.isPending}
          onClick={submit}
          disabled={!file}
          className="h-12 w-full px-6 text-base sm:w-auto"
        >
          Upload document
        </Button>
      </div>
    </div>
  );
}

/** /client/documents — forms to complete, completed forms and shared files. */
export default function ClientDocumentsPage() {
  const client = usePortalClient();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [downloading, setDownloading] = useState<number | null>(null);
  const forms = useQuery({ queryKey: portalFormKeys.list, queryFn: portalFormsApi.list });
  const files = useQuery({ queryKey: portalFileKeys.list, queryFn: portalFilesApi.list });

  useRealtimeEvent(['client_form.shared', 'client_form.revoked'], () => {
    void queryClient.invalidateQueries({ queryKey: portalFormKeys.all });
  });

  const download = async (file: StoredFile) => {
    setDownloading(file.id);
    try {
      await portalFilesApi.download(file);
    } catch (error) {
      toast.error(error);
    } finally {
      setDownloading(null);
    }
  };

  const pending = pendingInOrder(forms.data ?? []);
  const completed = (forms.data ?? []).filter((form) => form.status === 'completed');
  // Good faith estimates have their own section below.
  const shared = (files.data ?? []).filter((file) => file.uploaded_by === 'staff' && file.purpose !== 'good_faith_estimate');
  const uploads = (files.data ?? []).filter((file) => file.uploaded_by === 'client');
  const timeZone = client.time_zone;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Documents"
        description={
          client.acting_contact
            ? `Forms to complete and documents ${client.clinician_name} shared for ${displayFirstName(client)}.`
            : `Forms to complete and documents shared with you by ${client.clinician_name}.`
        }
      />

      <Card>
        <CardHeader
          title="To complete"
          description={pending.length ? `${pending.length} ${pending.length === 1 ? 'form' : 'forms'} waiting for you` : undefined}
        />
        {forms.isPending && <SectionSpinner />}
        {forms.error && <ErrorState error={forms.error} onRetry={() => void forms.refetch()} />}
        {forms.data && pending.length === 0 && (
          <EmptyState icon={<CheckCircle2 />} title="You're all set" description="There's nothing for you to complete right now." />
        )}
        {pending.length > 0 && (
          <ul className="divide-y divide-sage-100">
            {pending.map((form) => (
              <PendingFormRow
                key={form.id}
                form={form}
                timeZone={timeZone}
                inProgress={hasDraft(draftStorageKey(client.id, form.id))}
              />
            ))}
          </ul>
        )}
      </Card>

      {completed.length > 0 && (
        <Card>
          <CardHeader title="Completed" />
          <ul className="divide-y divide-sage-100">
            {completed.map((form) => (
              <CompletedFormRow key={form.id} form={form} timeZone={timeZone} />
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <CardHeader title="Shared with you" />
        {files.isPending && <SectionSpinner />}
        {files.error && <ErrorState error={files.error} onRetry={() => void files.refetch()} />}
        {files.data && shared.length === 0 && (
          <CardBody>
            <p className="text-sm text-sage-600">Documents {client.clinician_name} shares with you will appear here.</p>
          </CardBody>
        )}
        {shared.length > 0 && (
          <ul className="divide-y divide-sage-100">
            {shared.map((file) => (
              <FileRow
                key={file.id}
                file={file}
                timeZone={timeZone}
                downloading={downloading === file.id}
                onDownload={() => void download(file)}
              />
            ))}
          </ul>
        )}
      </Card>

      <PortalEstimatesSection />

      <Card>
        <CardHeader
          title="Upload a document"
          description={`Send ${client.clinician_name} a document such as an insurance card or a referral letter.`}
        />
        <CardBody>
          <UploadCard clinicianName={client.clinician_name} />
        </CardBody>
        {uploads.length > 0 && (
          <div className="border-t border-sage-100">
            <h3 className="px-5 pt-4 text-sm font-semibold text-sage-800">Uploaded from the portal</h3>
            <ul className="divide-y divide-sage-100">
              {uploads.map((file) => (
                <FileRow
                  key={file.id}
                  file={file}
                  timeZone={timeZone}
                  downloading={downloading === file.id}
                  onDownload={() => void download(file)}
                />
              ))}
            </ul>
          </div>
        )}
      </Card>

      <GoodFaithEstimateNotice />
      <p className="text-center text-sm text-sage-600">
        Need a copy of your whole record, or think something in it is wrong?{' '}
        <Link to="/client/records" className="font-medium text-primary-700 hover:underline">
          Go to My records
        </Link>
      </p>
    </div>
  );
}
