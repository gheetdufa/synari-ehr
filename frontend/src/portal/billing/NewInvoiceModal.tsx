import { useId, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { STATUS_LABELS } from '../../api/appointments';
import {
  MAX_UNINVOICED_PAGE,
  billingApi,
  billingKeys,
  estimateOverrideDetail,
  validateAmount,
  type EstimateCheck,
  type Invoice,
  type InvoiceCreate,
} from '../../api/billing';
import type { ClientRef } from '../../api/clients';
import { formatDate, formatMoney } from '../../lib/format';
import { Button, IconButton } from '../../ui/Button';
import { Alert } from '../../ui/Display';
import { Checkbox, Field, Input, Textarea } from '../../ui/Form';
import { Modal } from '../../ui/Modal';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import { ClientPicker } from './components/ClientPicker';
import { MoneyInput } from './components/BillingDisplay';
import { buildInvoicePayload, newManualLine, type LineErrors, type ManualLineDraft } from './helpers';
import { useInvalidateBilling, usePracticeDay } from './hooks';

/** Invoice a client's uninvoiced sessions (with any of their clinicians) and/or custom lines now. */
export function NewInvoiceModal({
  fixedClient,
  initialClient,
  initialParticipantIds,
  onClose,
  onCreated,
}: {
  fixedClient?: ClientRef;
  /** The client to start with; they can pick another one. */
  initialClient?: ClientRef;
  /** Sessions to preselect, by participant id. */
  initialParticipantIds?: number[];
  onClose: () => void;
  onCreated?: (invoice: Invoice) => void;
}) {
  const formId = useId();
  const toast = useToast();
  const invalidate = useInvalidateBilling();
  const { today, timeZone } = usePracticeDay();

  const [client, setClient] = useState<ClientRef | null>(fixedClient ?? initialClient ?? null);
  const clientId = client?.id ?? null;
  const [selected, setSelected] = useState<Set<number>>(() => new Set(initialParticipantIds ?? []));
  const [lines, setLines] = useState<ManualLineDraft[]>([]);
  const [notes, setNotes] = useState('');
  const [notify, setNotify] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const [lineErrors, setLineErrors] = useState<Record<string, LineErrors>>({});
  // Good faith estimate check for exactly this invoice (by its JSON body): warnings the person
  // has seen, and whether billed charges run $400+ over an estimate (a reason is then required).
  const [estimateCheck, setEstimateCheck] = useState<{ key: string; result: EstimateCheck } | null>(null);
  const [checking, setChecking] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideError, setOverrideError] = useState<string | null>(null);

  const uninvoiced = useQuery({
    queryKey: billingKeys.clientUninvoiced(clientId ?? 0),
    queryFn: () => billingApi.uninvoiced({ client_id: clientId ?? undefined, limit: MAX_UNINVOICED_PAGE }),
    select: (page) => page.items,
    enabled: clientId !== null,
  });
  const sessions = useMemo(() => uninvoiced.data ?? [], [uninvoiced.data]);
  const amounts = useMemo(() => new Map(sessions.map((s) => [s.participant_id, s.amount_cents])), [sessions]);
  const chosenIds = sessions.filter((s) => selected.has(s.participant_id)).map((s) => s.participant_id);
  const allChosen = sessions.length > 0 && chosenIds.length === sessions.length;

  const total =
    chosenIds.reduce((sum, id) => sum + (amounts.get(id) ?? 0), 0) +
    lines.reduce((sum, line) => sum + (validateAmount(line.amount).cents ?? 0), 0);

  const create = useMutation({
    mutationFn: (input: InvoiceCreate) => billingApi.createInvoice(input),
    onSuccess: async (invoice) => {
      const created =
        invoice.status === 'paid'
          ? `Created ${invoice.number}. It was paid in full from the client's credit.`
          : `Created ${invoice.number} for ${formatMoney(invoice.total_cents)}.`;
      const unseen = (invoice.estimate_warnings ?? []).filter((warning) => !estimateCheck?.result.warnings.includes(warning));
      toast.success(unseen.length > 0 ? `${created} ${unseen.join(' ')}` : created);
      await invalidate(invoice.client.id);
      if (onCreated) onCreated(invoice);
      else onClose();
    },
    onError: (error, input) => {
      const detail = estimateOverrideDetail(error);
      if (detail) {
        setEstimateCheck({
          key: payloadKey(input),
          result: { warnings: [detail.message], override_required: true, over_by_cents: detail.over_by_cents },
        });
      }
    },
  });

  const toggle = (participantId: number, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(participantId);
      else next.delete(participantId);
      return next;
    });

  const updateLine = (key: string, changes: Partial<ManualLineDraft>) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...changes } : line)));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (create.isPending || checking) return;
    const result = buildInvoicePayload({ clientId, participantIds: chosenIds, lines, notes, notify }, amounts);
    if (!result.ok) {
      setFormError(result.formError);
      setLineErrors(result.lineErrors);
      return;
    }
    setFormError(null);
    setLineErrors({});
    const payload = result.payload;
    const key = payloadKey(payload);
    if (estimateCheck?.key === key) {
      // The person has seen this invoice's estimate warnings; create it (with the reason if needed).
      if (!estimateCheck.result.override_required) {
        create.mutate(payload);
        return;
      }
      const reason = overrideReason.trim();
      if (!reason) {
        setOverrideError('Explain why this invoice goes over the good faith estimate.');
        return;
      }
      setOverrideError(null);
      create.mutate({ ...payload, gfe_override_reason: reason });
      return;
    }
    setChecking(true);
    let checked: EstimateCheck | null = null;
    try {
      checked = await billingApi.estimateCheck(payload);
    } catch {
      // The check is advisory: creating the invoice still enforces the estimate rules.
      checked = null;
    } finally {
      setChecking(false);
    }
    if (checked && (checked.override_required || checked.warnings.length > 0)) {
      setEstimateCheck({ key, result: checked });
      return;
    }
    create.mutate(payload);
  };

  const close = () => {
    if (!create.isPending && !checking) onClose();
  };
  let submitLabel = total > 0 ? `Create invoice for ${formatMoney(total)}` : 'Create invoice';
  if (estimateCheck?.result.override_required) submitLabel = 'Create invoice with override';
  else if (estimateCheck && estimateCheck.result.warnings.length > 0) submitLabel = 'Create invoice anyway';

  return (
    <Modal
      open
      onClose={close}
      title="New invoice"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={create.isPending || checking}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={create.isPending || checking}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(event) => void submit(event)} noValidate className="space-y-5">
        {create.isError && !estimateOverrideDetail(create.error) && (
          <Alert tone="danger" title="The invoice wasn't created">
            {create.error.message}
          </Alert>
        )}
        {formError && <Alert tone="danger">{formError}</Alert>}
        {estimateCheck && (
          <EstimateWarnings
            check={estimateCheck.result}
            reason={overrideReason}
            reasonError={overrideError}
            onReasonChange={setOverrideReason}
          />
        )}

        <ClientPicker
          fixed={fixedClient}
          value={client}
          onChange={(next) => {
            setClient(next);
            setSelected(new Set());
          }}
          required
        />

        {clientId !== null && (
          <section aria-labelledby={`${formId}-sessions`}>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 id={`${formId}-sessions`} className="text-sm font-semibold text-sage-900">
                Uninvoiced sessions
              </h3>
              {sessions.length > 1 && (
                <Checkbox
                  label="Select all"
                  checked={allChosen}
                  onChange={(event) =>
                    setSelected(event.target.checked ? new Set(sessions.map((s) => s.participant_id)) : new Set())
                  }
                />
              )}
            </div>
            {uninvoiced.isLoading && <SectionSpinner />}
            {uninvoiced.isError && <Alert tone="danger">{uninvoiced.error.message}</Alert>}
            {uninvoiced.isSuccess && sessions.length === 0 && (
              <p className="rounded-lg border border-dashed border-sage-200 px-4 py-3 text-sm text-sage-600">
                No past sessions are waiting to be invoiced for this client. Add a line below to bill something else.
              </p>
            )}
            {sessions.length > 0 && (
              <ul className="divide-y divide-sage-100 rounded-lg border border-sage-100">
                {sessions.map((session) => (
                  <li key={session.participant_id} className="flex items-center gap-3 px-3 py-2.5">
                    <Checkbox
                      className="flex-1"
                      checked={selected.has(session.participant_id)}
                      onChange={(event) => toggle(session.participant_id, event.target.checked)}
                      label={`${formatDate(session.starts_at, timeZone, { weekday: 'short' })} · ${session.clinician_name}`}
                      description={[
                        session.service_code,
                        session.service_description || 'Session',
                        session.status !== 'attended' ? STATUS_LABELS[session.status] : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    />
                    <span className="text-sm font-medium tabular-nums text-sage-900">{formatMoney(session.amount_cents)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <section aria-labelledby={`${formId}-lines`}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 id={`${formId}-lines`} className="text-sm font-semibold text-sage-900">
              Other charges
            </h3>
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus className="h-4 w-4" />}
              onClick={() => setLines((current) => [...current, newManualLine(today)])}
            >
              Add line
            </Button>
          </div>
          {lines.length === 0 ? (
            <p className="text-sm text-sage-500">For fees that aren't a session, like a records request or a letter.</p>
          ) : (
            <ul className="space-y-3">
              {lines.map((line, index) => {
                const errors = lineErrors[line.key] ?? {};
                return (
                  <li key={line.key} className="rounded-lg border border-sage-100 p-3">
                    <div className="grid gap-3 sm:grid-cols-[9.5rem_1fr_6rem_8rem_auto] sm:items-start">
                      <Field label="Date" error={errors.service_date}>
                        {(props) => (
                          <Input {...props} type="date" value={line.service_date} onChange={(e) => updateLine(line.key, { service_date: e.target.value })} />
                        )}
                      </Field>
                      <Field label="Description" error={errors.description}>
                        {(props) => (
                          <Input {...props} value={line.description} maxLength={300} onChange={(e) => updateLine(line.key, { description: e.target.value })} />
                        )}
                      </Field>
                      <Field label="Code" error={errors.service_code}>
                        {(props) => (
                          <Input {...props} value={line.service_code} maxLength={20} placeholder="Optional" onChange={(e) => updateLine(line.key, { service_code: e.target.value })} />
                        )}
                      </Field>
                      <Field label="Amount" error={errors.amount}>
                        {(props) => <MoneyInput {...props} value={line.amount} onChange={(e) => updateLine(line.key, { amount: e.target.value })} />}
                      </Field>
                      <IconButton
                        label={`Remove line ${index + 1}`}
                        className="sm:mt-6"
                        onClick={() => setLines((current) => current.filter((l) => l.key !== line.key))}
                      >
                        <Trash2 className="h-4 w-4" />
                      </IconButton>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <Field label="Notes" hint="Printed on the invoice.">
          {(props) => <Textarea {...props} rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />}
        </Field>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-sage-50 px-4 py-3">
          <Checkbox
            label="Let the client know"
            description="Emails a portal link when the client has portal billing on."
            checked={notify}
            onChange={(event) => setNotify(event.target.checked)}
          />
          <p className="text-sm text-sage-700">
            Total <span className="ml-1 text-lg font-semibold tabular-nums text-sage-900">{formatMoney(total)}</span>
          </p>
        </div>
        <p className="text-xs text-sage-500">
          Each session is billed what the client owes for it: the copay for an insurance client's attended session,
          otherwise the fee. Any credit the client has is applied to the new invoice automatically.
        </p>
      </form>
    </Modal>
  );
}

/** Identifies an invoice body, so a change to it asks for a fresh estimate check. */
function payloadKey(payload: InvoiceCreate): string {
  return JSON.stringify({ ...payload, gfe_override_reason: undefined });
}

/** Good faith estimate warnings for the invoice, and the override reason when it's $400+ over. */
function EstimateWarnings({
  check,
  reason,
  reasonError,
  onReasonChange,
}: {
  check: EstimateCheck;
  reason: string;
  reasonError: string | null;
  onReasonChange: (value: string) => void;
}) {
  return (
    <div className="space-y-3">
      <Alert
        tone={check.override_required ? 'danger' : 'warning'}
        title={
          check.override_required
            ? `This invoice would bill ${formatMoney(check.over_by_cents)} more than the good faith estimate`
            : 'Check the good faith estimate'
        }
      >
        <ul className="list-disc space-y-1 pl-5">
          {check.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
        {check.override_required && (
          <p className="mt-2">
            When a self-pay client is billed $400 or more above their estimate, they can dispute the bill. Consider issuing
            an updated estimate instead, or record why this charge is right.
          </p>
        )}
      </Alert>
      {check.override_required && (
        <Field label="Reason for going over the estimate" required error={reasonError}>
          {(props) => (
            <Textarea {...props} rows={2} maxLength={500} value={reason} onChange={(event) => onReasonChange(event.target.value)} />
          )}
        </Field>
      )}
    </div>
  );
}
