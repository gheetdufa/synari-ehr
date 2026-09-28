import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Flag, ShieldAlert, ShieldCheck } from 'lucide-react';
import { FORM_KIND_LABELS, formKeys, formsApi, type ClientFormDetail } from '../../api/forms';
import { formatDateTime } from '../../lib/format';
import { FormRenderer } from '../../shared/forms/FormRenderer';
import { SignatureRecord } from '../../shared/forms/Signature';
import { Button } from '../../ui/Button';
import { Alert, Badge, ErrorState } from '../../ui/Display';
import { Modal } from '../../ui/Modal';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import { FormStatusBadge } from './FormStatusBadge';

function Timeline({ form, timeZone }: { form: ClientFormDetail; timeZone: string }) {
  const rows: Array<[string, string | null]> = [
    ['Sent', form.sent_at],
    ['Viewed', form.viewed_at],
    ['Completed', form.completed_at],
    ['Last reminder', form.last_reminded_at],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {rows
        .filter(([, value]) => value)
        .map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-sage-500">{label}</dt>
            <dd className="text-sage-900">{formatDateTime(value as string, timeZone)}</dd>
          </div>
        ))}
    </dl>
  );
}

function ScoreBlock({ form }: { form: ClientFormDetail }) {
  if (form.score === null) return null;
  const max = form.scoring?.max_score;
  return (
    <div className="rounded-xl border border-sage-200 bg-white px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-sage-500">Score</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-sage-900">
        {form.score}
        {max !== null && max !== undefined && <span className="text-base font-normal text-sage-500"> / {max}</span>}
      </p>
      {form.score_label && <p className="text-sm font-medium text-sage-700">{form.score_label}</p>}
    </div>
  );
}

/** The signed form's hash and whether the form still matches it. */
function SignatureIntegrity({ form }: { form: ClientFormDetail }) {
  const mismatch = form.signature_integrity === 'mismatch';
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-sage-600">
      {mismatch ? (
        <Badge tone="danger">
          <ShieldAlert aria-hidden="true" className="h-3 w-3" /> Integrity check failed
        </Badge>
      ) : (
        form.signature_integrity === 'verified' && (
          <Badge tone="success">
            <ShieldCheck aria-hidden="true" className="h-3 w-3" /> Signature verified
          </Badge>
        )
      )}
      <span>
        SHA-256{' '}
        <code className="break-all font-mono" title={form.signature_sha256}>
          {form.signature_sha256}
        </code>
      </span>
    </div>
  );
}

function FormDetail({ form, timeZone }: { form: ClientFormDetail; timeZone: string }) {
  const completed = form.status === 'completed';
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <FormStatusBadge form={form} />
        <Badge>{FORM_KIND_LABELS[form.kind]}</Badge>
        {form.flagged && (
          <Badge tone="danger">
            <Flag aria-hidden="true" className="h-3 w-3" /> Needs review
          </Badge>
        )}
      </div>
      {form.flagged && (
        <Alert tone="danger" title="Needs your review">
          {form.flag_reason || 'A response on this form was flagged.'}
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <Timeline form={form} timeZone={timeZone} />
        <ScoreBlock form={form} />
      </div>
      {completed ? (
        <div className="border-t border-sage-100 pt-5">
          <FormRenderer
            fields={form.fields}
            answers={form.answers ?? {}}
            readOnly
            showValues
            idPrefix={`client-form-${form.id}`}
            headingLevel={3}
          />
        </div>
      ) : (
        <Alert tone="info" title="Not completed yet">
          Answers appear here once the client submits the form. You can send a reminder from the forms list.
        </Alert>
      )}
      {completed && form.requires_signature && (
        <SignatureRecord
          name={form.signature_name}
          signedAt={form.signed_at}
          timeZone={timeZone}
          ipAddress={form.signer_ip}
          userAgent={form.signer_user_agent}
        />
      )}
      {completed && form.signature_sha256 && <SignatureIntegrity form={form} />}
    </div>
  );
}

/** A shared form with the client's answers, score, flag reason and signature record. */
export function ClientFormViewModal({
  formId,
  onClose,
  timeZone,
}: {
  formId: number | null;
  onClose: () => void;
  timeZone: string;
}) {
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);
  const query = useQuery({
    queryKey: formKeys.clientForm(formId ?? 0),
    queryFn: () => formsApi.clientForm(formId as number),
    enabled: formId !== null,
  });
  const form = query.data;

  const download = async () => {
    if (!form) return;
    setDownloading(true);
    try {
      await formsApi.downloadPdf(form.id);
    } catch (error) {
      toast.error(error);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Modal
      open={formId !== null}
      onClose={onClose}
      size="xl"
      title={form?.name ?? 'Form'}
      footer={
        <>
          {form?.status === 'completed' && (
            <Button variant="secondary" icon={<Download className="h-4 w-4" />} loading={downloading} onClick={download}>
              Download PDF
            </Button>
          )}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {query.isPending && <SectionSpinner />}
      {query.error && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {form && <FormDetail form={form} timeZone={timeZone} />}
    </Modal>
  );
}
