import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { StaffMember } from '../../api/auth';
import { meApi, type ProfileUpdate } from '../../api/me';
import { useSession, useStaffAuth } from '../../auth/StaffAuth';
import { Field, Input, Select, Switch } from '../../ui/Form';
import { useToast } from '../../ui/Toast';
import { changedFields, fieldErrors } from '../clients/formUtils';
import { isValidNpi, isValidTaxonomy, pick } from './settingsHelpers';
import { SettingsForm } from './SettingsForm';
import { timeZoneOptions } from './timeZones';
import { useDraft } from './useDraft';

const TEXT_KEYS = [
  'first_name',
  'last_name',
  'credentials',
  'license_number',
  'license_state',
  'npi',
  'taxonomy_code',
  'phone',
  'time_zone',
] as const;

const PROFILE_KEYS = [...TEXT_KEYS, 'accepting_new_clients'] as const;

type ProfileDraft = Pick<StaffMember, (typeof PROFILE_KEYS)[number]>;

export function validateProfile(draft: ProfileDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.first_name.trim()) errors.first_name = 'Enter your first name';
  if (!draft.last_name.trim()) errors.last_name = 'Enter your last name';
  if (draft.npi.trim() && !isValidNpi(draft.npi.trim())) errors.npi = 'An NPI is exactly 10 digits';
  if (draft.taxonomy_code.trim() && !isValidTaxonomy(draft.taxonomy_code.trim())) {
    errors.taxonomy_code = 'A taxonomy code is 10 characters, like 101YM0800X';
  }
  return errors;
}

function trimmed(draft: ProfileDraft): ProfileUpdate {
  const out: ProfileUpdate = { accepting_new_clients: draft.accepting_new_clients };
  for (const key of TEXT_KEYS) out[key] = draft[key].trim();
  return out;
}

/** Your own name, contact details and professional identifiers (PATCH /api/me). */
export function ProfileSettings() {
  const { staff } = useSession();
  const { setSession } = useStaffAuth();
  const toast = useToast();
  const form = useDraft<ProfileDraft>(pick(staff, PROFILE_KEYS));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { draft, set } = form;

  const save = useMutation({
    mutationFn: (changes: ProfileUpdate) => meApi.updateProfile(changes),
    onSuccess: async (session) => {
      await setSession(session);
      form.replace(pick(session.staff, PROFILE_KEYS));
      toast.success('Profile saved');
    },
    onError: (error) => {
      const found = fieldErrors(error);
      if (Object.keys(found).length > 0) setErrors(found);
      else toast.error(error);
    },
  });

  const submit = () => {
    const found = validateProfile(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const changes = changedFields(staff, trimmed(draft));
    if (Object.keys(changes).length > 0) save.mutate(changes);
  };

  const text = (
    key: (typeof TEXT_KEYS)[number],
    label: string,
    options: { required?: boolean; hint?: string; autoComplete?: string; inputMode?: 'numeric' | 'tel'; uppercase?: boolean } = {},
  ) => (
    <Field label={label} required={options.required} hint={options.hint} error={errors[key]}>
      {(props) => (
        <Input
          {...props}
          autoComplete={options.autoComplete}
          inputMode={options.inputMode}
          value={draft[key]}
          onChange={(event) => set({ [key]: options.uppercase ? event.target.value.toUpperCase() : event.target.value })}
        />
      )}
    </Field>
  );

  return (
    <SettingsForm
      title="My profile"
      description="Your name and credentials appear on superbills, invoices, emails and the booking page."
      dirty={form.dirty}
      saving={save.isPending}
      onSubmit={submit}
      onDiscard={() => {
        setErrors({});
        form.discard();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {text('first_name', 'First name', { required: true, autoComplete: 'given-name' })}
        {text('last_name', 'Last name', { required: true, autoComplete: 'family-name' })}
        <Field label="Sign-in email" hint="Ask your practice's owner or support to change the email you sign in with">
          {(props) => <Input {...props} value={staff.email} disabled readOnly />}
        </Field>
        {text('phone', 'Phone', { autoComplete: 'tel', inputMode: 'tel' })}
        {text('credentials', 'Credentials', { hint: 'For example LCSW, PsyD or LMFT' })}
        <Field label="Time zone" hint="Your calendar, availability and notifications use this zone" error={errors.time_zone}>
          {(props) => (
            <Select {...props} value={draft.time_zone} onChange={(event) => set({ time_zone: event.target.value })}>
              {timeZoneOptions(staff.time_zone).map((zone) => (
                <option key={zone.value} value={zone.value}>
                  {zone.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      {staff.is_clinician && (
        <>
          <fieldset className="border-t border-sage-100 pt-5">
            <legend className="mb-3 text-sm font-semibold text-sage-900">License and billing identifiers</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              {text('license_number', 'License number')}
              {text('license_state', 'License state')}
              {text('npi', 'Individual NPI', { hint: 'Your 10-digit National Provider Identifier', inputMode: 'numeric' })}
              {text('taxonomy_code', 'Taxonomy code', { hint: 'For example 101YM0800X (mental health counselor)', uppercase: true })}
            </div>
          </fieldset>
          <div className="border-t border-sage-100 pt-5">
            <Switch
              label="Accepting new clients"
              description="Whether new clients can be booked with you, including from the practice's booking page."
              checked={draft.accepting_new_clients}
              onChange={(checked) => set({ accepting_new_clients: checked })}
            />
          </div>
        </>
      )}
    </SettingsForm>
  );
}
