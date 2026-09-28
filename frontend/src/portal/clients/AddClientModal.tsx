import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { clientKeys, clientsApi, type BillingType, type ClientDetail, type ClientInput } from '../../api/clients';
import { useSession } from '../../auth/StaffAuth';
import { Button } from '../../ui/Button';
import { Alert } from '../../ui/Display';
import { Checkbox, Field, Input, Select } from '../../ui/Form';
import { Modal } from '../../ui/Modal';
import { useToast } from '../../ui/Toast';
import { BILLING_TYPE_LABELS } from './clientHelpers';
import { billsClientsOf, choosesPrimaryClinician, useClinicians } from './clientPermissions';
import { blankToNull, fieldErrors, isValidEmail } from './formUtils';

export interface NewClientDraft {
  first_name: string;
  last_name: string;
  preferred_name: string;
  email: string;
  phone: string;
  date_of_birth: string;
  /** Team member id as a string; blank until chosen (only when the adder picks it). */
  primary_clinician_id: string;
  billing_type: BillingType;
  send_portal_invite: boolean;
}

function emptyDraft(primaryClinicianId: string): NewClientDraft {
  return {
    first_name: '',
    last_name: '',
    preferred_name: '',
    email: '',
    phone: '',
    date_of_birth: '',
    primary_clinician_id: primaryClinicianId,
    billing_type: 'self_pay',
    send_portal_invite: false,
  };
}

/**
 * Client-side checks before creating a client; keys match the API's field names.
 * `choosesPrimary` is true when the adder picks the primary clinician (then it's required).
 */
export function validateNewClient(draft: NewClientDraft, today: string, choosesPrimary: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.first_name.trim()) errors.first_name = 'Enter a first name';
  if (!draft.last_name.trim()) errors.last_name = 'Enter a last name';
  if (choosesPrimary && !draft.primary_clinician_id) errors.primary_clinician_id = 'Choose a primary clinician';
  if (draft.email.trim() && !isValidEmail(draft.email)) errors.email = 'Enter a valid email address';
  if (draft.date_of_birth && (draft.date_of_birth > today || draft.date_of_birth < '1900-01-01')) {
    errors.date_of_birth = 'Enter a valid date of birth';
  }
  return errors;
}

/**
 * The create payload: blanks become omitted/null and an invite needs an email. The primary
 * clinician is sent when the adder chose one, and the billing type only when they handle
 * billing for the new client (the API refuses billing details from anyone else).
 */
export function newClientInput(
  draft: NewClientDraft,
  { choosesPrimary, setsBilling }: { choosesPrimary: boolean; setsBilling: boolean },
): ClientInput {
  const email = blankToNull(draft.email);
  return {
    first_name: draft.first_name.trim(),
    last_name: draft.last_name.trim(),
    preferred_name: draft.preferred_name.trim(),
    email,
    phone: draft.phone.trim(),
    date_of_birth: draft.date_of_birth || null,
    ...(choosesPrimary && { primary_clinician_id: Number(draft.primary_clinician_id) }),
    ...(setsBilling && { billing_type: draft.billing_type }),
    send_portal_invite: Boolean(email) && draft.send_portal_invite,
  };
}

/** "Add client" dialog; on success hands the new client to `onCreated`. */
export function AddClientModal({
  open,
  onClose,
  onCreated,
  today,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (client: ClientDetail) => void;
  today: string;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const toast = useToast();
  const choosesPrimary = choosesPrimaryClinician(session);
  const defaultPrimary = choosesPrimary && session.staff.is_clinician ? String(session.staff.id) : '';
  const clinicians = useClinicians(open && choosesPrimary);
  const [draft, setDraft] = useState<NewClientDraft>(() => emptyDraft(defaultPrimary));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const set = (patch: Partial<NewClientDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const hasEmail = draft.email.trim().length > 0;
  const primaryId = choosesPrimary ? Number(draft.primary_clinician_id) || null : session.staff.id;
  const setsBilling = billsClientsOf(session, primaryId);

  const create = useMutation({
    mutationFn: (input: ClientInput) => clientsApi.create(input),
    onSuccess: (client, input) => {
      void queryClient.invalidateQueries({ queryKey: clientKeys.all });
      toast.success(
        input.send_portal_invite ? `${client.first_name} was added and invited to the portal` : `${client.first_name} was added`,
      );
      setDraft(emptyDraft(defaultPrimary));
      onCreated(client);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setErrors({ email: error.message });
        return;
      }
      const serverErrors = fieldErrors(error);
      if (Object.keys(serverErrors).length > 0) setErrors(serverErrors);
      else setFormError(error.message);
    },
  });

  const close = () => {
    if (create.isPending) return;
    setErrors({});
    setFormError(null);
    onClose();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    const found = validateNewClient(draft, today, choosesPrimary);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    create.mutate(newClientInput(draft, { choosesPrimary, setsBilling }));
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Add client"
      description={
        choosesPrimary
          ? 'Only a name and primary clinician are required. You can fill in the rest of the chart later.'
          : 'Only a name is required. The client joins your caseload; you can fill in the rest of the chart later.'
      }
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="add-client-form" loading={create.isPending}>
            Add client
          </Button>
        </>
      }
    >
      <form id="add-client-form" onSubmit={submit} noValidate className="space-y-4">
        {formError && <Alert tone="danger">{formError}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Legal first name" required error={errors.first_name}>
            {(props) => (
              <Input
                {...props}
                autoComplete="off"
                value={draft.first_name}
                onChange={(event) => set({ first_name: event.target.value })}
              />
            )}
          </Field>
          <Field label="Legal last name" required error={errors.last_name}>
            {(props) => (
              <Input
                {...props}
                autoComplete="off"
                value={draft.last_name}
                onChange={(event) => set({ last_name: event.target.value })}
              />
            )}
          </Field>
          <Field label="Preferred name" hint="Shown throughout the app and portal" error={errors.preferred_name}>
            {(props) => (
              <Input
                {...props}
                autoComplete="off"
                value={draft.preferred_name}
                onChange={(event) => set({ preferred_name: event.target.value })}
              />
            )}
          </Field>
          <Field label="Date of birth" error={errors.date_of_birth}>
            {(props) => (
              <Input
                {...props}
                type="date"
                max={today}
                value={draft.date_of_birth}
                onChange={(event) => set({ date_of_birth: event.target.value })}
              />
            )}
          </Field>
          <Field label="Email" error={errors.email}>
            {(props) => (
              <Input
                {...props}
                type="email"
                autoComplete="off"
                value={draft.email}
                onChange={(event) =>
                  set({
                    email: event.target.value,
                    send_portal_invite: event.target.value.trim() ? draft.send_portal_invite : false,
                  })
                }
              />
            )}
          </Field>
          <Field label="Phone" error={errors.phone}>
            {(props) => (
              <Input
                {...props}
                type="tel"
                autoComplete="off"
                value={draft.phone}
                onChange={(event) => set({ phone: event.target.value })}
              />
            )}
          </Field>
          {choosesPrimary && (
            <Field
              label="Primary clinician"
              required
              error={errors.primary_clinician_id ?? (clinicians.isError ? "Couldn't load the team" : undefined)}
            >
              {(props) => (
                <Select
                  {...props}
                  value={draft.primary_clinician_id}
                  disabled={clinicians.isPending}
                  onChange={(event) => set({ primary_clinician_id: event.target.value })}
                >
                  <option value="">{clinicians.isPending ? 'Loading clinicians…' : 'Choose a clinician'}</option>
                  {(clinicians.data ?? []).map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.display_name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          {setsBilling && (
            <Field label="Billing type" error={errors.billing_type}>
              {(props) => (
                <Select
                  {...props}
                  value={draft.billing_type}
                  onChange={(event) => set({ billing_type: event.target.value as BillingType })}
                >
                  {Object.entries(BILLING_TYPE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
        </div>
        <Checkbox
          label="Send portal invitation"
          description={
            hasEmail
              ? 'Emails a secure sign-in link so they can complete forms, send secure messages and manage appointments.'
              : 'Add an email address to invite this client to the portal.'
          }
          checked={hasEmail && draft.send_portal_invite}
          disabled={!hasEmail}
          onChange={(event) => set({ send_portal_invite: event.target.checked })}
        />
      </form>
    </Modal>
  );
}
