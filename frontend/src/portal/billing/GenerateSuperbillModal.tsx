import { useId, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { billingApi, type Superbill } from '../../api/billing';
import type { ClientRef } from '../../api/clients';
import { formatMoney, formatPlainDate } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Alert } from '../../ui/Display';
import { Field, Input } from '../../ui/Form';
import { Modal } from '../../ui/Modal';
import { ClientPicker } from './components/ClientPicker';
import { PdfButton } from './components/BillingDisplay';
import { lastMonthRange, superbillPeriodError } from './helpers';
import { useInvalidateBilling, usePracticeDay } from './hooks';

/** Snapshot a client's attended services and payments for a period as a superbill. */
export function GenerateSuperbillModal({
  fixedClient,
  onClose,
  onView,
}: {
  fixedClient?: ClientRef;
  onClose: () => void;
  /** Open the new superbill's details. */
  onView: (superbill: Superbill) => void;
}) {
  const formId = useId();
  const invalidate = useInvalidateBilling();
  const { today } = usePracticeDay();
  const [defaults] = useState(() => lastMonthRange(today));
  const [client, setClient] = useState<ClientRef | null>(fixedClient ?? null);
  const clientId = client?.id ?? null;
  const [start, setStart] = useState(defaults.start);
  const [end, setEnd] = useState(defaults.end);
  const [clientError, setClientError] = useState<string | null>(null);
  const [periodError, setPeriodError] = useState<string | null>(null);
  const [created, setCreated] = useState<Superbill | null>(null);

  const generate = useMutation({
    mutationFn: billingApi.createSuperbill,
    onSuccess: async (superbill) => {
      setCreated(superbill);
      await invalidate(superbill.client_id);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (generate.isPending) return;
    const period = superbillPeriodError(start, end);
    setPeriodError(period);
    setClientError(clientId === null ? 'Choose a client.' : null);
    if (period || clientId === null) return;
    generate.mutate({ client_id: clientId, period_start: start, period_end: end });
  };

  const close = () => {
    if (!generate.isPending) onClose();
  };

  if (created) {
    return (
      <Modal
        open
        onClose={onClose}
        title="Superbill ready"
        size="sm"
        footer={
          <>
            <PdfButton download={() => billingApi.downloadSuperbillPdf(created.id)} label="Download PDF" />
            <Button variant="secondary" size="sm" onClick={() => onView(created)}>
              View details
            </Button>
            <Button onClick={onClose}>Done</Button>
          </>
        }
      >
        <div className="flex gap-3">
          <CheckCircle2 className="h-6 w-6 shrink-0 text-emerald-600" aria-hidden="true" />
          <div className="text-sm text-sage-700">
            <p className="font-medium text-sage-900">
              {created.number} for {created.data.client.name}
            </p>
            <p className="mt-1">
              {formatPlainDate(created.period_start)} – {formatPlainDate(created.period_end)} · {created.data.lines.length}{' '}
              {created.data.lines.length === 1 ? 'service' : 'services'} · {formatMoney(created.total_cents)} billed ·{' '}
              {formatMoney(created.paid_cents)} paid
            </p>
            <p className="mt-1">
              {created.data.provider
                ? `Provider: ${created.data.provider.name}`
                : 'Several clinicians provided these services; each service lists its provider.'}
            </p>
            <p className="mt-2 text-sage-600">
              The client can download it from their portal when portal billing is on.
            </p>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={close}
      title="Generate superbill"
      description="Lists attended sessions with any of the client's clinicians, diagnosis codes and payments for the client to submit to their insurer."
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={generate.isPending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={generate.isPending}>
            Generate superbill
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-4">
        {generate.isError && (
          <Alert tone="danger" title="The superbill wasn't created">
            {generate.error.message}
          </Alert>
        )}
        <ClientPicker fixed={fixedClient} value={client} onChange={setClient} error={clientError} required />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="From" required error={periodError}>
            {(props) => <Input {...props} type="date" value={start} max={end || undefined} onChange={(e) => setStart(e.target.value)} />}
          </Field>
          <Field label="To" required>
            {(props) => <Input {...props} type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} />}
          </Field>
        </div>
        <p className="text-xs text-sage-500">
          Defaults to last month. Diagnosis codes and insurance come from the client's chart, and the practice and
          clinicians' NPI, taxonomy and license details from Settings, so check them first.
        </p>
      </form>
    </Modal>
  );
}
