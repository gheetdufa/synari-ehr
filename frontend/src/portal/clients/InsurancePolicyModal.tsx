import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  clientKeys,
  clientsApi,
  type InsurancePolicy,
  type InsurancePolicyFields,
  type PolicyRank,
  type SubscriberRelationship,
  type SubscriberSex,
} from '../../api/clients';
import { parseMoneyToCents } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Alert } from '../../ui/Display';
import { Field, Input, Select } from '../../ui/Form';
import { Modal } from '../../ui/Modal';
import { centsToInput } from './formUtils';

export const RANK_LABELS: Record<PolicyRank, string> = {
  primary: 'Primary',
  secondary: 'Secondary',
  other: 'Other',
};

/** The client's relationship to the subscriber (policyholder), by X12 code. */
export const RELATIONSHIP_LABELS: Record<SubscriberRelationship, string> = {
  '18': 'Self (the client is the subscriber)',
  '01': 'Spouse',
  '53': 'Life partner',
  '19': 'Child',
  '20': 'Employee',
  G8: 'Other relationship',
  '21': 'Unknown',
};

export const SELF = '18' satisfies SubscriberRelationship;

export const SEX_LABELS: Record<Exclude<SubscriberSex, ''>, string> = { F: 'Female', M: 'Male', U: 'Unknown' };

/** Common X12 claim filing indicators; blank uses the payer's. */
export const CLAIM_FILING_LABELS: Record<string, string> = {
  CI: 'Commercial insurance',
  BL: 'Blue Cross Blue Shield',
  HM: 'HMO',
  '12': 'PPO',
  '13': 'Point of service (POS)',
  '14': 'Exclusive provider (EPO)',
  MB: 'Medicare Part B',
  '16': 'Medicare Advantage HMO',
  MC: 'Medicaid',
  CH: 'TRICARE',
  VA: 'Veterans Affairs',
  WC: "Workers' compensation",
  '11': 'Other non-federal program',
  ZZ: 'Unknown',
};

/** Draft fields edited with a plain text or date input. */
type TextField = Exclude<keyof PolicyDraft, 'rank' | 'subscriber_relationship' | 'subscriber_sex'>;

export interface PolicyDraft {
  payer_id: string;
  rank: PolicyRank;
  member_id: string;
  group_number: string;
  plan_name: string;
  subscriber_relationship: SubscriberRelationship;
  subscriber_first_name: string;
  subscriber_last_name: string;
  subscriber_dob: string;
  subscriber_sex: SubscriberSex;
  subscriber_address_line1: string;
  subscriber_address_line2: string;
  subscriber_city: string;
  subscriber_state: string;
  subscriber_postal_code: string;
  claim_filing_indicator: string;
  effective_date: string;
  termination_date: string;
  copay: string;
  coinsurance: string;
}

export function policyDraft(policy: InsurancePolicy | null, defaultRank: PolicyRank): PolicyDraft {
  return {
    payer_id: policy ? String(policy.payer.id) : '',
    rank: policy?.rank ?? defaultRank,
    member_id: policy?.member_id ?? '',
    group_number: policy?.group_number ?? '',
    plan_name: policy?.plan_name ?? '',
    subscriber_relationship: policy?.subscriber_relationship ?? SELF,
    subscriber_first_name: policy?.subscriber_first_name ?? '',
    subscriber_last_name: policy?.subscriber_last_name ?? '',
    subscriber_dob: policy?.subscriber_dob ?? '',
    subscriber_sex: policy?.subscriber_sex ?? '',
    subscriber_address_line1: policy?.subscriber_address_line1 ?? '',
    subscriber_address_line2: policy?.subscriber_address_line2 ?? '',
    subscriber_city: policy?.subscriber_city ?? '',
    subscriber_state: policy?.subscriber_state ?? '',
    subscriber_postal_code: policy?.subscriber_postal_code ?? '',
    claim_filing_indicator: policy?.claim_filing_indicator ?? '',
    effective_date: policy?.effective_date ?? '',
    termination_date: policy?.termination_date ?? '',
    copay: centsToInput(policy?.copay_cents ?? null),
    coinsurance: policy && policy.coinsurance_percent !== null ? String(policy.coinsurance_percent) : '',
  };
}

const REQUIRED_SUBSCRIBER_FIELDS: [TextField | 'subscriber_sex', string][] = [
  ['subscriber_first_name', "Enter the subscriber's first name"],
  ['subscriber_last_name', "Enter the subscriber's last name"],
  ['subscriber_dob', "Enter the subscriber's date of birth"],
  ['subscriber_sex', "Choose the subscriber's sex"],
  ['subscriber_address_line1', "Enter the subscriber's address"],
  ['subscriber_city', 'Enter the city'],
  ['subscriber_state', 'Enter the state'],
  ['subscriber_postal_code', 'Enter the ZIP code'],
];

/**
 * Validate a policy form and build the API payload. When the client isn't the subscriber, the
 * subscriber's name, birth date, sex and address are required (claims need them); when they
 * are, the subscriber fields are cleared.
 */
export function policyInput(draft: PolicyDraft): { input: InsurancePolicyFields; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const isSelf = draft.subscriber_relationship === SELF;
  if (!draft.payer_id) errors.payer_id = 'Choose the insurance payer';
  if (!isSelf) {
    for (const [field, message] of REQUIRED_SUBSCRIBER_FIELDS) {
      if (!draft[field].trim()) errors[field] = message;
    }
  }
  if (draft.effective_date && draft.termination_date && draft.termination_date < draft.effective_date) {
    errors.termination_date = "The termination date can't be before the effective date";
  }
  let copay: number | null = null;
  if (draft.copay.trim()) {
    copay = parseMoneyToCents(draft.copay);
    if (copay === null) errors.copay_cents = 'Enter an amount like 25 or 25.00';
  }
  let coinsurance: number | null = null;
  if (draft.coinsurance.trim()) {
    coinsurance = Number(draft.coinsurance.trim().replace(/%$/, ''));
    if (!Number.isInteger(coinsurance) || coinsurance < 0 || coinsurance > 100) {
      errors.coinsurance_percent = 'Enter a whole percentage from 0 to 100';
    }
  }
  const subscriber = (value: string) => (isSelf ? '' : value.trim());
  return {
    errors,
    input: {
      payer_id: Number(draft.payer_id),
      rank: draft.rank,
      member_id: draft.member_id.trim(),
      group_number: draft.group_number.trim(),
      plan_name: draft.plan_name.trim(),
      subscriber_relationship: draft.subscriber_relationship,
      subscriber_first_name: subscriber(draft.subscriber_first_name),
      subscriber_last_name: subscriber(draft.subscriber_last_name),
      subscriber_dob: isSelf ? null : draft.subscriber_dob || null,
      subscriber_sex: isSelf ? '' : draft.subscriber_sex,
      subscriber_address_line1: subscriber(draft.subscriber_address_line1),
      subscriber_address_line2: subscriber(draft.subscriber_address_line2),
      subscriber_city: subscriber(draft.subscriber_city),
      subscriber_state: subscriber(draft.subscriber_state),
      subscriber_postal_code: subscriber(draft.subscriber_postal_code),
      claim_filing_indicator: draft.claim_filing_indicator,
      effective_date: draft.effective_date || null,
      termination_date: draft.termination_date || null,
      copay_cents: copay,
      coinsurance_percent: coinsurance,
    },
  };
}

/** The practice's payers as select options, keeping the policy's current payer even if it's gone. */
function PayerField({
  policy,
  value,
  error,
  onChange,
}: {
  policy: InsurancePolicy | null;
  value: string;
  error?: string;
  onChange: (payerId: string) => void;
}) {
  const payers = useQuery({ queryKey: clientKeys.payers, queryFn: clientsApi.payers });
  const options = payers.data ?? [];
  const current = policy && !options.some((payer) => payer.id === policy.payer.id) ? policy.payer : null;
  const empty = payers.data && options.length === 0 && !current;
  return (
    <div className="sm:col-span-2">
      <Field
        label="Insurance payer"
        required
        error={error ?? (payers.isError ? "Couldn't load your practice's payers" : undefined)}
        hint="From your practice's payer list"
      >
        {(props) => (
          <Select {...props} value={value} disabled={payers.isPending} onChange={(e) => onChange(e.target.value)}>
            <option value="">{payers.isPending ? 'Loading payers…' : 'Choose a payer'}</option>
            {current && <option value={current.id}>{current.name}</option>}
            {options.map((payer) => (
              <option key={payer.id} value={payer.id}>
                {payer.name}
                {payer.external_id ? ` (${payer.external_id})` : ''}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {payers.isError && (
        <Button variant="ghost" size="sm" className="mt-1" onClick={() => void payers.refetch()}>
          Try again
        </Button>
      )}
      {empty && (
        <div className="mt-2">
          <Alert tone="info">
            Your practice hasn&apos;t added any insurance payers yet. Someone who manages billing can add them in Billing.
          </Alert>
        </div>
      )}
    </div>
  );
}

/** Add or edit an insurance policy. Server errors arrive through `serverErrors` / `formError`. */
export function InsurancePolicyModal({
  policy,
  defaultRank,
  saving,
  serverErrors,
  formError,
  onClose,
  onSave,
}: {
  policy: InsurancePolicy | null;
  defaultRank: PolicyRank;
  saving: boolean;
  serverErrors: Record<string, string>;
  formError: string | null;
  onClose: () => void;
  onSave: (input: InsurancePolicyFields) => void;
}) {
  const [draft, setDraft] = useState<PolicyDraft>(() => policyDraft(policy, defaultRank));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (patch: Partial<PolicyDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const shown = { ...errors, ...serverErrors };
  const isSelf = draft.subscriber_relationship === SELF;
  const filingOptions =
    draft.claim_filing_indicator && !(draft.claim_filing_indicator in CLAIM_FILING_LABELS)
      ? { [draft.claim_filing_indicator]: draft.claim_filing_indicator, ...CLAIM_FILING_LABELS }
      : CLAIM_FILING_LABELS;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const { input, errors: found } = policyInput(draft);
    setErrors(found);
    if (Object.keys(found).length === 0) onSave(input);
  };

  const text = (field: TextField, label: string, options: { required?: boolean; type?: 'date' } = {}) => (
    <Field label={label} required={options.required} error={shown[field]}>
      {(props) => (
        <Input
          {...props}
          type={options.type ?? 'text'}
          value={draft[field]}
          onChange={(e) => set({ [field]: e.target.value })}
        />
      )}
    </Field>
  );

  return (
    <Modal
      open
      onClose={() => !saving && onClose()}
      title={policy ? 'Edit insurance policy' : 'Add insurance policy'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="insurance-policy-form" loading={saving}>
            {policy ? 'Save policy' : 'Add policy'}
          </Button>
        </>
      }
    >
      <form id="insurance-policy-form" onSubmit={submit} noValidate className="space-y-5">
        {formError && <Alert tone="danger">{formError}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <PayerField policy={policy} value={draft.payer_id} error={shown.payer_id} onChange={(payer_id) => set({ payer_id })} />
          <Field label="Coverage" error={shown.rank}>
            {(props) => (
              <Select {...props} value={draft.rank} onChange={(e) => set({ rank: e.target.value as PolicyRank })}>
                {Object.entries(RANK_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {text('member_id', 'Member ID')}
          {text('group_number', 'Group number')}
          {text('plan_name', 'Plan name')}
          {text('effective_date', 'Effective date', { type: 'date' })}
          {text('termination_date', 'Termination date', { type: 'date' })}
          <Field label="Copay" hint="Leave blank if none" error={shown.copay_cents}>
            {(props) => (
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-sage-500">$</span>
                <Input
                  {...props}
                  inputMode="decimal"
                  className="pl-7"
                  placeholder="0.00"
                  value={draft.copay}
                  onChange={(e) => set({ copay: e.target.value })}
                />
              </div>
            )}
          </Field>
          <Field label="Coinsurance" hint="Percent the client pays" error={shown.coinsurance_percent}>
            {(props) => (
              <div className="relative">
                <Input
                  {...props}
                  inputMode="numeric"
                  className="pr-8"
                  placeholder="0"
                  value={draft.coinsurance}
                  onChange={(e) => set({ coinsurance: e.target.value })}
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-sage-500">%</span>
              </div>
            )}
          </Field>
          <Field label="Claim filing indicator" hint="Only if this plan differs from the payer's" error={shown.claim_filing_indicator}>
            {(props) => (
              <Select {...props} value={draft.claim_filing_indicator} onChange={(e) => set({ claim_filing_indicator: e.target.value })}>
                <option value="">Use the payer&apos;s</option>
                {Object.entries(filingOptions).map(([code, label]) => (
                  <option key={code} value={code}>
                    {code} · {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <fieldset className="space-y-4 border-t border-sage-100 pt-4">
          <legend className="sr-only">Subscriber</legend>
          <Field label="Client's relationship to the subscriber" hint="The subscriber is the policyholder" error={shown.subscriber_relationship}>
            {(props) => (
              <Select
                {...props}
                value={draft.subscriber_relationship}
                onChange={(e) => set({ subscriber_relationship: e.target.value as SubscriberRelationship })}
              >
                {Object.entries(RELATIONSHIP_LABELS).map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {!isSelf && (
            <div className="grid gap-4 sm:grid-cols-2">
              {text('subscriber_first_name', 'Subscriber first name', { required: true })}
              {text('subscriber_last_name', 'Subscriber last name', { required: true })}
              {text('subscriber_dob', 'Subscriber date of birth', { required: true, type: 'date' })}
              <Field label="Subscriber sex" required error={shown.subscriber_sex}>
                {(props) => (
                  <Select
                    {...props}
                    value={draft.subscriber_sex}
                    onChange={(e) => set({ subscriber_sex: e.target.value as SubscriberSex })}
                  >
                    <option value="">Choose</option>
                    {Object.entries(SEX_LABELS).map(([code, label]) => (
                      <option key={code} value={code}>
                        {label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {text('subscriber_address_line1', 'Subscriber address', { required: true })}
              {text('subscriber_address_line2', 'Address line 2')}
              {text('subscriber_city', 'City', { required: true })}
              <div className="grid grid-cols-2 gap-4">
                {text('subscriber_state', 'State', { required: true })}
                {text('subscriber_postal_code', 'ZIP', { required: true })}
              </div>
            </div>
          )}
        </fieldset>
      </form>
    </Modal>
  );
}
