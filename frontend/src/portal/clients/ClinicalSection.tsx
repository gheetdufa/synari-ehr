import { Plus, Trash2 } from 'lucide-react';
import type { ClientDetail, DiagnosisCode } from '../../api/clients';
import { Button, IconButton } from '../../ui/Button';
import { Field, Input, Textarea } from '../../ui/Form';
import { isIcd10 } from './clientHelpers';
import { useClientPermissions } from './clientPermissions';
import { DetailList, EditableSection, NotAvailable, type SectionUpdate } from './EditableSection';

export const MAX_DIAGNOSES = 12;

export interface DiagnosisRow {
  key: number;
  code: string;
  description: string;
}

interface ClinicalDraft {
  diagnosis_codes: DiagnosisRow[];
  internal_notes: string;
}

let nextRowKey = 1;
const newRow = (code = '', description = ''): DiagnosisRow => ({ key: nextRowKey++, code, description });

/** Drop rows the user left completely blank. */
export function withoutBlankRows(rows: DiagnosisRow[]): DiagnosisRow[] {
  return rows.filter((row) => row.code.trim() || row.description.trim());
}

export function clinicalUpdate(draft: ClinicalDraft): SectionUpdate {
  const errors: Record<string, string> = {};
  const codes = draft.diagnosis_codes.map((row, index) => {
    const code = row.code.trim().toUpperCase();
    if (!code) errors[`diagnosis_codes.${index}.code`] = 'Enter an ICD-10 code';
    else if (!isIcd10(code)) errors[`diagnosis_codes.${index}.code`] = `${code} is not a valid ICD-10 code`;
    return { code, description: row.description.trim() };
  });
  return { errors, update: { diagnosis_codes: codes, internal_notes: draft.internal_notes } };
}

function DiagnosisEditor({
  rows,
  errors,
  onChange,
}: {
  rows: DiagnosisRow[];
  errors: Record<string, string>;
  onChange: (rows: DiagnosisRow[]) => void;
}) {
  const update = (key: number, patch: Partial<DiagnosisRow>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  return (
    <fieldset>
      <legend className="mb-1 text-sm font-medium text-sage-800">Diagnosis codes (ICD-10)</legend>
      <p className="mb-3 text-xs text-sage-500">The first code is the primary diagnosis on superbills and claims.</p>
      {rows.length === 0 && <p className="mb-3 text-sm text-sage-500">No diagnoses recorded.</p>}
      <ul className="space-y-3">
        {rows.map((row, index) => {
          const serverError = errors[`diagnosis_codes.${index}.code`] ?? errors[`diagnosis_codes.${index}`];
          const liveError =
            row.code.trim().length >= 3 && !isIcd10(row.code) ? 'Use ICD-10 format, for example F41.1' : undefined;
          return (
            <li key={row.key} className="flex items-start gap-2">
              <Field label={<span className="sr-only">Code {index + 1}</span>} error={serverError ?? liveError} className="w-32 shrink-0">
                {(props) => (
                  <Input
                    {...props}
                    value={row.code}
                    placeholder="F41.1"
                    maxLength={10}
                    className="font-mono uppercase"
                    onChange={(e) => update(row.key, { code: e.target.value.toUpperCase() })}
                  />
                )}
              </Field>
              <Field
                label={<span className="sr-only">Description {index + 1}</span>}
                error={errors[`diagnosis_codes.${index}.description`]}
                className="min-w-0 flex-1"
              >
                {(props) => (
                  <Input
                    {...props}
                    value={row.description}
                    placeholder="Generalized anxiety disorder"
                    maxLength={200}
                    onChange={(e) => update(row.key, { description: e.target.value })}
                  />
                )}
              </Field>
              <IconButton
                label={`Remove diagnosis ${row.code || index + 1}`}
                className="mt-0.5"
                onClick={() => onChange(rows.filter((item) => item.key !== row.key))}
              >
                <Trash2 className="h-4 w-4" />
              </IconButton>
            </li>
          );
        })}
      </ul>
      {errors.diagnosis_codes && <p className="mt-2 text-sm text-red-600">{errors.diagnosis_codes}</p>}
      <Button
        variant="secondary"
        size="sm"
        className="mt-3"
        icon={<Plus className="h-4 w-4" />}
        disabled={rows.length >= MAX_DIAGNOSES}
        onClick={() => onChange([...rows, newRow()])}
      >
        Add diagnosis
      </Button>
    </fieldset>
  );
}

function DiagnosisList({ diagnoses }: { diagnoses: DiagnosisCode[] }) {
  return (
    <ul className="space-y-1">
      {diagnoses.map((diagnosis, index) => (
        <li key={`${diagnosis.code}-${index}`} className="flex gap-2">
          <span className="rounded bg-sage-100 px-1.5 font-mono text-xs leading-5 text-sage-800">{diagnosis.code}</span>
          <span>{diagnosis.description}</span>
          {index === 0 && diagnoses.length > 1 && <span className="text-xs text-sage-500">Primary</span>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Diagnoses and internal notes. Only the client's clinicians (and roles with clinical access)
 * can change them; billing staff can read the diagnoses, which go on claims.
 */
export function ClinicalSection({ client }: { client: ClientDetail }) {
  const { clinical } = useClientPermissions(client);
  return (
    <EditableSection<ClinicalDraft>
      title="Clinical"
      description="Only for staff with access to this client's chart; never shared with the client."
      editable={clinical}
      client={client}
      toDraft={(c) => ({
        diagnosis_codes: (c.diagnosis_codes ?? []).map((d) => newRow(d.code, d.description)),
        internal_notes: c.internal_notes ?? '',
      })}
      normalize={(draft) => ({ ...draft, diagnosis_codes: withoutBlankRows(draft.diagnosis_codes) })}
      toUpdate={clinicalUpdate}
      view={
        <DetailList
          items={[
            {
              label: 'Diagnoses',
              wide: true,
              value:
                client.diagnosis_codes === null ? (
                  <NotAvailable />
                ) : (
                  client.diagnosis_codes.length > 0 && <DiagnosisList diagnoses={client.diagnosis_codes} />
                ),
            },
            {
              label: 'Internal notes',
              wide: true,
              value:
                client.internal_notes === null ? (
                  <NotAvailable />
                ) : (
                  client.internal_notes && <span className="whitespace-pre-wrap">{client.internal_notes}</span>
                ),
            },
          ]}
        />
      }
    >
      {({ draft, set, errors }) => (
        <>
          <DiagnosisEditor
            rows={draft.diagnosis_codes}
            errors={errors}
            onChange={(rows) => set({ diagnosis_codes: rows })}
          />
          <Field label="Internal notes" hint="Private practice notes; not part of the clinical record" error={errors.internal_notes}>
            {(props) => (
              <Textarea
                {...props}
                rows={5}
                value={draft.internal_notes}
                onChange={(e) => set({ internal_notes: e.target.value })}
              />
            )}
          </Field>
        </>
      )}
    </EditableSection>
  );
}
