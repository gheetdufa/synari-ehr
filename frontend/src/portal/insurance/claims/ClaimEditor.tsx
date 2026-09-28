import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { claimsApi, claimsKeys, type ClaimDetail, type ClaimUpdate } from '../../../api/claims';
import { PLACE_OF_SERVICE_OPTIONS } from '../../../api/practice';
import { formatMoney, formatPlainDate } from '../../../lib/format';
import { Button, IconButton } from '../../../ui/Button';
import { Card, CardHeader } from '../../../ui/Card';
import { Field, Input, Select } from '../../../ui/Form';
import { useToast } from '../../../ui/Toast';
import { fieldErrors } from '../../clients/formUtils';
import { useDraft } from '../../settings/useDraft';
import { useClinicians } from '../hooks';
import { CLAIM_SECTIONS } from '../issueFixes';
import { formatDiagnosisCode, pointerLetter } from '../labels';
import {
  addDiagnosis,
  claimDraftFrom,
  claimUpdate,
  diagnosisError,
  lineErrorKey,
  moveDiagnosis,
  normalizeDiagnosis,
  removeDiagnosis,
  togglePointer,
  validateClaimDraft,
  type ClaimDraft,
  type LineDraft,
} from './claimDraft';

function Section({ id, title, description, children }: { id: string; title: string; description?: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section id={id} aria-labelledby={headingId} className="scroll-mt-24 border-t border-sage-100 px-5 py-4 first:border-t-0">
      <h3 id={headingId} className="text-sm font-semibold text-sage-900">
        {title}
      </h3>
      {description && <p className="mt-0.5 text-sm text-sage-600">{description}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Edit a draft or rejected claim: details, diagnosis order, and each line's codes and pointers. */
export function ClaimEditor({ claim }: { claim: ClaimDetail }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const clinicians = useClinicians();
  const placeListId = useId();
  const { draft, set, replace, dirty, discard } = useDraft<ClaimDraft>(claimDraftFrom(claim));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [newCode, setNewCode] = useState('');
  const [newCodeError, setNewCodeError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (update: ClaimUpdate) => claimsApi.update(claim.id, update),
    onSuccess: (updated) => {
      queryClient.setQueryData(claimsKeys.detail(claim.id), updated);
      replace(claimDraftFrom(updated));
      void queryClient.invalidateQueries({ queryKey: claimsKeys.all });
      toast.success('Claim saved');
    },
    onError: (error) => {
      if (Object.keys(fieldErrors(error)).length > 0) toast.error('Some of the changes aren’t valid. Check the codes and try again.');
      else toast.error(error);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found = validateClaimDraft(draft, claim);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const update = claimUpdate(claim, draft);
    if (Object.keys(update).length > 0) save.mutate(update);
  };

  const add = () => {
    const code = normalizeDiagnosis(newCode);
    const problem = diagnosisError(draft, code);
    setNewCodeError(problem);
    if (problem) return;
    replace(addDiagnosis(draft, code));
    setNewCode('');
  };

  const setLine = (lineId: number, change: (line: LineDraft) => LineDraft) =>
    set({ lines: draft.lines.map((line) => (line.id === lineId ? change(line) : line)) });

  const descriptions = new Map(claim.diagnoses.map((diagnosis) => [diagnosis.code, diagnosis.description]));
  const clinicianOptions = (clinicians.data ?? []).map((member) => ({ id: member.id, name: member.display_name }));
  for (const [id, name] of [
    [claim.rendering_clinician_id, claim.rendering_clinician_name],
    [claim.supervising_clinician_id, claim.supervising_clinician_name],
  ] as const) {
    if (id !== null && !clinicianOptions.some((option) => option.id === id)) clinicianOptions.push({ id, name });
  }
  const originalLines = new Map(claim.lines.map((line) => [line.id, line]));

  return (
    <Card>
      <form onSubmit={submit} noValidate aria-label="Edit claim">
        <CardHeader title="Claim" description="Changes are checked again when you save." />
        <Section id={CLAIM_SECTIONS.details} title="Details">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Place of service" hint="11 office, 10 telehealth at home, 02 telehealth elsewhere" error={errors.place_of_service}>
              {(props) => (
                <>
                  <Input
                    {...props}
                    inputMode="numeric"
                    maxLength={2}
                    list={placeListId}
                    value={draft.place_of_service}
                    onChange={(event) => set({ place_of_service: event.target.value })}
                  />
                  <datalist id={placeListId}>
                    {PLACE_OF_SERVICE_OPTIONS.map((option) => (
                      <option key={option.code} value={option.code}>
                        {option.label}
                      </option>
                    ))}
                  </datalist>
                </>
              )}
            </Field>
            <Field label="Prior authorization number" error={errors.prior_authorization_number}>
              {(props) => (
                <Input
                  {...props}
                  maxLength={50}
                  value={draft.prior_authorization_number}
                  onChange={(event) => set({ prior_authorization_number: event.target.value })}
                />
              )}
            </Field>
            <Field label="Rendering clinician">
              {(props) => (
                <Select
                  {...props}
                  value={draft.rendering_clinician_id}
                  onChange={(event) => set({ rendering_clinician_id: Number(event.target.value) })}
                >
                  {clinicianOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Supervising clinician">
              {(props) => (
                <Select
                  {...props}
                  value={draft.supervising_clinician_id ?? ''}
                  onChange={(event) =>
                    set({ supervising_clinician_id: event.target.value ? Number(event.target.value) : null })
                  }
                >
                  <option value="">None</option>
                  {clinicianOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {(claim.frequency_code !== '1' || claim.payer_claim_number) && (
              <Field
                label="Payer's claim number"
                hint="The payer's number for the original claim, from its remittance or portal."
                error={errors.payer_claim_number}
              >
                {(props) => (
                  <Input
                    {...props}
                    maxLength={50}
                    value={draft.payer_claim_number}
                    onChange={(event) => set({ payer_claim_number: event.target.value })}
                  />
                )}
              </Field>
            )}
          </div>
        </Section>

        <Section
          id={CLAIM_SECTIONS.diagnoses}
          title="Diagnoses"
          description="The first diagnosis is the primary one. Service lines point to diagnoses by letter."
        >
          {draft.diagnosis_codes.length === 0 ? (
            <p className="text-sm text-amber-800">Add at least one diagnosis before submitting.</p>
          ) : (
            <ol className="divide-y divide-sage-100 rounded-lg border border-sage-100">
              {draft.diagnosis_codes.map((code, index) => (
                <li key={code} className="flex items-center gap-3 px-3 py-2">
                  <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-100 text-xs font-semibold text-primary-800">
                    {pointerLetter(index + 1)}
                  </span>
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="font-medium text-sage-900">{formatDiagnosisCode(code)}</span>
                    {descriptions.get(code) && <span className="text-sage-600"> {descriptions.get(code)}</span>}
                  </span>
                  <IconButton
                    label={`Move ${formatDiagnosisCode(code)} up`}
                    disabled={index === 0}
                    onClick={() => replace(moveDiagnosis(draft, index, -1))}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </IconButton>
                  <IconButton
                    label={`Move ${formatDiagnosisCode(code)} down`}
                    disabled={index === draft.diagnosis_codes.length - 1}
                    onClick={() => replace(moveDiagnosis(draft, index, 1))}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </IconButton>
                  <IconButton label={`Remove ${formatDiagnosisCode(code)}`} onClick={() => replace(removeDiagnosis(draft, code))}>
                    <X className="h-4 w-4" />
                  </IconButton>
                </li>
              ))}
            </ol>
          )}
          <div className="mt-3 flex items-start gap-2 sm:max-w-md">
            <Field label="Add a diagnosis" error={newCodeError} className="flex-1">
              {(props) => (
                <Input
                  {...props}
                  placeholder="ICD-10, e.g. F41.1"
                  value={newCode}
                  onChange={(event) => setNewCode(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    add();
                  }}
                />
              )}
            </Field>
            <Button variant="secondary" className="mt-6" icon={<Plus className="h-4 w-4" />} onClick={add} disabled={!newCode.trim()}>
              Add
            </Button>
          </div>
        </Section>

        <Section id={CLAIM_SECTIONS.lines} title="Service lines">
          <ul className="space-y-3">
            {draft.lines.map((line, index) => {
              const original = originalLines.get(line.id);
              const error = (field: string) => errors[lineErrorKey(line.id, field)];
              return (
                <li key={line.id} className="rounded-lg border border-sage-100 p-3">
                  <p className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="font-medium text-sage-900">
                      Line {index + 1} · {original ? formatPlainDate(original.service_date) : ''}
                    </span>
                    <span className="tabular-nums text-sage-700">{original ? formatMoney(original.charge_cents) : ''}</span>
                  </p>
                  <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Field label="Service code" error={error('procedure_code')}>
                      {(props) => (
                        <Input
                          {...props}
                          maxLength={5}
                          value={line.procedure_code}
                          onChange={(event) => setLine(line.id, (current) => ({ ...current, procedure_code: event.target.value.toUpperCase() }))}
                        />
                      )}
                    </Field>
                    <Field label="Modifiers" error={error('modifiers')}>
                      {(props) => (
                        <Input
                          {...props}
                          placeholder="e.g. 95"
                          value={line.modifiers}
                          onChange={(event) => setLine(line.id, (current) => ({ ...current, modifiers: event.target.value.toUpperCase() }))}
                        />
                      )}
                    </Field>
                    <Field label="Units" error={error('units')}>
                      {(props) => (
                        <Input
                          {...props}
                          inputMode="numeric"
                          value={line.units}
                          onChange={(event) => setLine(line.id, (current) => ({ ...current, units: event.target.value }))}
                        />
                      )}
                    </Field>
                    <Field label="Place of service" error={error('place_of_service')}>
                      {(props) => (
                        <Input
                          {...props}
                          inputMode="numeric"
                          maxLength={2}
                          list={placeListId}
                          placeholder={draft.place_of_service}
                          value={line.place_of_service}
                          onChange={(event) => setLine(line.id, (current) => ({ ...current, place_of_service: event.target.value }))}
                        />
                      )}
                    </Field>
                  </div>
                  {draft.diagnosis_codes.length > 0 && (
                    <fieldset className="mt-3">
                      <legend className="text-sm font-medium text-sage-800">Diagnosis pointers</legend>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {draft.diagnosis_codes.map((code, codeIndex) => {
                          const position = line.pointers.indexOf(code);
                          const on = position >= 0;
                          return (
                            <button
                              key={code}
                              type="button"
                              aria-pressed={on}
                              aria-label={`Line ${index + 1} points to ${formatDiagnosisCode(code)}`}
                              onClick={() => setLine(line.id, (current) => togglePointer(current, code))}
                              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 ${
                                on
                                  ? 'border-primary-400 bg-primary-50 text-primary-800'
                                  : 'border-sage-200 text-sage-600 hover:bg-sage-50'
                              }`}
                            >
                              {pointerLetter(codeIndex + 1)} · {formatDiagnosisCode(code)}
                              {on && <span className="text-primary-600">({position + 1})</span>}
                            </button>
                          );
                        })}
                      </div>
                      {error('pointers') && <p className="mt-1 text-sm text-red-600">{error('pointers')}</p>}
                    </fieldset>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>

        <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 rounded-b-xl border-t border-sage-100 bg-sage-50/95 px-5 py-3 backdrop-blur">
          <p className="mr-auto text-sm" aria-live="polite">
            {dirty ? (
              <span className="flex items-center gap-2 font-medium text-amber-700">
                <span className="h-2 w-2 rounded-full bg-amber-500" aria-hidden="true" /> Unsaved changes
              </span>
            ) : (
              <span className="text-sage-500">All changes saved</span>
            )}
          </p>
          <Button
            variant="ghost"
            disabled={!dirty || save.isPending}
            onClick={() => {
              setErrors({});
              discard();
            }}
          >
            Discard
          </Button>
          <Button type="submit" loading={save.isPending} disabled={!dirty}>
            Save changes
          </Button>
        </div>
      </form>
    </Card>
  );
}
