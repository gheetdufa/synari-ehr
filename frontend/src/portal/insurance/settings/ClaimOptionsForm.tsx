import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { insuranceApi, insuranceKeys, type InsuranceSettings, type SupervisedBilling } from '../../../api/insurance';
import { useCan } from '../../../auth/StaffAuth';
import { Field, Input, Select, Switch } from '../../../ui/Form';
import { useToast } from '../../../ui/Toast';
import { changedFields, fieldErrors } from '../../clients/formUtils';
import { RadioCards, type RadioCardOption } from '../../settings/RadioCards';
import { SettingsForm } from '../../settings/SettingsForm';
import { useDraft } from '../../settings/useDraft';
import { TELEHEALTH_MODIFIERS } from '../labels';

type ClaimOptions = Pick<
  InsuranceSettings,
  | 'telehealth_modifier'
  | 'supervised_billing'
  | 'eligibility_auto_check'
  | 'x12_submitter_id'
  | 'x12_receiver_id'
  | 'x12_receiver_name'
>;

type EnvelopeKey = 'x12_submitter_id' | 'x12_receiver_id'; // gitleaks:allow

const SUPERVISION_OPTIONS: RadioCardOption<SupervisedBilling>[] = [
  {
    id: 'supervisor_renders',
    label: 'Supervisor renders',
    description: "The supervisor is the rendering clinician on their supervisees' claims.",
  },
  {
    id: 'supervisee_renders',
    label: 'Supervisee renders',
    description: 'The supervisee renders; the supervisor is listed as the supervising provider.',
  },
];

const ENVELOPE_ID = /^[A-Za-z0-9 ]{0,15}$/;

function optionsFrom(settings: InsuranceSettings): ClaimOptions {
  return {
    telehealth_modifier: settings.telehealth_modifier,
    supervised_billing: settings.supervised_billing,
    eligibility_auto_check: settings.eligibility_auto_check,
    x12_submitter_id: settings.x12_submitter_id,
    x12_receiver_id: settings.x12_receiver_id,
    x12_receiver_name: settings.x12_receiver_name,
  };
}

function validate(draft: ClaimOptions): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const key of ['x12_submitter_id', 'x12_receiver_id'] as EnvelopeKey[]) {
    if (!ENVELOPE_ID.test(draft[key].trim())) errors[key] = 'Use up to 15 letters, digits or spaces';
  }
  if (draft.x12_receiver_name.trim().length > 60) errors.x12_receiver_name = 'Use 60 characters or fewer';
  return errors;
}

/** Claim options (practice managers edit; everyone with billing access can read them). */
export function ClaimOptionsForm({ settings }: { settings: InsuranceSettings }) {
  const canEdit = useCan('manage_practice');
  const queryClient = useQueryClient();
  const toast = useToast();
  const source = optionsFrom(settings);
  const { draft, set, dirty, discard } = useDraft<ClaimOptions>(source);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: insuranceApi.updateSettings,
    onSuccess: (updated) => {
      queryClient.setQueryData(insuranceKeys.settings, updated);
      toast.success('Insurance settings saved');
    },
    onError: (error) => {
      const found = fieldErrors(error);
      if (Object.keys(found).length > 0) setErrors(found);
      else toast.error(error);
    },
  });

  const submit = () => {
    const found = validate(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const trimmed: ClaimOptions = {
      ...draft,
      x12_submitter_id: draft.x12_submitter_id.trim(),
      x12_receiver_id: draft.x12_receiver_id.trim(),
      x12_receiver_name: draft.x12_receiver_name.trim(),
    };
    const changes = changedFields(source, trimmed);
    if (Object.keys(changes).length > 0) save.mutate(changes);
  };

  const modifiers = TELEHEALTH_MODIFIERS.some((option) => option.code === draft.telehealth_modifier)
    ? TELEHEALTH_MODIFIERS
    : [...TELEHEALTH_MODIFIERS, { code: draft.telehealth_modifier, label: draft.telehealth_modifier }];

  const envelopeField = (key: EnvelopeKey, label: string, hint: string) => (
    <Field label={label} hint={hint} error={errors[key]}>
      {(props) => (
        <Input {...props} maxLength={15} autoComplete="off" value={draft[key]} onChange={(e) => set({ [key]: e.target.value })} />
      )}
    </Field>
  );

  return (
    <SettingsForm
      title="Claim options"
      description="How claims are filled in when you create them."
      dirty={dirty}
      saving={save.isPending}
      readOnly={!canEdit}
      onSubmit={submit}
      onDiscard={() => {
        setErrors({});
        discard();
      }}
    >
      <Field
        label="Telehealth modifier"
        hint="Added to claim lines for video sessions. Ask your payers which one they expect."
        error={errors.telehealth_modifier}
        className="sm:max-w-md"
      >
        {(props) => (
          <Select {...props} value={draft.telehealth_modifier} onChange={(e) => set({ telehealth_modifier: e.target.value })}>
            {modifiers.map((option) => (
              <option key={option.code} value={option.code}>
                {option.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <RadioCards
        legend="Supervised sessions"
        hint="How claims name the clinicians when a supervisee sees the client."
        options={SUPERVISION_OPTIONS}
        value={draft.supervised_billing}
        onChange={(supervised_billing) => set({ supervised_billing })}
      />
      <Switch
        label="Check eligibility automatically"
        description={
          settings.clearinghouse_enabled
            ? "Re-checks active insurance clients' coverage every 30 days and whenever their policy changes."
            : 'Requires a clearinghouse.'
        }
        checked={draft.eligibility_auto_check}
        disabled={!settings.clearinghouse_enabled && !draft.eligibility_auto_check}
        onChange={(eligibility_auto_check) => set({ eligibility_auto_check })}
      />
      <fieldset className="min-w-0 border-t border-sage-100 pt-5">
        <legend className="text-sm font-semibold text-sage-900">837P files for another clearinghouse</legend>
        <p className="mt-1 text-sm text-sage-600">
          If you upload claim files to a clearinghouse yourself, enter the IDs it gave you. They go in each file&apos;s
          envelope.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {envelopeField('x12_submitter_id', 'Submitter ID', 'Your ID with the clearinghouse')}
          {envelopeField('x12_receiver_id', 'Receiver ID', "The clearinghouse's own ID")}
          <Field label="Receiver name" hint="The clearinghouse's name" error={errors.x12_receiver_name}>
            {(props) => (
              <Input
                {...props}
                maxLength={60}
                value={draft.x12_receiver_name}
                onChange={(e) => set({ x12_receiver_name: e.target.value })}
              />
            )}
          </Field>
        </div>
      </fieldset>
    </SettingsForm>
  );
}
