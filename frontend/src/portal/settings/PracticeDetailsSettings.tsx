import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { WandSparkles } from 'lucide-react';
import { ApiError } from '../../api/client';
import { practiceApi, type BillingProvider, type Practice, type PracticeUpdate, type TaxIdType } from '../../api/practice';
import { useCan, useSession, useStaffAuth } from '../../auth/StaffAuth';
import { Button } from '../../ui/Button';
import { Field, Input, Select } from '../../ui/Form';
import { useToast } from '../../ui/Toast';
import { changedFields, fieldErrors } from '../clients/formUtils';
import { RadioCards, type RadioCardOption } from './RadioCards';
import { SettingsForm } from './SettingsForm';
import { bookingUrl, isValidNpi, isValidSlug, isValidTaxId, isValidTaxonomy, pick, slugify } from './settingsHelpers';
import { timeZoneOptions } from './timeZones';
import { useDraft } from './useDraft';

const TEXT_KEYS = [
  'name',
  'phone',
  'address_line1',
  'address_line2',
  'city',
  'state',
  'postal_code',
  'time_zone',
  'tax_id',
  'npi',
  'taxonomy_code',
] as const;

export type PracticeDraft = Pick<Practice, (typeof TEXT_KEYS)[number] | 'tax_id_type' | 'billing_provider'> & {
  booking_slug: string;
};

const BILLING_PROVIDERS: RadioCardOption<BillingProvider>[] = [
  {
    id: 'individual',
    label: 'Each clinician',
    description:
      "Claims and superbills list the clinician who saw the client, under their own NPI. Choose this if clinicians are credentialed with insurers in their own names.",
  },
  {
    id: 'organization',
    label: 'The practice',
    description:
      "Claims list the practice's group NPI and tax ID as the billing provider, with the clinician as the rendering provider. Choose this if the practice is credentialed as a group.",
  },
];

export function practiceDraft(practice: Practice): PracticeDraft {
  return {
    ...pick(practice, TEXT_KEYS),
    tax_id_type: practice.tax_id_type,
    billing_provider: practice.billing_provider,
    booking_slug: practice.booking_slug ?? '',
  };
}

export function validatePractice(draft: PracticeDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.name.trim()) errors.name = 'Enter the practice name';
  const taxId = draft.tax_id.trim();
  if (taxId && !isValidTaxId(taxId, draft.tax_id_type)) {
    errors.tax_id = draft.tax_id_type === 'EIN' ? 'An EIN looks like 12-3456789' : 'An SSN looks like 123-45-6789';
  }
  const npi = draft.npi.trim();
  if (npi && !isValidNpi(npi)) errors.npi = 'A group NPI is exactly 10 digits';
  if (!npi && draft.billing_provider === 'organization') {
    errors.npi = 'Billing as the practice needs the group NPI';
  }
  const taxonomy = draft.taxonomy_code.trim();
  if (taxonomy && !isValidTaxonomy(taxonomy)) errors.taxonomy_code = 'A taxonomy code is 10 characters, like 261QM0801X';
  const slug = draft.booking_slug.trim();
  if (slug && !isValidSlug(slug)) {
    errors.booking_slug = 'Use 3–80 lowercase letters, numbers and hyphens, starting and ending with a letter or number';
  }
  return errors;
}

/** The API payload for a draft: trimmed text, and a blank booking link as null. */
export function practiceInput(draft: PracticeDraft): PracticeUpdate {
  const input: PracticeUpdate = { tax_id_type: draft.tax_id_type, billing_provider: draft.billing_provider };
  for (const key of TEXT_KEYS) input[key] = draft[key].trim();
  input.booking_slug = draft.booking_slug.trim() || null;
  return input;
}

/** Practice name, address, time zone, billing identity and booking link (PATCH /api/practice). */
export function PracticeDetailsSettings() {
  const session = useSession();
  const { practice } = session;
  const { setSession } = useStaffAuth();
  const canEdit = useCan('manage_practice');
  const toast = useToast();
  const form = useDraft<PracticeDraft>(practiceDraft(practice));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { draft, set } = form;

  const save = useMutation({
    mutationFn: (changes: PracticeUpdate) => practiceApi.update(changes),
    onSuccess: async (updated) => {
      await setSession({ ...session, practice: updated });
      form.replace(practiceDraft(updated));
      toast.success('Practice details saved');
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) setErrors({ booking_slug: error.message });
      else if (Object.keys(fieldErrors(error)).length > 0) setErrors(fieldErrors(error));
      else toast.error(error);
    },
  });

  const submit = () => {
    const found = validatePractice(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const changes = changedFields(practice, practiceInput(draft));
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

  const slug = draft.booking_slug.trim();

  return (
    <SettingsForm
      title="Practice"
      description="Shown to clients in emails, the portal and the booking page, and printed on superbills and claims."
      dirty={form.dirty}
      saving={save.isPending}
      readOnly={!canEdit}
      onSubmit={submit}
      onDiscard={() => {
        setErrors({});
        form.discard();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">{text('name', 'Practice name', { required: true, autoComplete: 'organization' })}</div>
        {text('phone', 'Practice phone', { autoComplete: 'tel', inputMode: 'tel' })}
        <Field label="Time zone" hint="Invoices, billing days and daily reminders use this zone" error={errors.time_zone}>
          {(props) => (
            <Select {...props} value={draft.time_zone} onChange={(event) => set({ time_zone: event.target.value })}>
              {timeZoneOptions(practice.time_zone).map((zone) => (
                <option key={zone.value} value={zone.value}>
                  {zone.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {text('address_line1', 'Address line 1', { autoComplete: 'address-line1' })}
        {text('address_line2', 'Address line 2', { autoComplete: 'address-line2' })}
        {text('city', 'City', { autoComplete: 'address-level2' })}
        <div className="grid grid-cols-2 gap-4">
          {text('state', 'State', { autoComplete: 'address-level1' })}
          {text('postal_code', 'ZIP', { autoComplete: 'postal-code' })}
        </div>
      </div>

      <fieldset className="border-t border-sage-100 pt-5">
        <legend className="mb-3 text-sm font-semibold text-sage-900">Billing identity</legend>
        <div className="mb-4 grid gap-4 sm:grid-cols-2">
          <div className="grid grid-cols-[7rem_1fr] gap-2">
            <Field label="Tax ID type">
              {(props) => (
                <Select
                  {...props}
                  value={draft.tax_id_type}
                  onChange={(event) => set({ tax_id_type: event.target.value as TaxIdType })}
                >
                  <option value="EIN">EIN</option>
                  <option value="SSN">SSN</option>
                </Select>
              )}
            </Field>
            {text('tax_id', 'Tax ID', { inputMode: 'numeric' })}
          </div>
          {text('npi', 'Group NPI', { hint: "The practice's 10-digit type 2 NPI, if it has one", inputMode: 'numeric' })}
          {text('taxonomy_code', 'Practice taxonomy code', { hint: 'For example 261QM0801X (mental health clinic)', uppercase: true })}
        </div>
        <RadioCards
          legend="Who bills insurance"
          options={BILLING_PROVIDERS}
          value={draft.billing_provider}
          onChange={(billing_provider) => set({ billing_provider })}
        />
      </fieldset>

      <div className="border-t border-sage-100 pt-5">
        <Field
          label="Booking link"
          error={errors.booking_slug}
          hint={
            <span className="break-all">
              New clients request appointments at {bookingUrl(window.location.origin, slug || 'your-link')}
            </span>
          }
        >
          {(props) => (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                {...props}
                value={draft.booking_slug}
                placeholder="your-practice"
                maxLength={80}
                autoCapitalize="none"
                spellCheck={false}
                className="sm:flex-1"
                onChange={(e) => set({ booking_slug: e.target.value.toLowerCase().replace(/\s+/g, '-') })}
              />
              {!slug && (
                <Button
                  variant="secondary"
                  icon={<WandSparkles className="h-4 w-4" />}
                  onClick={() => set({ booking_slug: slugify(draft.name || practice.name) })}
                >
                  Suggest
                </Button>
              )}
            </div>
          )}
        </Field>
      </div>
    </SettingsForm>
  );
}
