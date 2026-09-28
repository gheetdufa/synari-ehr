import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  MAX_RECIPIENT_CHARS,
  MAX_REQUEST_CHARS,
  MAX_SCOPE_CHARS,
  RECORD_DELIVERY_LABELS,
  recordKeys,
  recordsApi,
  type RecordDelivery,
} from '../../api/records';
import { useSession } from '../../auth/StaffAuth';
import { Button } from '../../ui/Button';
import { Field, Input, Textarea } from '../../ui/Form';
import { Modal } from '../../ui/Modal';
import { useToast } from '../../ui/Toast';
import { todayIn } from '../clients/clientHelpers';

export interface RecordRequestDraft {
  scope: string;
  delivery: RecordDelivery;
  recipient: string;
  receivedOn: string;
}

/** Problems with a record request entered by staff, keyed by field. */
export function recordRequestErrors(draft: RecordRequestDraft, today: string): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.scope.trim()) errors.scope = 'Describe what the client asked for';
  if (draft.delivery === 'third_party' && !draft.recipient.trim()) errors.recipient = 'Say who to send it to and where';
  if (!draft.receivedOn) errors.receivedOn = 'Enter the date the request arrived';
  else if (draft.receivedOn > today) errors.receivedOn = "The request can't arrive in the future";
  return errors;
}

/** Record a request for a copy of the record that reached the practice outside the portal. */
export function NewRecordRequestModal({ clientId, onClose }: { clientId: number; onClose: () => void }) {
  const { staff } = useSession();
  const queryClient = useQueryClient();
  const toast = useToast();
  const today = todayIn(staff.time_zone);
  const [draft, setDraft] = useState<RecordRequestDraft>({ scope: '', delivery: 'portal', recipient: '', receivedOn: today });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (patch: Partial<RecordRequestDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const create = useMutation({
    mutationFn: () =>
      recordsApi.createRequest(clientId, {
        scope: draft.scope.trim(),
        delivery: draft.delivery,
        received_at: draft.receivedOn,
        ...(draft.delivery === 'third_party' ? { recipient: draft.recipient.trim() } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: recordKeys.all });
      toast.success('Request recorded. It is due in 30 days.');
      onClose();
    },
    onError: (error) => toast.error(error),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found = recordRequestErrors(draft, today);
    setErrors(found);
    if (Object.keys(found).length === 0) create.mutate();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Record a request for records"
      description="For requests that came by letter, email or in person. Clients can also ask from their portal."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="new-record-request" loading={create.isPending}>
            Save request
          </Button>
        </>
      }
    >
      <form id="new-record-request" onSubmit={submit} noValidate className="space-y-4">
        <Field label="What they asked for" required error={errors.scope} hint="For example: complete record, or notes from 2025.">
          {(props) => (
            <Textarea
              {...props}
              rows={3}
              maxLength={MAX_SCOPE_CHARS}
              value={draft.scope}
              onChange={(event) => set({ scope: event.target.value })}
            />
          )}
        </Field>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium text-sage-800">Delivery</legend>
          {(Object.keys(RECORD_DELIVERY_LABELS) as RecordDelivery[]).map((delivery) => (
            <label key={delivery} className="flex items-center gap-2 text-sm text-sage-800">
              <input
                type="radio"
                name="delivery"
                value={delivery}
                checked={draft.delivery === delivery}
                onChange={() => set({ delivery })}
                className="h-4 w-4 accent-primary-600"
              />
              {RECORD_DELIVERY_LABELS[delivery]}
            </label>
          ))}
        </fieldset>
        {draft.delivery === 'third_party' && (
          <Field label="Recipient" required error={errors.recipient} hint="Name and address (or secure email) the client gave.">
            {(props) => (
              <Textarea
                {...props}
                rows={3}
                maxLength={MAX_RECIPIENT_CHARS}
                value={draft.recipient}
                onChange={(event) => set({ recipient: event.target.value })}
              />
            )}
          </Field>
        )}
        <Field label="Date received" required error={errors.receivedOn} hint="The 30-day deadline counts from this date." className="sm:max-w-xs">
          {(props) => (
            <Input
              {...props}
              type="date"
              max={today}
              value={draft.receivedOn}
              onChange={(event) => set({ receivedOn: event.target.value })}
            />
          )}
        </Field>
      </form>
    </Modal>
  );
}

/** Record a client's request to amend their record that reached the practice outside the portal. */
export function NewAmendmentModal({ clientId, onClose }: { clientId: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [request, setRequest] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => recordsApi.createAmendment(clientId, { request: request.trim() }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: recordKeys.all });
      toast.success('Amendment request recorded. It is due in 60 days.');
      onClose();
    },
    onError: (err) => toast.error(err),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!request.trim()) {
      setError('Describe what the client wants changed');
      return;
    }
    create.mutate();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Record an amendment request"
      description="What the client believes is wrong or missing in their record, and why."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="new-amendment" loading={create.isPending}>
            Save request
          </Button>
        </>
      }
    >
      <form id="new-amendment" onSubmit={submit} noValidate>
        <Field label="Request" required error={error}>
          {(props) => (
            <Textarea
              {...props}
              rows={5}
              maxLength={MAX_REQUEST_CHARS}
              value={request}
              onChange={(event) => {
                setRequest(event.target.value);
                if (error) setError(null);
              }}
            />
          )}
        </Field>
      </form>
    </Modal>
  );
}
