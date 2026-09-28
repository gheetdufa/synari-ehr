import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { estimateKeys, estimatesApi, type Estimate, type EstimateDelivery } from '../../api/estimates';
import { formatMoney } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Alert } from '../../ui/Display';
import { Field, Select, Textarea } from '../../ui/Form';
import { ConfirmDialog, Modal } from '../../ui/Modal';
import { useToast } from '../../ui/Toast';
import { CHANGE_SUMMARY_REQUIRED, DELIVERY_LABELS, DELIVERY_METHODS, draftOf, issueProblems } from './estimateHelpers';

function useEstimateChange() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: estimateKeys.all });
}

/**
 * Issue a draft: choose how the client receives it; lists what's missing first. A replacement
 * also needs what changed, which is saved on the draft before it's issued.
 */
export function IssueEstimateDialog({
  estimate,
  missingClientFields,
  onClose,
}: {
  estimate: Estimate;
  missingClientFields: string[];
  onClose: () => void;
}) {
  const formId = useId();
  const toast = useToast();
  const refresh = useEstimateChange();
  const [delivery, setDelivery] = useState<EstimateDelivery>('portal');
  const replaces = estimate.supersedes_id !== null;
  const [summary, setSummary] = useState(estimate.change_summary);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const problems = issueProblems(estimate, missingClientFields);
  const issue = useMutation({
    mutationFn: async () => {
      const changeSummary = summary.trim();
      // Issuing only takes the delivery method, so a new change summary is saved on the draft first.
      if (replaces && changeSummary !== estimate.change_summary) {
        await estimatesApi.update(estimate.id, { ...draftOf(estimate), change_summary: changeSummary });
      }
      return estimatesApi.issue(estimate.id, delivery);
    },
    onSuccess: async () => {
      toast.success('Estimate issued and shared in the client portal.');
      await refresh();
      onClose();
    },
    // The change summary may have been saved even though issuing failed.
    onError: () => void refresh(),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (problems.length > 0 || issue.isPending) return;
    if (replaces && !summary.trim()) {
      setSummaryError(CHANGE_SUMMARY_REQUIRED);
      return;
    }
    setSummaryError(null);
    issue.mutate();
  };
  const close = () => {
    if (!issue.isPending) onClose();
  };
  return (
    <Modal
      open
      onClose={close}
      title="Issue good faith estimate"
      description={`${estimate.primary_service} · ${formatMoney(estimate.total_cents)}`}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={issue.isPending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={issue.isPending} disabled={problems.length > 0}>
            Issue estimate
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-4">
        {problems.length > 0 && (
          <Alert tone="warning" title="Before you can issue this estimate">
            <ul className="list-disc space-y-1 pl-5">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </Alert>
        )}
        {issue.isError && (
          <Alert tone="danger" title="The estimate wasn't issued">
            {issue.error.message}
          </Alert>
        )}
        {replaces && (
          <Field label="What changed" required hint="Explained to the client on the new estimate." error={summaryError}>
            {(props) => (
              <Textarea {...props} rows={2} maxLength={2000} value={summary} onChange={(e) => setSummary(e.target.value)} />
            )}
          </Field>
        )}
        <Field label="How the client receives it" hint="Every issued estimate is also saved in the client's portal documents.">
          {(props) => (
            <Select {...props} value={delivery} onChange={(e) => setDelivery(e.target.value as EstimateDelivery)}>
              {DELIVERY_METHODS.map((method) => (
                <option key={method} value={method}>
                  {DELIVERY_LABELS[method]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {(delivery === 'paper' || delivery === 'mail') && (
          <p className="text-sm text-sage-600">Download the PDF after issuing to print a copy for the client.</p>
        )}
        <p className="text-sm text-sage-600">
          Issuing saves a PDF to the client's record and lets them know a document is ready. Issued estimates can't be
          changed: if the care or fees change, create an updated estimate.
        </p>
      </form>
    </Modal>
  );
}

/** Start an updated estimate that replaces an issued one once it's issued. */
export function SupersedeEstimateDialog({
  estimate,
  onClose,
  onCreated,
}: {
  estimate: Estimate;
  onClose: () => void;
  onCreated: (draft: Estimate) => void;
}) {
  const formId = useId();
  const toast = useToast();
  const refresh = useEstimateChange();
  const [summary, setSummary] = useState('');
  const supersede = useMutation({
    mutationFn: () => estimatesApi.supersede(estimate.id, summary.trim()),
    onSuccess: async (draft) => {
      toast.success('Updated draft created. Review it, then issue it to replace the current estimate.');
      await refresh();
      onCreated(draft);
    },
  });
  const close = () => {
    if (!supersede.isPending) onClose();
  };
  return (
    <Modal
      open
      onClose={close}
      title="Update this estimate"
      description="Creates a draft copy to change. Issuing it replaces the current estimate; the old one stays in the record."
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={supersede.isPending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={supersede.isPending}>
            Create updated draft
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          if (!supersede.isPending) supersede.mutate();
        }}
        className="space-y-4"
      >
        {supersede.isError && <Alert tone="danger">{supersede.error.message}</Alert>}
        <Field label="What's changing" hint="For example a new fee, another service or more sessions. You can edit it later.">
          {(props) => <Textarea {...props} rows={3} maxLength={2000} value={summary} onChange={(e) => setSummary(e.target.value)} />}
        </Field>
      </form>
    </Modal>
  );
}

/** Void a draft, or an estimate issued in error, with a reason. */
export function VoidEstimateDialog({ estimate, onClose }: { estimate: Estimate; onClose: () => void }) {
  const formId = useId();
  const toast = useToast();
  const refresh = useEstimateChange();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const voidEstimate = useMutation({
    mutationFn: () => estimatesApi.void(estimate.id, reason.trim()),
    onSuccess: async () => {
      toast.success('Estimate voided.');
      await refresh();
      onClose();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (voidEstimate.isPending) return;
    if (!reason.trim()) {
      setError('Say why this estimate is void.');
      return;
    }
    setError(null);
    voidEstimate.mutate();
  };
  const close = () => {
    if (!voidEstimate.isPending) onClose();
  };
  return (
    <Modal
      open
      onClose={close}
      size="sm"
      title="Void estimate"
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={voidEstimate.isPending}>
            Keep it
          </Button>
          <Button type="submit" form={formId} variant="danger" loading={voidEstimate.isPending}>
            Void estimate
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-4">
        {voidEstimate.isError && <Alert tone="danger">{voidEstimate.error.message}</Alert>}
        <p className="text-sm text-sage-700">
          {estimate.status === 'draft'
            ? 'The draft stays in the record, marked void.'
            : "Only void an estimate that was issued in error. It's removed from the client's portal but kept in the record. To change the care or fees, update the estimate instead."}
        </p>
        <Field label="Reason" required error={error}>
          {(props) => <Textarea {...props} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </form>
    </Modal>
  );
}

/** Delete a draft that was never issued. */
export function DeleteEstimateDialog({ estimate, onClose }: { estimate: Estimate; onClose: () => void }) {
  const toast = useToast();
  const refresh = useEstimateChange();
  const remove = useMutation({
    mutationFn: () => estimatesApi.remove(estimate.id),
    onSuccess: async () => {
      toast.success('Draft deleted.');
      await refresh();
      onClose();
    },
    onError: (error) => toast.error(error),
  });
  return (
    <ConfirmDialog
      open
      danger
      title="Delete this draft?"
      message="It was never issued, so nothing was shared with the client."
      confirmLabel="Delete draft"
      loading={remove.isPending}
      onConfirm={() => !remove.isPending && remove.mutate()}
      onCancel={onClose}
    />
  );
}
