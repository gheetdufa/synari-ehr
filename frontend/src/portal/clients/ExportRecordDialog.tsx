import { useState, type FormEvent } from 'react';
import { Download } from 'lucide-react';
import { EXPORT_PURPOSE_LABELS, clientsApi, type ExportPurpose, type ExportRequest } from '../../api/clients';
import { Button } from '../../ui/Button';
import { Alert } from '../../ui/Display';
import { Field, Input, Textarea } from '../../ui/Form';
import { Modal } from '../../ui/Modal';
import { useToast } from '../../ui/Toast';

const PURPOSE_HINTS: Record<ExportPurpose, string> = {
  treatment: 'For example, sending it to another provider treating the client.',
  payment: 'For example, an insurer reviewing a claim.',
  operations: 'For example, quality review, audits or transferring the practice.',
  client: 'The client or their personal representative asked for a copy.',
  other: 'A court order, subpoena, public health report, law enforcement or anything else. It is listed in the client’s accounting of disclosures.',
};

export interface ExportDraft {
  purpose: ExportPurpose;
  recipient_name: string;
  recipient_address: string;
  description: string;
  legal_basis: string;
}

export const EMPTY_EXPORT: ExportDraft = {
  purpose: 'treatment',
  recipient_name: '',
  recipient_address: '',
  description: '',
  legal_basis: '',
};

/** Problems with an export request: "other" disclosures need a recipient and a description. */
export function exportErrors(draft: ExportDraft): Record<string, string> {
  if (draft.purpose !== 'other') return {};
  const errors: Record<string, string> = {};
  if (!draft.recipient_name.trim()) errors.recipient_name = 'Enter who will receive the record';
  if (!draft.description.trim()) errors.description = 'Describe what is disclosed and why';
  return errors;
}

/** The request body: disclosure details only for "other". */
export function exportRequest(draft: ExportDraft): ExportRequest {
  if (draft.purpose !== 'other') return { purpose: draft.purpose };
  return {
    purpose: 'other',
    recipient_name: draft.recipient_name.trim(),
    recipient_address: draft.recipient_address.trim(),
    description: draft.description.trim(),
    legal_basis: draft.legal_basis.trim(),
  };
}

function ExportRecordDialog({
  clientId,
  includesBilling,
  onClose,
}: {
  clientId: number;
  includesBilling: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<ExportDraft>(EMPTY_EXPORT);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [exporting, setExporting] = useState(false);
  const set = (patch: Partial<ExportDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found = exportErrors(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setExporting(true);
    try {
      await clientsApi.exportRecord(clientId, exportRequest(draft));
      onClose();
    } catch (error) {
      toast.error(error);
    } finally {
      setExporting(false);
    }
  };

  const contents = includesBilling
    ? "the client's profile, appointments, notes (with their history and addenda), forms, billing, messages and documents"
    : "the client's profile, appointments, notes (with their history and addenda), forms, messages and documents (billing records need billing access)";
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Export this client's record"
      description="Why are you exporting it? The reason is recorded with the export."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="export-record" loading={exporting} icon={<Download className="h-4 w-4" />}>
            Download
          </Button>
        </>
      }
    >
      <form id="export-record" onSubmit={(event) => void submit(event)} noValidate className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium text-sage-800">Purpose</legend>
          {(Object.keys(EXPORT_PURPOSE_LABELS) as ExportPurpose[]).map((purpose) => (
            <label key={purpose} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="export-purpose"
                value={purpose}
                checked={draft.purpose === purpose}
                onChange={() => set({ purpose })}
                className="mt-0.5 h-4 w-4 accent-primary-600"
              />
              <span>
                <span className="font-medium text-sage-800">{EXPORT_PURPOSE_LABELS[purpose]}</span>
                <span className="block text-sage-500">{PURPOSE_HINTS[purpose]}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {draft.purpose === 'other' && (
          <div className="grid gap-4 rounded-lg border border-sage-200 p-4 sm:grid-cols-2">
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
            <Field label="What is disclosed and why" required error={errors.description} className="sm:col-span-2">
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
            <Field label="Legal basis" hint="For example: court order, subpoena, public health." className="sm:col-span-2">
              {(props) => (
                <Input
                  {...props}
                  maxLength={100}
                  value={draft.legal_basis}
                  onChange={(event) => set({ legal_basis: event.target.value })}
                />
              )}
            </Field>
          </div>
        )}
        <Alert tone="neutral">
          You&apos;ll download a zip with {contents}. Psychotherapy notes are never included. It contains protected health
          information, so store and share it securely.
        </Alert>
      </form>
    </Modal>
  );
}

/**
 * Downloads the client's record as a zip after asking why (needs clinical access; billing records
 * are included only for staff who also handle the client's billing).
 */
export function ExportRecordButton({ clientId, includesBilling }: { clientId: number; includesBilling: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" icon={<Download className="h-4 w-4" />} onClick={() => setOpen(true)}>
        Export record
      </Button>
      {open && <ExportRecordDialog clientId={clientId} includesBilling={includesBilling} onClose={() => setOpen(false)} />}
    </>
  );
}
