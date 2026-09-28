import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { practiceApi, practiceKeys, type Service, type ServiceInput } from '../../api/practice';
import { parseMoneyToCents } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Alert } from '../../ui/Display';
import { Field, Input, Switch } from '../../ui/Form';
import { Modal } from '../../ui/Modal';
import { useToast } from '../../ui/Toast';
import { centsToInput, changedFields, fieldErrors } from '../clients/formUtils';

export interface ServiceDraft {
  code: string;
  description: string;
  duration_minutes: string;
  rate: string;
  is_default: boolean;
  is_active: boolean;
  bookable_online: boolean;
  bookable_by_new_clients: boolean;
}

export function serviceDraft(service: Service | null): ServiceDraft {
  return {
    code: service?.code ?? '',
    description: service?.description ?? '',
    duration_minutes: String(service?.duration_minutes ?? 50),
    rate: service ? centsToInput(service.rate_cents) : '',
    is_default: service?.is_default ?? false,
    is_active: service?.is_active ?? true,
    bookable_online: service?.bookable_online ?? false,
    bookable_by_new_clients: service?.bookable_by_new_clients ?? false,
  };
}

/** Validate the service form and build the API payload; keys match the API's field names. */
export function serviceInput(draft: ServiceDraft): { input: ServiceInput; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const code = draft.code.trim();
  if (!code) errors.code = 'Enter a code';
  else if (!/^[A-Za-z0-9-]{1,20}$/.test(code)) errors.code = 'Use up to 20 letters, numbers or hyphens';
  if (!draft.description.trim()) errors.description = 'Enter a description';
  const duration = Number(draft.duration_minutes);
  if (!Number.isInteger(duration) || duration < 5 || duration > 600) {
    errors.duration_minutes = 'Enter a length between 5 and 600 minutes';
  }
  const rate = draft.rate.trim() ? parseMoneyToCents(draft.rate) : 0;
  if (rate === null) errors.rate_cents = 'Enter an amount like 150 or 150.00';
  return {
    errors,
    input: {
      code,
      description: draft.description.trim(),
      duration_minutes: duration,
      rate_cents: rate ?? 0,
      is_default: draft.is_default,
      is_active: draft.is_active,
      bookable_online: draft.bookable_online,
      bookable_by_new_clients: draft.bookable_online && draft.bookable_by_new_clients,
    },
  };
}

/** Add or edit a service (code, rate, duration and online-booking options). */
export function ServiceModal({ service, onClose }: { service: Service | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<ServiceDraft>(() => serviceDraft(service));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const set = (patch: Partial<ServiceDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const save = useMutation({
    mutationFn: (input: ServiceInput) =>
      service ? practiceApi.updateService(service.id, changedFields(service, input)) : practiceApi.createService(input),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: practiceKeys.services });
      toast.success(service ? `${saved.code} updated` : `${saved.code} added`);
      onClose();
    },
    onError: (error) => {
      const found = fieldErrors(error);
      if (Object.keys(found).length > 0) setErrors(found);
      else setFormError(error.message);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    const { input, errors: found } = serviceInput(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    if (service && Object.keys(changedFields(service, input)).length === 0) {
      onClose();
      return;
    }
    save.mutate(input);
  };

  const close = () => !save.isPending && onClose();

  return (
    <Modal
      open
      onClose={close}
      title={service ? `Edit ${service.code}` : 'Add service'}
      description="Existing appointments keep the code and fee they were booked with."
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="service-form" loading={save.isPending}>
            {service ? 'Save service' : 'Add service'}
          </Button>
        </>
      }
    >
      <form id="service-form" onSubmit={submit} noValidate className="space-y-4">
        {formError && <Alert tone="danger">{formError}</Alert>}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Code" required hint="CPT or your own code" error={errors.code}>
            {(props) => (
              <Input {...props} value={draft.code} maxLength={20} onChange={(e) => set({ code: e.target.value })} />
            )}
          </Field>
          <Field label="Description" required error={errors.description} className="sm:col-span-2">
            {(props) => (
              <Input
                {...props}
                value={draft.description}
                maxLength={200}
                onChange={(e) => set({ description: e.target.value })}
              />
            )}
          </Field>
          <Field label="Length (minutes)" required error={errors.duration_minutes}>
            {(props) => (
              <Input
                {...props}
                type="number"
                inputMode="numeric"
                min={5}
                max={600}
                step={5}
                value={draft.duration_minutes}
                onChange={(e) => set({ duration_minutes: e.target.value })}
              />
            )}
          </Field>
          <Field label="Rate" hint="Clients never see rates when booking" error={errors.rate_cents}>
            {(props) => (
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-sage-500">$</span>
                <Input
                  {...props}
                  inputMode="decimal"
                  placeholder="0.00"
                  className="pl-7"
                  value={draft.rate}
                  onChange={(e) => set({ rate: e.target.value })}
                />
              </div>
            )}
          </Field>
        </div>
        <div className="space-y-4 border-t border-sage-100 pt-4">
          <Switch
            label="Default service"
            description="Pre-selected for new appointments. Only one service can be the default."
            checked={draft.is_default}
            onChange={(checked) => set({ is_default: checked })}
          />
          <Switch
            label="Active"
            description="Inactive services can't be chosen for new appointments."
            checked={draft.is_active}
            onChange={(checked) => set({ is_active: checked })}
          />
          <Switch
            label="Allow online requests"
            description="Existing clients can request this service from the portal."
            checked={draft.bookable_online}
            onChange={(checked) => set({ bookable_online: checked })}
          />
          <Switch
            label="Allow requests from new clients"
            description="Offered on your public booking page."
            checked={draft.bookable_online && draft.bookable_by_new_clients}
            disabled={!draft.bookable_online}
            onChange={(checked) => set({ bookable_by_new_clients: checked })}
          />
        </div>
      </form>
    </Modal>
  );
}
