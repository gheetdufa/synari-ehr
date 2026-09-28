import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  recordKeys,
  recordsApi,
  type Disclosure,
  type DisclosureInput,
  type DisclosureSource,
} from '../../api/records';
import { useSession } from '../../auth/StaffAuth';
import { formatDateTime, formatPlainDate } from '../../lib/format';
import { Button, IconButton } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { EmptyState, ErrorState } from '../../ui/Display';
import { Field, Input, Textarea } from '../../ui/Form';
import { ConfirmDialog, Modal } from '../../ui/Modal';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import { todayIn } from '../clients/clientHelpers';

/** How an entry got into the log (only manual entries can be changed). */
const SOURCE_LABELS: Record<DisclosureSource, string> = {
  manual: 'Entered',
  export: 'From a record export',
  record_request: 'From a record request',
};

interface DisclosureDraft {
  disclosed_on: string;
  recipient_name: string;
  recipient_address: string;
  description: string;
  purpose: string;
  legal_basis: string;
}

/** Problems with a disclosure entry, keyed by field. */
export function disclosureErrors(draft: DisclosureDraft, today: string): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.disclosed_on) errors.disclosed_on = 'Enter the date of the disclosure';
  else if (draft.disclosed_on > today) errors.disclosed_on = "The date can't be in the future";
  if (!draft.recipient_name.trim()) errors.recipient_name = 'Enter who received the information';
  if (!draft.description.trim()) errors.description = 'Describe what was disclosed';
  if (!draft.purpose.trim()) errors.purpose = 'Enter the purpose of the disclosure';
  return errors;
}

function toInput(draft: DisclosureDraft): DisclosureInput {
  return {
    disclosed_on: draft.disclosed_on,
    recipient_name: draft.recipient_name.trim(),
    recipient_address: draft.recipient_address.trim(),
    description: draft.description.trim(),
    purpose: draft.purpose.trim(),
    legal_basis: draft.legal_basis.trim(),
  };
}

function DisclosureModal({
  clientId,
  disclosure,
  onClose,
}: {
  clientId: number;
  disclosure: Disclosure | null;
  onClose: () => void;
}) {
  const { staff } = useSession();
  const queryClient = useQueryClient();
  const toast = useToast();
  const today = todayIn(staff.time_zone);
  const [draft, setDraft] = useState<DisclosureDraft>({
    disclosed_on: disclosure?.disclosed_on ?? today,
    recipient_name: disclosure?.recipient_name ?? '',
    recipient_address: disclosure?.recipient_address ?? '',
    description: disclosure?.description ?? '',
    purpose: disclosure?.purpose ?? '',
    legal_basis: disclosure?.legal_basis ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (patch: Partial<DisclosureDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const save = useMutation({
    mutationFn: () =>
      disclosure
        ? recordsApi.updateDisclosure(disclosure.id, toInput(draft))
        : recordsApi.createDisclosure(clientId, toInput(draft)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: recordKeys.disclosures(clientId) });
      toast.success(disclosure ? 'Disclosure updated' : 'Disclosure recorded');
      onClose();
    },
    onError: (error) => toast.error(error),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found = disclosureErrors(draft, today);
    setErrors(found);
    if (Object.keys(found).length === 0) save.mutate();
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={disclosure ? 'Edit disclosure' : 'Record a disclosure'}
      description="Disclosures outside treatment, payment and health care operations, for example to a court, public health authority or law enforcement."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="disclosure-form" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="disclosure-form" onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-2">
        <Field label="Date disclosed" required error={errors.disclosed_on}>
          {(props) => (
            <Input
              {...props}
              type="date"
              max={today}
              value={draft.disclosed_on}
              onChange={(event) => set({ disclosed_on: event.target.value })}
            />
          )}
        </Field>
        <Field label="Legal basis" hint="For example: court order, public health, client authorization.">
          {(props) => (
            <Input
              {...props}
              maxLength={100}
              value={draft.legal_basis}
              onChange={(event) => set({ legal_basis: event.target.value })}
            />
          )}
        </Field>
        <Field label="Recipient" required error={errors.recipient_name}>
          {(props) => (
            <Input
              {...props}
              maxLength={200}
              value={draft.recipient_name}
              onChange={(event) => set({ recipient_name: event.target.value })}
            />
          )}
        </Field>
        <Field label="Recipient's address">
          {(props) => (
            <Input
              {...props}
              maxLength={500}
              value={draft.recipient_address}
              onChange={(event) => set({ recipient_address: event.target.value })}
            />
          )}
        </Field>
        <Field label="What was disclosed" required error={errors.description} className="sm:col-span-2">
          {(props) => (
            <Textarea
              {...props}
              rows={3}
              maxLength={2000}
              value={draft.description}
              onChange={(event) => set({ description: event.target.value })}
            />
          )}
        </Field>
        <Field label="Purpose" required error={errors.purpose} className="sm:col-span-2">
          {(props) => (
            <Textarea
              {...props}
              rows={2}
              maxLength={500}
              value={draft.purpose}
              onChange={(event) => set({ purpose: event.target.value })}
            />
          )}
        </Field>
      </form>
    </Modal>
  );
}

/** The accounting of disclosures for the last six years, as the client would receive it. */
function AccountingModal({ clientId, onClose }: { clientId: number; onClose: () => void }) {
  const { staff } = useSession();
  const toast = useToast();
  const report = useQuery({
    queryKey: recordKeys.disclosureReport(clientId),
    queryFn: () => recordsApi.disclosureReport(clientId),
  });
  const download = (format: 'pdf' | 'csv') =>
    void recordsApi.downloadDisclosureReport(clientId, format).catch((error: unknown) => toast.error(error));
  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title="Accounting of disclosures"
      description={
        report.data
          ? `${formatPlainDate(report.data.period_start)} to ${formatPlainDate(report.data.period_end)} · ${report.data.practice_name}`
          : 'The last six years'
      }
      footer={
        <>
          <Button variant="secondary" onClick={() => download('csv')}>
            Download CSV
          </Button>
          <Button onClick={() => download('pdf')}>Download PDF</Button>
        </>
      }
    >
      {report.isPending && <SectionSpinner />}
      {report.isError && <ErrorState error={report.error} onRetry={() => void report.refetch()} />}
      {report.data && report.data.disclosures.length === 0 && (
        <EmptyState icon={<FileText />} title="No disclosures to account for" description="Nothing was disclosed outside treatment, payment and operations in this period." />
      )}
      {report.data && report.data.disclosures.length > 0 && (
        <ol className="divide-y divide-sage-100" aria-label="Disclosures in the accounting">
          {report.data.disclosures.map((item) => (
            <li key={item.id} className="py-3 text-sm">
              <DisclosureDetails disclosure={item} />
            </li>
          ))}
        </ol>
      )}
      {report.data && (
        <p className="mt-3 text-xs text-sage-500">Generated {formatDateTime(report.data.generated_at, staff.time_zone)}</p>
      )}
    </Modal>
  );
}

function DisclosureDetails({ disclosure }: { disclosure: Disclosure }) {
  return (
    <div className="space-y-0.5">
      <p className="font-medium text-sage-900">
        {formatPlainDate(disclosure.disclosed_on)} · {disclosure.recipient_name}
      </p>
      {disclosure.recipient_address && <p className="text-sage-600">{disclosure.recipient_address}</p>}
      <p className="whitespace-pre-wrap text-sage-800">
        <span className="font-medium">Disclosed:</span> {disclosure.description}
      </p>
      <p className="whitespace-pre-wrap text-sage-800">
        <span className="font-medium">Purpose:</span> {disclosure.purpose}
      </p>
      {disclosure.legal_basis && <p className="text-sage-600">Basis: {disclosure.legal_basis}</p>}
    </div>
  );
}

/**
 * The client's disclosure log: entries made by record requests and exports, plus disclosures made
 * outside the app entered by hand (which can be corrected or removed), and the accounting report.
 */
export function DisclosuresSection({ clientId }: { clientId: number }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<Disclosure | 'new' | null>(null);
  const [removing, setRemoving] = useState<Disclosure | null>(null);
  const [accounting, setAccounting] = useState(false);
  const disclosures = useQuery({
    queryKey: recordKeys.disclosures(clientId),
    queryFn: () => recordsApi.disclosures(clientId),
  });
  const remove = useMutation({
    mutationFn: (id: number) => recordsApi.removeDisclosure(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: recordKeys.disclosures(clientId) });
      toast.success('Disclosure removed');
      setRemoving(null);
    },
    onError: (error) => {
      setRemoving(null);
      toast.error(error);
    },
  });

  return (
    <Card>
      <CardHeader
        title="Disclosures"
        description="Information shared outside treatment, payment and operations. Clients can ask for an accounting of the last six years."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" icon={<FileText className="h-4 w-4" />} onClick={() => setAccounting(true)}>
              Accounting report
            </Button>
            <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing('new')}>
              Record disclosure
            </Button>
          </div>
        }
      />
      {disclosures.isPending && <SectionSpinner />}
      {disclosures.isError && <ErrorState error={disclosures.error} onRetry={() => void disclosures.refetch()} />}
      {disclosures.data && disclosures.data.length === 0 && (
        <p className="px-5 py-4 text-sm text-sage-500">No disclosures recorded.</p>
      )}
      {disclosures.data && disclosures.data.length > 0 && (
        <ul className="divide-y divide-sage-100" aria-label="Disclosures">
          {disclosures.data.map((item) => (
            <li key={item.id} className="flex items-start justify-between gap-3 px-5 py-3 text-sm">
              <div className="min-w-0">
                <DisclosureDetails disclosure={item} />
                <p className="mt-0.5 text-xs text-sage-500">
                  {SOURCE_LABELS[item.source]}
                  {item.recorded_by && ` by ${item.recorded_by.name}`}
                </p>
              </div>
              {item.source === 'manual' && (
                <div className="flex shrink-0">
                  <IconButton label={`Edit disclosure to ${item.recipient_name}`} onClick={() => setEditing(item)}>
                    <Pencil className="h-4 w-4" />
                  </IconButton>
                  <IconButton label={`Remove disclosure to ${item.recipient_name}`} onClick={() => setRemoving(item)}>
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing !== null && (
        <DisclosureModal clientId={clientId} disclosure={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
      {accounting && <AccountingModal clientId={clientId} onClose={() => setAccounting(false)} />}
      <ConfirmDialog
        open={removing !== null}
        title="Remove this disclosure?"
        message="Only remove entries recorded by mistake. The removal is recorded in the audit log."
        confirmLabel="Remove"
        danger
        loading={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.id)}
        onCancel={() => setRemoving(null)}
      />
    </Card>
  );
}
