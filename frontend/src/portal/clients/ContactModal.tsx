import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { clientKeys, clientsApi, type ClientContact, type ClientDetail, type ContactInput } from '../../api/clients';
import { Button } from '../../ui/Button';
import { Alert } from '../../ui/Display';
import { Checkbox, Field, Input } from '../../ui/Form';
import { Modal } from '../../ui/Modal';
import { displayFirstName } from '../../lib/format';
import { useToast } from '../../ui/Toast';
import { contactName } from './clientHelpers';
import { blankToNull, fieldErrors, isValidEmail } from './formUtils';

const RELATION_SUGGESTIONS = ['Mother', 'Father', 'Parent', 'Legal guardian', 'Spouse', 'Partner', 'Sibling', 'Grandparent', 'Friend'];

export interface ContactDraft {
  first_name: string;
  last_name: string;
  relation: string;
  email: string;
  phone: string;
  is_guardian: boolean;
  is_emergency_contact: boolean;
  responsible_for_billing: boolean;
  portal_access: boolean;
}

export function contactDraft(contact: ClientContact | null): ContactDraft {
  return {
    first_name: contact?.first_name ?? '',
    last_name: contact?.last_name ?? '',
    relation: contact?.relation ?? '',
    email: contact?.email ?? '',
    phone: contact?.phone ?? '',
    is_guardian: contact?.is_guardian ?? false,
    is_emergency_contact: contact?.is_emergency_contact ?? false,
    responsible_for_billing: contact?.responsible_for_billing ?? false,
    portal_access: contact?.portal_access ?? false,
  };
}

/** Validate a contact form (keys match the API's fields) and build the payload. */
export function contactInput(draft: ContactDraft): { input: ContactInput; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const email = blankToNull(draft.email)?.toLowerCase() ?? null;
  if (!draft.first_name.trim()) errors.first_name = 'Enter a first name';
  if (email && !isValidEmail(email)) errors.email = 'Enter a valid email address';
  else if (!email && draft.portal_access) errors.email = 'Enter an email address to give this contact portal access';
  return {
    errors,
    input: {
      first_name: draft.first_name.trim(),
      last_name: draft.last_name.trim(),
      relation: draft.relation.trim(),
      email,
      phone: draft.phone.trim(),
      is_guardian: draft.is_guardian,
      is_emergency_contact: draft.is_emergency_contact,
      responsible_for_billing: draft.responsible_for_billing,
      portal_access: draft.portal_access,
    },
  };
}

/** Add or edit one of the client's contacts (guardian, emergency, billing, portal access). */
export function ContactModal({
  client,
  contact,
  onClose,
}: {
  client: ClientDetail;
  contact: ClientContact | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<ContactDraft>(() => contactDraft(contact));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const set = (patch: Partial<ContactDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const save = useMutation({
    mutationFn: (input: ContactInput) =>
      contact ? clientsApi.contacts.update(client.id, contact.id, input) : clientsApi.contacts.create(client.id, input),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: clientKeys.detail(client.id) });
      toast.success(contact ? `${contactName(saved)} saved` : `${contactName(saved)} was added`);
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setErrors({ email: error.message });
        return;
      }
      const found = fieldErrors(error);
      if (Object.keys(found).length > 0) setErrors(found);
      else setFormError(error.message);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    const { input, errors: found } = contactInput(draft);
    setErrors(found);
    if (Object.keys(found).length === 0) save.mutate(input);
  };

  const billingContact = client.contacts.find((other) => other.responsible_for_billing && other.id !== contact?.id);
  const clientName = displayFirstName(client);

  return (
    <Modal
      open
      onClose={() => !save.isPending && onClose()}
      title={contact ? `Edit ${contactName(contact)}` : 'Add contact'}
      description={`A parent or guardian, partner, emergency contact or someone who pays ${clientName}'s bills.`}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="client-contact-form" loading={save.isPending}>
            {contact ? 'Save contact' : 'Add contact'}
          </Button>
        </>
      }
    >
      <form id="client-contact-form" onSubmit={submit} noValidate className="space-y-4">
        {formError && <Alert tone="danger">{formError}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" required error={errors.first_name}>
            {(props) => (
              <Input {...props} autoComplete="off" value={draft.first_name} onChange={(e) => set({ first_name: e.target.value })} />
            )}
          </Field>
          <Field label="Last name" error={errors.last_name}>
            {(props) => (
              <Input {...props} autoComplete="off" value={draft.last_name} onChange={(e) => set({ last_name: e.target.value })} />
            )}
          </Field>
          <Field label="Relationship" hint={`Their relationship to ${clientName}`} error={errors.relation}>
            {(props) => (
              <>
                <Input
                  {...props}
                  list="contact-relation-suggestions"
                  maxLength={50}
                  value={draft.relation}
                  onChange={(e) => set({ relation: e.target.value })}
                />
                <datalist id="contact-relation-suggestions">
                  {RELATION_SUGGESTIONS.map((option) => (
                    <option key={option} value={option} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
          <Field label="Phone" error={errors.phone}>
            {(props) => <Input {...props} type="tel" autoComplete="off" value={draft.phone} onChange={(e) => set({ phone: e.target.value })} />}
          </Field>
          <Field label="Email" error={errors.email} className="sm:col-span-2">
            {(props) => (
              <Input {...props} type="email" autoComplete="off" value={draft.email} onChange={(e) => set({ email: e.target.value })} />
            )}
          </Field>
        </div>
        <fieldset className="space-y-3 border-t border-sage-100 pt-4">
          <legend className="sr-only">Roles</legend>
          <Checkbox
            label="Parent or legal guardian"
            description="Consents to care for a minor."
            checked={draft.is_guardian}
            onChange={(e) => set({ is_guardian: e.target.checked })}
          />
          <Checkbox
            label="Emergency contact"
            checked={draft.is_emergency_contact}
            onChange={(e) => set({ is_emergency_contact: e.target.checked })}
          />
          <Checkbox
            label="Responsible for billing"
            description={
              billingContact && draft.responsible_for_billing
                ? `Replaces ${contactName(billingContact)} as the billing contact.`
                : 'Invoices and statements are addressed to them.'
            }
            checked={draft.responsible_for_billing}
            onChange={(e) => set({ responsible_for_billing: e.target.checked })}
          />
          <Checkbox
            label="Portal access"
            description={`Signs in to ${clientName}'s portal with their own email to see appointments, forms, messages and bills.`}
            checked={draft.portal_access}
            onChange={(e) => set({ portal_access: e.target.checked })}
          />
          {contact?.portal_access && !draft.portal_access && (
            <Alert tone="warning">{contactName(contact)} will be signed out of the portal when you save.</Alert>
          )}
        </fieldset>
      </form>
    </Modal>
  );
}
