/**
 * Editing model for the form template builder: a draft that keeps stable React keys and raw
 * input text, pure helpers to add/move/remove fields and options, and validation that mirrors
 * the API's template rules (backend/synari/services/forms.py check_fields and schemas/forms.py).
 */
import type {
  FieldType,
  FormField,
  FormKind,
  FormTemplate,
  MappableField,
  ScoringSpec,
  TemplateInput,
} from '../../api/forms';
import {
  FIELD_ID_MAX_LENGTH,
  FIELD_ID_PATTERN,
  MAPPABLE_FIELDS,
  MAX_DESCRIPTION_LENGTH,
  MAX_FIELDS,
  MAX_HELP_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_OPTIONS,
  MAX_OPTION_LABEL_LENGTH,
  MAX_OPTION_VALUE_LENGTH,
  MAX_TEMPLATE_NAME_LENGTH,
  canMapTo,
  isChoiceType,
  isDisplayType,
} from '../../shared/forms/fieldTypes';

export interface DraftOption {
  uid: string;
  label: string;
  /** Raw input; converted to a number when the field uses numeric values. */
  value: string;
  /** Value follows the label until the editor changes it. */
  autoValue: boolean;
}

export interface DraftField {
  uid: string;
  id: string;
  /** Id follows the label until the editor changes it. */
  autoId: boolean;
  type: FieldType;
  label: string;
  required: boolean;
  help: string;
  maps_to: MappableField | null;
  /** Kept when switching away from a choice type so switching back restores them. */
  options: DraftOption[];
  numericValues: boolean;
}

export interface TemplateDraft {
  name: string;
  kind: FormKind;
  description: string;
  requires_signature: boolean;
  fields: DraftField[];
}

let uidCounter = 0;

/** A key that is unique for the lifetime of the page. */
export function newUid(): string {
  uidCounter += 1;
  return `d${uidCounter}`;
}

const DEFAULT_ID_BASE: Record<FieldType, string> = {
  heading: 'section',
  paragraph: 'text',
  short_text: 'question',
  long_text: 'question',
  date: 'date',
  single_choice: 'choice',
  multi_choice: 'choices',
  yes_no: 'yes_no',
};

/** Lowercase letters, digits and underscores from free text ("Date of birth?" -> "date_of_birth"). */
export function slugify(text: string, maxLength = FIELD_ID_MAX_LENGTH): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLength)
    .replace(/_+$/g, '');
}

/** `base`, or `base_2`, `base_3`... so it isn't in `taken`, never longer than 40 characters. */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  const root = slugify(base) || 'field';
  if (!taken.has(root)) return root;
  for (let n = 2; ; n += 1) {
    const suffix = `_${n}`;
    const candidate = `${root.slice(0, FIELD_ID_MAX_LENGTH - suffix.length).replace(/_+$/g, '')}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A field id generated from a label (or the type when the label is blank), unique in `taken`. */
export function fieldIdFor(label: string, type: FieldType, taken: ReadonlySet<string>): string {
  // Leave room for a numeric suffix so long labels still make readable ids.
  const base = slugify(label, 32) || DEFAULT_ID_BASE[type];
  return uniqueId(base, taken);
}

function idsExcept(fields: DraftField[], uid?: string): Set<string> {
  return new Set(fields.filter((field) => field.uid !== uid).map((field) => field.id));
}

function optionValueFromLabel(label: string, index: number): string {
  return slugify(label, MAX_OPTION_VALUE_LENGTH) || `option_${index + 1}`;
}

function newOption(label: string, index: number, numeric: boolean): DraftOption {
  return {
    uid: newUid(),
    label,
    value: numeric ? String(index) : optionValueFromLabel(label, index),
    autoValue: !numeric,
  };
}

function starterOptions(): DraftOption[] {
  return [newOption('Option 1', 0, false), newOption('Option 2', 1, false)];
}

/** A new, empty field of the given type with an id not in `taken`. */
export function createField(type: FieldType, taken: ReadonlySet<string>): DraftField {
  return {
    uid: newUid(),
    id: fieldIdFor('', type, taken),
    autoId: true,
    type,
    label: '',
    required: false,
    help: '',
    maps_to: null,
    options: isChoiceType(type) ? starterOptions() : [],
    numericValues: false,
  };
}

/** Insert a new field of `type` at `index` (default: the end). */
export function addField(
  fields: DraftField[],
  type: FieldType,
  index = fields.length,
): { fields: DraftField[]; field: DraftField } {
  const field = createField(type, idsExcept(fields));
  const next = [...fields];
  next.splice(Math.max(0, Math.min(index, fields.length)), 0, field);
  return { fields: next, field };
}

/** Move the field at `index` by `delta` places; unchanged when it would leave the list. */
export function moveField(fields: DraftField[], index: number, delta: number): DraftField[] {
  const target = index + delta;
  if (index < 0 || index >= fields.length || target < 0 || target >= fields.length || delta === 0) return fields;
  const next = [...fields];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}

export function removeField(fields: DraftField[], index: number): DraftField[] {
  if (index < 0 || index >= fields.length) return fields;
  return fields.filter((_, position) => position !== index);
}

/** Insert a copy right after the original, with a fresh id. Only one question may fill a record field, so the copy doesn't. */
export function duplicateField(fields: DraftField[], index: number): { fields: DraftField[]; field: DraftField | null } {
  if (index < 0 || index >= fields.length) return { fields, field: null };
  const original = fields[index];
  const copy: DraftField = {
    ...original,
    uid: newUid(),
    id: uniqueId(original.id, idsExcept(fields)),
    autoId: false,
    maps_to: null,
    options: original.options.map((option) => ({ ...option, uid: newUid() })),
  };
  const next = [...fields];
  next.splice(index + 1, 0, copy);
  return { fields: next, field: copy };
}

export type FieldChanges = Partial<Pick<DraftField, 'label' | 'required' | 'help' | 'maps_to'>>;

/** Apply edits to one field. A label change regenerates the id while it's still automatic. */
export function updateField(fields: DraftField[], uid: string, changes: FieldChanges): DraftField[] {
  return fields.map((field) => {
    if (field.uid !== uid) return field;
    const next = { ...field, ...changes };
    if (changes.label !== undefined && field.autoId) {
      next.id = fieldIdFor(changes.label, field.type, idsExcept(fields, uid));
    }
    return next;
  });
}

/** Set a field's id by hand; it stops following the label. */
export function setFieldId(fields: DraftField[], uid: string, id: string): DraftField[] {
  return fields.map((field) => (field.uid === uid ? { ...field, id, autoId: false } : field));
}

/** Change a field's type, dropping settings the new type can't have. */
export function changeFieldType(fields: DraftField[], uid: string, type: FieldType): DraftField[] {
  return fields.map((field) => {
    if (field.uid !== uid || field.type === type) return field;
    const next: DraftField = { ...field, type };
    if (isDisplayType(type)) next.required = false;
    if (next.maps_to && !canMapTo(type, next.maps_to)) next.maps_to = null;
    if (isChoiceType(type) && next.options.length === 0) next.options = starterOptions();
    if (field.autoId) next.id = fieldIdFor(field.label, type, idsExcept(fields, uid));
    return next;
  });
}

// --- Options -------------------------------------------------------------------------------

function withOptions(fields: DraftField[], uid: string, update: (field: DraftField) => Partial<DraftField>): DraftField[] {
  return fields.map((field) => (field.uid === uid ? { ...field, ...update(field) } : field));
}

function nextNumericValue(options: DraftOption[]): string {
  const numbers = options.map((option) => Number(option.value)).filter((value) => Number.isInteger(value));
  return String(numbers.length ? Math.max(...numbers) + 1 : 0);
}

export function addOption(fields: DraftField[], uid: string): DraftField[] {
  return withOptions(fields, uid, (field) => {
    const label = `Option ${field.options.length + 1}`;
    const option = newOption(label, field.options.length, field.numericValues);
    if (field.numericValues) option.value = nextNumericValue(field.options);
    return { options: [...field.options, option] };
  });
}

export function updateOption(
  fields: DraftField[],
  uid: string,
  optionUid: string,
  changes: Partial<Pick<DraftOption, 'label' | 'value'>>,
): DraftField[] {
  return withOptions(fields, uid, (field) => ({
    options: field.options.map((option, index) => {
      if (option.uid !== optionUid) return option;
      const next = { ...option, ...changes };
      if (changes.value !== undefined) next.autoValue = false;
      else if (changes.label !== undefined && option.autoValue && !field.numericValues) {
        next.value = optionValueFromLabel(changes.label, index);
      }
      return next;
    }),
  }));
}

export function removeOption(fields: DraftField[], uid: string, optionUid: string): DraftField[] {
  return withOptions(fields, uid, (field) => ({ options: field.options.filter((option) => option.uid !== optionUid) }));
}

export function moveOption(fields: DraftField[], uid: string, index: number, delta: number): DraftField[] {
  return withOptions(fields, uid, (field) => {
    const target = index + delta;
    if (target < 0 || target >= field.options.length || index < 0 || index >= field.options.length) return {};
    const options = [...field.options];
    const [moved] = options.splice(index, 1);
    options.splice(target, 0, moved);
    return { options };
  });
}

/** Switch between numeric values (for scoring) and text values. */
export function setNumericValues(fields: DraftField[], uid: string, numeric: boolean): DraftField[] {
  return withOptions(fields, uid, (field) => {
    if (field.numericValues === numeric) return {};
    const options = field.options.map((option, index) =>
      numeric
        ? { ...option, value: String(index), autoValue: false }
        : { ...option, value: optionValueFromLabel(option.label, index), autoValue: true },
    );
    return { numericValues: numeric, options };
  });
}

// --- Conversion ------------------------------------------------------------------------------

/** Build an editable draft from a saved template. Saved ids stay fixed. */
export function toDraft(template: Pick<FormTemplate, 'name' | 'kind' | 'description' | 'requires_signature' | 'fields'>): TemplateDraft {
  return {
    name: template.name,
    kind: template.kind,
    description: template.description,
    requires_signature: template.requires_signature,
    fields: template.fields.map((field) => {
      const options = field.options ?? [];
      return {
        uid: newUid(),
        id: field.id,
        autoId: false,
        type: field.type,
        label: field.label,
        required: Boolean(field.required),
        help: field.help ?? '',
        maps_to: field.maps_to ?? null,
        options: options.map((option) => ({ uid: newUid(), label: option.label, value: String(option.value), autoValue: false })),
        numericValues: options.length > 0 && options.every((option) => typeof option.value === 'number'),
      };
    }),
  };
}

/** The API field for a draft field (display text, options only on choice questions, etc.). */
export function toFormField(field: DraftField): FormField {
  const result: FormField = { id: field.id.trim(), type: field.type, label: field.label.trim() };
  if (!isDisplayType(field.type)) {
    result.required = field.required;
    if (field.help.trim()) result.help = field.help.trim();
  }
  if (field.maps_to && canMapTo(field.type, field.maps_to)) result.maps_to = field.maps_to;
  if (isChoiceType(field.type)) {
    result.options = field.options.map((option) => ({
      label: option.label.trim(),
      value: field.numericValues ? Number(option.value.trim()) : option.value.trim(),
    }));
  }
  return result;
}

/** The request body for saving a draft. */
export function fromDraft(draft: TemplateDraft): TemplateInput {
  return {
    name: draft.name.trim(),
    kind: draft.kind,
    description: draft.description,
    requires_signature: draft.requires_signature,
    fields: draft.fields.map(toFormField),
  };
}

// --- Validation ------------------------------------------------------------------------------

export interface FieldIssues {
  id?: string;
  label?: string;
  help?: string;
  required?: string;
  maps_to?: string;
  options?: string;
  optionLabels?: Record<string, string>;
  optionValues?: Record<string, string>;
}

export interface DraftErrors {
  name?: string;
  description?: string;
  /** Problems with the field list as a whole. */
  form: string[];
  /** Problems with individual fields, keyed by DraftField.uid. */
  fields: Record<string, FieldIssues>;
}

const NUMERIC_VALUE = /^-?\d{1,9}$/;

function labelProblem(field: DraftField): string | undefined {
  const label = field.label.trim();
  if (!label) {
    if (field.type === 'heading') return 'Add a heading';
    if (field.type === 'paragraph') return 'Add the text to show';
    return 'Add the question';
  }
  if (label.length > MAX_LABEL_LENGTH) return 'Keep this under 10,000 characters';
  return undefined;
}

function optionIssues(field: DraftField, issues: FieldIssues): void {
  const { options } = field;
  if (options.length < 2) issues.options = 'Add at least 2 options';
  else if (options.length > MAX_OPTIONS) issues.options = `Use at most ${MAX_OPTIONS} options`;
  const labels: Record<string, string> = {};
  const values: Record<string, string> = {};
  const seen = new Map<string, string>();
  for (const option of options) {
    const label = option.label.trim();
    if (!label) labels[option.uid] = 'Add a label';
    else if (label.length > MAX_OPTION_LABEL_LENGTH) labels[option.uid] = 'Keep labels under 500 characters';
    const value = option.value.trim();
    let key: string | null = null;
    if (field.numericValues) {
      if (!NUMERIC_VALUE.test(value)) values[option.uid] = 'Use a whole number';
      else key = String(Number(value));
    } else if (!value) {
      values[option.uid] = 'Add a value';
    } else if (value.length > MAX_OPTION_VALUE_LENGTH) {
      values[option.uid] = 'Keep values to 100 characters';
    } else {
      key = value;
    }
    if (key === null) continue;
    const first = seen.get(key);
    if (first) {
      values[option.uid] = 'Each option needs a different value';
      values[first] = 'Each option needs a different value';
    } else {
      seen.set(key, option.uid);
    }
  }
  if (Object.keys(labels).length) issues.optionLabels = labels;
  if (Object.keys(values).length) issues.optionValues = values;
}

/** Everything that would make the API reject this template, in the builder's terms. */
export function validateDraft(draft: TemplateDraft): DraftErrors {
  const errors: DraftErrors = { form: [], fields: {} };
  const name = draft.name.trim();
  if (!name) errors.name = 'Give the form a name';
  else if (name.length > MAX_TEMPLATE_NAME_LENGTH) errors.name = 'Keep the name to 200 characters or fewer';
  if (draft.description.length > MAX_DESCRIPTION_LENGTH) errors.description = 'Keep the description to 5,000 characters or fewer';
  if (draft.fields.length === 0) errors.form.push('Add at least one field');
  if (draft.fields.length > MAX_FIELDS) errors.form.push(`A form can have at most ${MAX_FIELDS} fields`);

  const idCounts = new Map<string, number>();
  const mapCounts = new Map<MappableField, number>();
  for (const field of draft.fields) {
    idCounts.set(field.id.trim(), (idCounts.get(field.id.trim()) ?? 0) + 1);
    if (field.maps_to && canMapTo(field.type, field.maps_to)) {
      mapCounts.set(field.maps_to, (mapCounts.get(field.maps_to) ?? 0) + 1);
    }
  }

  for (const field of draft.fields) {
    const issues: FieldIssues = {};
    const id = field.id.trim();
    if (!FIELD_ID_PATTERN.test(id)) issues.id = 'Use 1–40 lowercase letters, numbers or underscores';
    else if ((idCounts.get(id) ?? 0) > 1) issues.id = 'Another field already uses this ID';
    const label = labelProblem(field);
    if (label) issues.label = label;
    if (!isDisplayType(field.type) && field.help.length > MAX_HELP_LENGTH) issues.help = 'Keep help text to 1,000 characters';
    if (isDisplayType(field.type) && field.required) issues.required = "Headings and text blocks can't be required";
    if (field.maps_to) {
      const target = MAPPABLE_FIELDS[field.maps_to].label;
      if (!canMapTo(field.type, field.maps_to)) issues.maps_to = `This kind of question can't fill in ${target}`;
      else if ((mapCounts.get(field.maps_to) ?? 0) > 1) issues.maps_to = `Only one question can fill in ${target}`;
    }
    if (isChoiceType(field.type)) optionIssues(field, issues);
    if (Object.keys(issues).length) errors.fields[field.uid] = issues;
  }
  return errors;
}

/** Number of separate problems, for the "N problems to fix" summary. */
export function countErrors(errors: DraftErrors): number {
  let count = errors.form.length + (errors.name ? 1 : 0) + (errors.description ? 1 : 0);
  for (const issues of Object.values(errors.fields)) {
    const { optionLabels, optionValues, ...rest } = issues;
    count += Object.values(rest).filter(Boolean).length;
    count += Object.keys(optionLabels ?? {}).length + Object.keys(optionValues ?? {}).length;
  }
  return count;
}

/** Field ids that a template's automatic scoring or flags depend on. */
export function scoringFieldIds(scoring: ScoringSpec | null | undefined): Set<string> {
  if (!scoring) return new Set();
  return new Set([...(scoring.items ?? []), ...(scoring.flags ?? []).map((flag) => flag.item)]);
}

/** Whether two drafts would save the same template (ignores React keys and auto flags). */
export function sameContent(a: TemplateDraft, b: TemplateDraft): boolean {
  return JSON.stringify(fromDraftForCompare(a)) === JSON.stringify(fromDraftForCompare(b));
}

function fromDraftForCompare(draft: TemplateDraft) {
  return {
    name: draft.name,
    kind: draft.kind,
    description: draft.description,
    requires_signature: draft.requires_signature,
    fields: draft.fields.map((field) => ({
      id: field.id,
      type: field.type,
      label: field.label,
      required: field.required,
      help: field.help,
      maps_to: field.maps_to,
      numericValues: field.numericValues,
      options: isChoiceType(field.type) ? field.options.map((option) => [option.label, option.value]) : [],
    })),
  };
}
