import { useId, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FileText, Send } from 'lucide-react';
import { portalEstimateKeys, portalEstimatesApi, type PortalEstimate, type PortalEstimates } from '../../api/estimates';
import { usePortalClient } from '../../auth/ClientAuth';
import { formatDate, formatMoney, formatPlainDate } from '../../lib/format';
import { PdfButton } from '../../portal/billing/components/BillingDisplay';
import { Button } from '../../ui/Button';
import { Card, CardBody, CardHeader } from '../../ui/Card';
import { Badge, ErrorState } from '../../ui/Display';
import { Field, Input, Select } from '../../ui/Form';
import { Modal } from '../../ui/Modal';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';

function AcknowledgeForm({ estimate, onDone }: { estimate: PortalEstimate; onDone: () => void }) {
  const formId = useId();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const acknowledge = useMutation({
    mutationFn: () => portalEstimatesApi.acknowledge(estimate.id, name.trim()),
    onSuccess: async () => {
      toast.success('Thanks. We noted that you received this estimate.');
      onDone();
      await queryClient.invalidateQueries({ queryKey: portalEstimateKeys.all });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (acknowledge.isPending) return;
    if (!name.trim()) {
      setError('Type your full name.');
      return;
    }
    setError(null);
    acknowledge.mutate();
  };
  return (
    <form id={formId} onSubmit={submit} noValidate className="mt-3 space-y-2 rounded-lg bg-sage-50 p-3">
      <p className="text-sm text-sage-700">
        Optional: let the practice know you received this estimate. This doesn't agree to any charges.
      </p>
      <Field label="Your full name" error={error ?? (acknowledge.isError ? acknowledge.error.message : null)}>
        {(props) => <Input {...props} value={name} maxLength={200} autoComplete="name" onChange={(e) => setName(e.target.value)} />}
      </Field>
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="secondary" onClick={onDone} disabled={acknowledge.isPending}>
          Cancel
        </Button>
        <Button size="sm" type="submit" loading={acknowledge.isPending}>
          Acknowledge receipt
        </Button>
      </div>
    </form>
  );
}

function EstimateRow({ estimate, timeZone }: { estimate: PortalEstimate; timeZone: string }) {
  const current = estimate.status === 'issued';
  const [acknowledging, setAcknowledging] = useState(false);
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-medium text-sage-900">
            {estimate.primary_service}
            <Badge tone={current ? 'success' : 'neutral'}>{current ? 'Current' : 'Replaced'}</Badge>
          </p>
          <p className="mt-0.5 text-sm text-sage-600">
            {estimate.clinician_name} · {formatPlainDate(estimate.period_start)} – {formatPlainDate(estimate.period_end)}
          </p>
          <p className="mt-0.5 text-sm text-sage-600">
            Estimated total{' '}
            <span className="font-medium tabular-nums text-sage-900">
              {estimate.total_cents === 0 ? 'no charge' : formatMoney(estimate.total_cents)}
            </span>
            {estimate.issued_at && ` · given ${formatDate(estimate.issued_at, timeZone)}`}
          </p>
          {estimate.change_summary && <p className="mt-0.5 text-sm text-sage-600">What changed: {estimate.change_summary}</p>}
          {estimate.acknowledged_at && (
            <p className="mt-0.5 flex items-center gap-1 text-sm text-emerald-700">
              <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
              You acknowledged it on {formatDate(estimate.acknowledged_at, timeZone)}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PdfButton
            download={() => portalEstimatesApi.downloadPdf(estimate.id)}
            label="Download"
            accessibleLabel={`Download the good faith estimate from ${estimate.issued_at ? formatDate(estimate.issued_at, timeZone) : 'your provider'}`}
          />
          {current && !estimate.acknowledged_at && !acknowledging && (
            <Button size="sm" variant="ghost" icon={<CheckCircle2 className="h-4 w-4" />} onClick={() => setAcknowledging(true)}>
              Acknowledge
            </Button>
          )}
        </div>
      </div>
      {acknowledging && !estimate.acknowledged_at && <AcknowledgeForm estimate={estimate} onDone={() => setAcknowledging(false)} />}
    </li>
  );
}

function RequestEstimate({ data, practiceName }: { data: PortalEstimates; practiceName: string }) {
  const formId = useId();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [clinicianId, setClinicianId] = useState(data.clinicians[0] ? String(data.clinicians[0].id) : '');
  const request = useMutation({
    mutationFn: () => portalEstimatesApi.request(clinicianId ? Number(clinicianId) : undefined),
    onSuccess: async () => {
      toast.success(`Request sent. ${practiceName} will give you an estimate within 3 business days.`);
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: portalEstimateKeys.all });
    },
  });
  if (data.request_pending) {
    return (
      <div className="flex flex-col items-start gap-2 sm:items-end">
        <Button size="sm" variant="secondary" icon={<Send className="h-4 w-4" />} disabled aria-describedby={`${formId}-pending`}>
          Request a cost estimate
        </Button>
        <p id={`${formId}-pending`} className="text-xs text-sage-600 sm:text-right">
          {practiceName} is already preparing an estimate for you.
        </p>
      </div>
    );
  }
  const close = () => {
    if (!request.isPending) setOpen(false);
  };
  return (
    <>
      <Button size="sm" variant="secondary" icon={<Send className="h-4 w-4" />} onClick={() => setOpen(true)}>
        Request a cost estimate
      </Button>
      <Modal
        open={open}
        onClose={close}
        size="sm"
        title="Request a cost estimate"
        description={`${practiceName} will give you a written good faith estimate of your expected costs within 3 business days.`}
        footer={
          <>
            <Button variant="secondary" onClick={close} disabled={request.isPending}>
              Cancel
            </Button>
            <Button type="submit" form={formId} loading={request.isPending}>
              Send request
            </Button>
          </>
        }
      >
        <form
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            if (!request.isPending) request.mutate();
          }}
          className="space-y-3"
        >
          {request.isError && <p className="text-sm text-red-700">{request.error.message}</p>}
          {data.clinicians.length > 1 ? (
            <Field label="For care with">
              {(props) => (
                <Select {...props} value={clinicianId} onChange={(e) => setClinicianId(e.target.value)}>
                  {data.clinicians.map((clinician) => (
                    <option key={clinician.id} value={clinician.id}>
                      {clinician.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : (
            data.clinicians[0] && <p className="text-sm text-sage-700">For care with {data.clinicians[0].name}.</p>
          )}
          <p className="text-sm text-sage-600">You'll find it here in Documents, and we'll email you when it's ready.</p>
        </form>
      </Modal>
    </>
  );
}

/** The client's good faith estimates: every one they were given, and a way to ask for one. */
export function PortalEstimatesSection() {
  const client = usePortalClient();
  const estimates = useQuery({ queryKey: portalEstimateKeys.all, queryFn: portalEstimatesApi.list });
  const data = estimates.data;
  if (data && !data.enabled && data.estimates.length === 0) return null;
  return (
    <Card>
      <CardHeader
        title="Good faith estimates"
        description="Written estimates of the expected cost of your care."
        actions={data?.enabled && <RequestEstimate data={data} practiceName={client.practice_name} />}
      />
      {estimates.isPending && <SectionSpinner />}
      {estimates.error && <ErrorState error={estimates.error} onRetry={() => void estimates.refetch()} />}
      {data && data.estimates.length === 0 && (
        <CardBody>
          <p className="flex items-center gap-2 text-sm text-sage-600">
            <FileText aria-hidden="true" className="h-4 w-4 shrink-0 text-sage-400" />
            No estimates yet. If you pay for care yourself, you'll get one when you schedule, or you can ask for one.
          </p>
        </CardBody>
      )}
      {data && data.estimates.length > 0 && (
        <ul className="divide-y divide-sage-100" aria-label="Your good faith estimates">
          {data.estimates.map((estimate) => (
            <EstimateRow key={estimate.id} estimate={estimate} timeZone={client.time_zone} />
          ))}
        </ul>
      )}
    </Card>
  );
}
