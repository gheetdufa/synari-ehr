import { useId, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, Plus, Sparkles, Trash2 } from 'lucide-react';
import {
  estimateKeys,
  estimatesApi,
  type Estimate,
  type EstimateDraftInput,
  type EstimateOptions,
} from '../../api/estimates';
import { formatMoney } from '../../lib/format';
import { Button, IconButton } from '../../ui/Button';
import { Alert } from '../../ui/Display';
import { Checkbox, Field, Input, Select, Textarea } from '../../ui/Form';
import { Modal } from '../../ui/Modal';
import { useToast } from '../../ui/Toast';
import { MoneyInput } from '../billing/components/BillingDisplay';
import {
  FREQUENCY_SUGGESTIONS,
  MAX_DIAGNOSES,
  buildDraftPayload,
  diagnosisChoices,
  diagnosisLetter,
  draftOf,
  emptyForm,
  formFromDraft,
  formTotalCents,
  newItem,
  newSeparate,
  type EstimateForm,
  type FormErrors,
  type ItemDraft,
} from './estimateHelpers';

const NO_ERRORS: FormErrors = { items: {}, separately: {} };

/** Create or edit a draft Good Faith Estimate. Issued estimates are never edited. */
export function EstimateFormModal({
  clientId,
  options,
  today,
  estimate,
  onClose,
  onSaved,
}: {
  clientId: number;
  options: EstimateOptions;
  /** Today in the practice's time zone (YYYY-MM-DD). */
  today: string;
  /** The draft being edited; a new draft when omitted. */
  estimate?: Estimate;
  onClose: () => void;
  onSaved?: (estimate: Estimate) => void;
}) {
  const formId = useId();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<EstimateForm>(() =>
    estimate ? formFromDraft(draftOf(estimate)) : emptyForm(today, options.default_clinician_id ?? options.clinicians[0]?.id ?? null),
  );
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);
  const choices = useMemo(
    () => diagnosisChoices(options.diagnoses, estimate?.diagnosis_codes ?? []),
    [options.diagnoses, estimate?.diagnosis_codes],
  );
  const clinicians = options.clinicians;
  const clinician = clinicians.find((option) => String(option.id) === form.clinician_id);
  const locationListId = `${formId}-locations`;
  const frequencyListId = `${formId}-frequencies`;

  const save = useMutation({
    mutationFn: (payload: EstimateDraftInput) =>
      estimate ? estimatesApi.update(estimate.id, payload) : estimatesApi.create(clientId, payload),
    onSuccess: async (saved) => {
      toast.success(estimate ? 'Draft estimate saved.' : 'Draft estimate created.');
      await queryClient.invalidateQueries({ queryKey: estimateKeys.all });
      if (onSaved) onSaved(saved);
      else onClose();
    },
  });

  const set = (changes: Partial<EstimateForm>) => setForm((current) => ({ ...current, ...changes }));
  const updateItem = (key: string, changes: Partial<ItemDraft>) =>
    setForm((current) => ({
      ...current,
      items: current.items.map((item) => (item.key === key ? { ...item, ...changes } : item)),
    }));

  const toggleDiagnosis = (code: string, checked: boolean) =>
    setForm((current) => {
      const chosen = checked ? [...current.diagnoses, code] : current.diagnoses.filter((c) => c !== code);
      // Keep the letters in the order the diagnoses are listed.
      const ordered = choices.map((d) => d.code).filter((c) => chosen.includes(c));
      return {
        ...current,
        diagnoses: ordered,
        items: current.items.map((item) => ({
          ...item,
          diagnosis_codes: item.diagnosis_codes.filter((c) => ordered.includes(c)),
        })),
      };
    });

  const applySuggestion = () => {
    if (!clinician?.suggested) return;
    const suggested = formFromDraft(clinician.suggested);
    setForm((current) => ({ ...suggested, change_summary: current.change_summary, due_on: current.due_on || suggested.due_on }));
    setErrors(NO_ERRORS);
  };

  const pickService = (item: ItemDraft, serviceId: string) => {
    const service = clinician?.services.find((option) => String(option.service_id) === serviceId);
    if (!service) return;
    updateItem(item.key, {
      description: service.description,
      service_code: service.code,
      unit_fee: (service.rate_cents / 100).toFixed(2),
    });
    if (!form.primary_service.trim()) set({ primary_service: service.description });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (save.isPending) return;
    const result = buildDraftPayload(form, choices);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors(NO_ERRORS);
    save.mutate(result.payload);
  };

  const close = () => {
    if (!save.isPending) onClose();
  };
  const total = formTotalCents(form);
  const replaces = estimate?.supersedes_id != null;

  return (
    <Modal
      open
      onClose={close}
      size="xl"
      title={estimate ? 'Edit draft estimate' : 'New good faith estimate'}
      description="The expected charges for this client's care over up to 12 months. Nothing is shared with the client until you issue it."
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={save.isPending}>
            Save draft
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-6">
        {save.isError && (
          <Alert tone="danger" title="The draft wasn't saved">
            {save.error.message}
          </Alert>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Clinician" required error={errors.clinician_id}>
            {(props) => (
              <Select {...props} value={form.clinician_id} onChange={(e) => set({ clinician_id: e.target.value })}>
                <option value="">Choose a clinician…</option>
                {clinicians.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
                {estimate && !clinician && <option value={estimate.clinician_id}>{estimate.clinician_name}</option>}
              </Select>
            )}
          </Field>
          <div className="flex items-end">
            {clinician?.suggested && (
              <Button variant="secondary" icon={<Sparkles className="h-4 w-4" />} onClick={applySuggestion}>
                Use upcoming sessions
              </Button>
            )}
          </div>
        </div>

        <Field
          label="Primary service"
          required
          error={errors.primary_service}
          hint='In plain words, e.g. "Individual psychotherapy, 53 minutes".'
        >
          {(props) => (
            <Input {...props} value={form.primary_service} maxLength={300} onChange={(e) => set({ primary_service: e.target.value })} />
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Covers from" required error={errors.period_start}>
            {(props) => <Input {...props} type="date" value={form.period_start} onChange={(e) => set({ period_start: e.target.value })} />}
          </Field>
          <Field label="Through" required error={errors.period_end} hint="Up to 12 months.">
            {(props) => <Input {...props} type="date" value={form.period_end} onChange={(e) => set({ period_end: e.target.value })} />}
          </Field>
          <Field label="Give to the client by" hint="Optional due date.">
            {(props) => <Input {...props} type="date" value={form.due_on} onChange={(e) => set({ due_on: e.target.value })} />}
          </Field>
        </div>

        <fieldset>
          <legend className="text-sm font-semibold text-sage-900">Scheduled dates</legend>
          <p className="mb-2 text-xs text-sage-500">Leave empty when sessions aren't scheduled yet.</p>
          {errors.scheduled_dates && <p className="mb-2 text-sm text-red-600">{errors.scheduled_dates}</p>}
          <ul className="flex flex-wrap gap-2">
            {form.scheduled_dates.map((day, index) => (
              <li key={index} className="flex items-center gap-1">
                <Input
                  type="date"
                  aria-label={`Scheduled date ${index + 1}`}
                  value={day}
                  className="w-44"
                  onChange={(e) =>
                    set({ scheduled_dates: form.scheduled_dates.map((d, i) => (i === index ? e.target.value : d)) })
                  }
                />
                <IconButton
                  label={`Remove scheduled date ${index + 1}`}
                  onClick={() => set({ scheduled_dates: form.scheduled_dates.filter((_, i) => i !== index) })}
                >
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            variant="ghost"
            className="mt-2"
            icon={<CalendarPlus className="h-4 w-4" />}
            onClick={() => set({ scheduled_dates: [...form.scheduled_dates, form.period_start || today] })}
          >
            Add date
          </Button>
        </fieldset>

        <fieldset>
          <legend className="text-sm font-semibold text-sage-900">Diagnoses</legend>
          <p className="mb-2 text-xs text-sage-500">
            Optional until determined (for example before an initial evaluation). Up to {MAX_DIAGNOSES}; each gets a letter
            that services point to.
          </p>
          {errors.diagnoses && <p className="mb-2 text-sm text-red-600">{errors.diagnoses}</p>}
          {choices.length === 0 ? (
            <p className="text-sm text-sage-600">No diagnoses are on file for this client.</p>
          ) : (
            <ul className="space-y-2">
              {choices.map((diagnosis) => {
                const index = form.diagnoses.indexOf(diagnosis.code);
                return (
                  <li key={diagnosis.code}>
                    <Checkbox
                      checked={index >= 0}
                      onChange={(e) => toggleDiagnosis(diagnosis.code, e.target.checked)}
                      label={`${index >= 0 ? `${diagnosisLetter(index)}. ` : ''}${diagnosis.code}`}
                      description={diagnosis.description || undefined}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>

        <section aria-labelledby={`${formId}-items`}>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 id={`${formId}-items`} className="text-sm font-semibold text-sage-900">
              Services and expected charges
            </h3>
            <Button size="sm" variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => set({ items: [...form.items, newItem()] })}>
              Add service
            </Button>
          </div>
          {form.items.length === 0 && (
            <p className="rounded-lg border border-dashed border-sage-200 px-4 py-3 text-sm text-sage-600">
              Add each service with its code and fee. You need at least one to issue the estimate.
            </p>
          )}
          <ul className="space-y-3">
            {form.items.map((item, index) => {
              const itemErrors = errors.items[item.key] ?? {};
              const label = `Service ${index + 1}`;
              return (
                <li key={item.key} className="rounded-lg border border-sage-100 p-3">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-sage-800">{label}</p>
                    <div className="flex items-center gap-2">
                      {clinician && clinician.services.length > 0 && (
                        <Select
                          aria-label={`Fill ${label} from a practice service`}
                          value=""
                          className="h-9 w-56"
                          onChange={(e) => pickService(item, e.target.value)}
                        >
                          <option value="">Fill from a service…</option>
                          {clinician.services.map((service) => (
                            <option key={service.service_id} value={service.service_id}>
                              {[service.code, service.description, formatMoney(service.rate_cents)].filter(Boolean).join(' · ')}
                            </option>
                          ))}
                        </Select>
                      )}
                      <IconButton label={`Remove ${label}`} onClick={() => set({ items: form.items.filter((i) => i.key !== item.key) })}>
                        <Trash2 className="h-4 w-4" />
                      </IconButton>
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-6">
                    <Field label="Description" error={itemErrors.description} className="sm:col-span-4">
                      {(props) => (
                        <Input {...props} value={item.description} maxLength={300} onChange={(e) => updateItem(item.key, { description: e.target.value })} />
                      )}
                    </Field>
                    <Field label="Service code" error={itemErrors.service_code} className="sm:col-span-2">
                      {(props) => (
                        <Input
                          {...props}
                          value={item.service_code}
                          maxLength={20}
                          placeholder="e.g. 90837"
                          onChange={(e) => updateItem(item.key, { service_code: e.target.value })}
                        />
                      )}
                    </Field>
                    <Field label="Fee each" error={itemErrors.unit_fee} className="sm:col-span-2">
                      {(props) => <MoneyInput {...props} value={item.unit_fee} onChange={(e) => updateItem(item.key, { unit_fee: e.target.value })} />}
                    </Field>
                    <Field label="Quantity" error={itemErrors.quantity} className="sm:col-span-1">
                      {(props) => (
                        <Input
                          {...props}
                          inputMode="numeric"
                          value={item.quantity}
                          onChange={(e) => updateItem(item.key, { quantity: e.target.value })}
                        />
                      )}
                    </Field>
                    <Field label="How often" className="sm:col-span-3">
                      {(props) => (
                        <Input
                          {...props}
                          list={frequencyListId}
                          value={item.frequency}
                          maxLength={100}
                          onChange={(e) => updateItem(item.key, { frequency: e.target.value })}
                        />
                      )}
                    </Field>
                    <Field label="Where it's provided" className="sm:col-span-6">
                      {(props) => (
                        <Input
                          {...props}
                          list={locationListId}
                          value={item.location}
                          maxLength={300}
                          onChange={(e) => updateItem(item.key, { location: e.target.value })}
                        />
                      )}
                    </Field>
                  </div>
                  {form.diagnoses.length > 0 && (
                    <fieldset className="mt-3">
                      <legend className="mb-1 text-xs font-medium text-sage-600">Diagnoses for {label.toLowerCase()}</legend>
                      <div className="flex flex-wrap gap-4">
                        {form.diagnoses.map((code, letterIndex) => (
                          <Checkbox
                            key={code}
                            label={`${diagnosisLetter(letterIndex)} (${code})`}
                            checked={item.diagnosis_codes.includes(code)}
                            onChange={(e) =>
                              updateItem(item.key, {
                                diagnosis_codes: e.target.checked
                                  ? [...item.diagnosis_codes, code]
                                  : item.diagnosis_codes.filter((c) => c !== code),
                              })
                            }
                          />
                        ))}
                      </div>
                    </fieldset>
                  )}
                </li>
              );
            })}
          </ul>
          <datalist id={locationListId}>
            {options.locations.map((location) => (
              <option key={location} value={location} />
            ))}
          </datalist>
          <datalist id={frequencyListId}>
            {FREQUENCY_SUGGESTIONS.map((frequency) => (
              <option key={frequency} value={frequency} />
            ))}
          </datalist>
        </section>

        <section aria-labelledby={`${formId}-separate`}>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <h3 id={`${formId}-separate`} className="text-sm font-semibold text-sage-900">
              Scheduled separately
            </h3>
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus className="h-4 w-4" />}
              onClick={() => set({ separately: [...form.separately, newSeparate()] })}
            >
              Add item
            </Button>
          </div>
          <p className="mb-2 text-xs text-sage-500">
            Care other providers are expected to schedule (for example a psychiatric evaluation). They'll give their own
            estimates.
          </p>
          <ul className="space-y-3">
            {form.separately.map((entry, index) => (
              <li key={entry.key} className="grid gap-3 rounded-lg border border-sage-100 p-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-start">
                <Field label="Item or service" error={errors.separately[entry.key]}>
                  {(props) => (
                    <Input
                      {...props}
                      value={entry.description}
                      maxLength={300}
                      onChange={(e) =>
                        set({ separately: form.separately.map((s) => (s.key === entry.key ? { ...s, description: e.target.value } : s)) })
                      }
                    />
                  )}
                </Field>
                <Field label="Provider">
                  {(props) => (
                    <Input
                      {...props}
                      value={entry.provider}
                      maxLength={200}
                      onChange={(e) =>
                        set({ separately: form.separately.map((s) => (s.key === entry.key ? { ...s, provider: e.target.value } : s)) })
                      }
                    />
                  )}
                </Field>
                <Field label="Note">
                  {(props) => (
                    <Input
                      {...props}
                      value={entry.note}
                      maxLength={500}
                      onChange={(e) =>
                        set({ separately: form.separately.map((s) => (s.key === entry.key ? { ...s, note: e.target.value } : s)) })
                      }
                    />
                  )}
                </Field>
                <IconButton
                  label={`Remove separately scheduled item ${index + 1}`}
                  className="sm:mt-6"
                  onClick={() => set({ separately: form.separately.filter((s) => s.key !== entry.key) })}
                >
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </li>
            ))}
          </ul>
        </section>

        {replaces && (
          <Field label="What changed" required hint="Explained to the client on the new estimate.">
            {(props) => (
              <Textarea {...props} rows={2} maxLength={2000} value={form.change_summary} onChange={(e) => set({ change_summary: e.target.value })} />
            )}
          </Field>
        )}

        <Field label="Notes" hint="Printed on the estimate. Don't include clinical details.">
          {(props) => <Textarea {...props} rows={2} maxLength={4000} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />}
        </Field>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-sage-50 px-4 py-3">
          <p className="text-xs text-sage-600">Each service's total is its fee times its quantity.</p>
          <p className="text-sm text-sage-700">
            Estimated total <span className="ml-1 text-lg font-semibold tabular-nums text-sage-900">{formatMoney(total)}</span>
          </p>
        </div>
      </form>
    </Modal>
  );
}
