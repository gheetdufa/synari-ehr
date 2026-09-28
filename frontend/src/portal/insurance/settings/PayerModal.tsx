import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { CLAIM_FILING_INDICATORS, insuranceApi, insuranceKeys, type Payer, type PayerInput } from '../../../api/insurance';
import { Button } from '../../../ui/Button';
import { Alert } from '../../../ui/Display';
import { Field, Input, Select, Switch, Textarea } from '../../../ui/Form';
import { Modal } from '../../../ui/Modal';
import { useToast } from '../../../ui/Toast';
import { changedFields, fieldErrors } from '../../clients/formUtils';
import { PayerSearch } from './PayerSearch';

type PayerDraft = Omit<PayerInput, 'is_active'>;
type TextKey = 'address_line1' | 'address_line2' | 'city' | 'state' | 'postal_code';

const EMPTY: PayerDraft = {
  name: '',
  external_id: '',
  address_line1: '',
  address_line2: '',
  city: '',
  state: '',
  postal_code: '',
  claim_filing_indicator: 'CI',
  era_enrolled: false,
  notes: '',
};

function draftFrom(payer: Payer | null): PayerDraft {
  if (!payer) return EMPTY;
  return {
    name: payer.name,
    external_id: payer.external_id,
    address_line1: payer.address_line1,
    address_line2: payer.address_line2,
    city: payer.city,
    state: payer.state,
    postal_code: payer.postal_code,
    claim_filing_indicator: payer.claim_filing_indicator,
    era_enrolled: payer.era_enrolled,
    notes: payer.notes,
  };
}

function trimmed(draft: PayerDraft): PayerDraft {
  return {
    ...draft,
    name: draft.name.trim(),
    external_id: draft.external_id.trim().toUpperCase(),
    address_line1: draft.address_line1.trim(),
    address_line2: draft.address_line2.trim(),
    city: draft.city.trim(),
    state: draft.state.trim().toUpperCase(),
    postal_code: draft.postal_code.trim(),
    notes: draft.notes.trim(),
  };
}

function validate(draft: PayerDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.name) errors.name = 'Enter the insurance company’s name';
  if (!/^[A-Za-z0-9]*$/.test(draft.external_id)) errors.external_id = 'Payer IDs are letters and digits only';
  if (draft.state && !/^[A-Z]{2}$/.test(draft.state)) errors.state = 'Use the two-letter state code, like NY';
  return errors;
}

/** Add or edit a payer; with a clearinghouse, look up its payer ID in the network. */
export function PayerModal({
  payer,
  clearinghouseEnabled,
  onClose,
}: {
  payer: Payer | null;
  clearinghouseEnabled: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<PayerDraft>(() => draftFrom(payer));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const set = (patch: Partial<PayerDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const save = useMutation({
    mutationFn: (input: PayerDraft) =>
      payer
        ? insuranceApi.updatePayer(payer.id, changedFields(draftFrom(payer), input))
        : insuranceApi.createPayer({ ...input, is_active: true }),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: insuranceKeys.all });
      toast.success(payer ? `${saved.name} updated` : `${saved.name} added`);
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
    const input = trimmed(draft);
    const found = validate(input);
    setErrors(found);
    if (Object.keys(found).length === 0) save.mutate(input);
  };

  const text = (key: TextKey, label: string, className = '') => (
    <Field label={label} error={errors[key]} className={className}>
      {(props) => <Input {...props} value={draft[key]} onChange={(event) => set({ [key]: event.target.value })} />}
    </Field>
  );

  const close = () => !save.isPending && onClose();

  return (
    <Modal
      open
      onClose={close}
      size="lg"
      title={payer ? `Edit ${payer.name}` : 'Add a payer'}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="payer-form" loading={save.isPending}>
            {payer ? 'Save changes' : 'Add payer'}
          </Button>
        </>
      }
    >
      <form id="payer-form" onSubmit={submit} noValidate className="space-y-4">
        {formError && <Alert tone="danger">{formError}</Alert>}
        <Field label="Name" required error={errors.name}>
          {(props) => <Input {...props} value={draft.name} onChange={(event) => set({ name: event.target.value })} />}
        </Field>
        <div>
          <div className="flex items-start gap-2">
            <Field
              label="Payer ID"
              hint="The ID your clearinghouse uses for this payer. Leave blank for payers you bill on paper."
              error={errors.external_id}
              className="flex-1"
            >
              {(props) => (
                <Input
                  {...props}
                  value={draft.external_id}
                  maxLength={50}
                  autoComplete="off"
                  onChange={(event) => set({ external_id: event.target.value.toUpperCase() })}
                />
              )}
            </Field>
            {clearinghouseEnabled && (
              <Button
                variant="secondary"
                icon={<Search className="h-4 w-4" />}
                aria-expanded={searching}
                onClick={() => setSearching((open) => !open)}
                className="mt-6"
              >
                Find payer
              </Button>
            )}
          </div>
          {searching && (
            <div className="mt-2">
              <PayerSearch
                initialQuery={draft.name}
                onPick={(result) => {
                  set({ name: result.name, external_id: result.payer_id });
                  setSearching(false);
                }}
              />
            </div>
          )}
        </div>
        <Field label="Insurance type" hint="The claim filing indicator sent on claims." error={errors.claim_filing_indicator}>
          {(props) => (
            <Select
              {...props}
              value={draft.claim_filing_indicator}
              onChange={(event) => set({ claim_filing_indicator: event.target.value })}
            >
              {CLAIM_FILING_INDICATORS.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.label} ({option.code})
                </option>
              ))}
            </Select>
          )}
        </Field>
        <fieldset className="min-w-0">
          <legend className="mb-2 text-sm font-medium text-sage-800">Claims mailing address</legend>
          <div className="grid gap-4 sm:grid-cols-6">
            {text('address_line1', 'Street address', 'sm:col-span-6')}
            {text('address_line2', 'Suite, PO box (optional)', 'sm:col-span-6')}
            {text('city', 'City', 'sm:col-span-3')}
            {text('state', 'State', 'sm:col-span-1')}
            {text('postal_code', 'ZIP code', 'sm:col-span-2')}
          </div>
        </fieldset>
        <Switch
          label="Enrolled for ERAs"
          description="You've enrolled with this payer to receive insurance payments electronically."
          checked={draft.era_enrolled}
          onChange={(era_enrolled) => set({ era_enrolled })}
        />
        <Field label="Notes" hint="Phone numbers, portal links, billing quirks. Don't include client details.">
          {(props) => <Textarea {...props} rows={3} value={draft.notes} onChange={(event) => set({ notes: event.target.value })} />}
        </Field>
      </form>
    </Modal>
  );
}
