import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PLACE_OF_SERVICE_OPTIONS, practiceApi, practiceKeys, type Location, type LocationInput } from '../../../api/practice';
import { Button } from '../../../ui/Button';
import { Alert } from '../../../ui/Display';
import { Field, Input, Select, Switch } from '../../../ui/Form';
import { Modal } from '../../../ui/Modal';
import { useToast } from '../../../ui/Toast';
import { changedFields, fieldErrors } from '../../clients/formUtils';
import { OTHER_PLACE_OF_SERVICE, locationDraft, locationInput, withVideo, type LocationDraft } from './locationRules';

type AddressKey = 'address_line1' | 'address_line2' | 'city' | 'state' | 'postal_code';

/** Add or edit an office or video office. */
export function LocationModal({ location, onClose }: { location: Location | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<LocationDraft>(() => locationDraft(location));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const set = (patch: Partial<LocationDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const save = useMutation({
    mutationFn: (input: Omit<LocationInput, 'is_active'>) =>
      location
        ? practiceApi.updateLocation(location.id, changedFields(location, input))
        : practiceApi.createLocation({ ...input, is_active: true }),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: practiceKeys.locations });
      toast.success(location ? `${saved.name} updated` : `${saved.name} added`);
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
    const { input, errors: found } = locationInput(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    if (location && Object.keys(changedFields(location, input)).length === 0) {
      onClose();
      return;
    }
    save.mutate(input);
  };

  const address = (key: AddressKey, label: string, autoComplete: string) => (
    <Field label={label} error={errors[key]}>
      {(props) => (
        <Input {...props} autoComplete={autoComplete} value={draft[key]} onChange={(e) => set({ [key]: e.target.value })} />
      )}
    </Field>
  );

  const close = () => !save.isPending && onClose();

  return (
    <Modal
      open
      onClose={close}
      title={location ? `Edit ${location.name}` : 'Add location'}
      description="Where appointments take place. The place of service code is printed on claims."
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="location-form" loading={save.isPending}>
            {location ? 'Save location' : 'Add location'}
          </Button>
        </>
      }
    >
      <form id="location-form" onSubmit={submit} noValidate className="space-y-4">
        {formError && <Alert tone="danger">{formError}</Alert>}
        <Field label="Name" required error={errors.name}>
          {(props) => (
            <Input {...props} value={draft.name} maxLength={200} onChange={(e) => set({ name: e.target.value })} />
          )}
        </Field>
        <Switch
          label="Video office"
          description="For telehealth appointments. No street address is needed."
          checked={draft.is_video}
          onChange={(checked) => setDraft((current) => withVideo(current, checked))}
        />
        {!draft.is_video && (
          <div className="grid gap-4 sm:grid-cols-2">
            {address('address_line1', 'Address line 1', 'address-line1')}
            {address('address_line2', 'Address line 2', 'address-line2')}
            {address('city', 'City', 'address-level2')}
            <div className="grid grid-cols-2 gap-4">
              {address('state', 'State', 'address-level1')}
              {address('postal_code', 'ZIP', 'postal-code')}
            </div>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Place of service"
            error={draft.pos_choice === OTHER_PLACE_OF_SERVICE ? undefined : errors.place_of_service}
          >
            {(props) => (
              <Select {...props} value={draft.pos_choice} onChange={(e) => set({ pos_choice: e.target.value })}>
                {PLACE_OF_SERVICE_OPTIONS.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.code} · {option.label}
                  </option>
                ))}
                <option value={OTHER_PLACE_OF_SERVICE}>Another code…</option>
              </Select>
            )}
          </Field>
          {draft.pos_choice === OTHER_PLACE_OF_SERVICE && (
            <Field label="Code" required hint="Two digits, from the CMS place of service list" error={errors.place_of_service}>
              {(props) => (
                <Input
                  {...props}
                  inputMode="numeric"
                  maxLength={2}
                  value={draft.pos_other}
                  onChange={(e) => set({ pos_other: e.target.value.replace(/\D/g, '') })}
                />
              )}
            </Field>
          )}
        </div>
      </form>
    </Modal>
  );
}
