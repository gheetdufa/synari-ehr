import { describe, expect, it } from 'vitest';
import type { FormField, FormTemplate } from '../../api/forms';
import {
  addField,
  addOption,
  changeFieldType,
  countErrors,
  createField,
  duplicateField,
  fieldIdFor,
  fromDraft,
  moveField,
  moveOption,
  removeField,
  removeOption,
  sameContent,
  scoringFieldIds,
  setFieldId,
  setNumericValues,
  slugify,
  toDraft,
  uniqueId,
  updateField,
  updateOption,
  validateDraft,
  type DraftField,
  type TemplateDraft,
} from './templateDraft';

function template(fields: FormField[], overrides: Partial<FormTemplate> = {}): FormTemplate {
  return {
    id: 1,
    kind: 'intake',
    name: 'Check-in',
    description: '',
    requires_signature: false,
    library_key: null,
    read_only: false,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    scoring: null,
    fields,
    ...overrides,
  };
}

function draftWith(fields: FormField[]): TemplateDraft {
  return toDraft(template(fields));
}

const q = (overrides: Partial<FormField> = {}): FormField => ({ id: 'q1', type: 'short_text', label: 'Question', ...overrides });
const choice = (values: Array<string | number>, overrides: Partial<FormField> = {}): FormField =>
  q({ type: 'single_choice', options: values.map((value, index) => ({ label: `Option ${index}`, value })), ...overrides });

function problemsFor(fields: FormField[]): string[] {
  const errors = validateDraft(draftWith(fields));
  const messages = [...errors.form];
  for (const issues of Object.values(errors.fields)) {
    const { optionLabels, optionValues, ...rest } = issues;
    messages.push(...Object.values(rest).filter((value): value is string => typeof value === 'string'));
    messages.push(...Object.values(optionLabels ?? {}), ...Object.values(optionValues ?? {}));
  }
  return messages;
}

describe('field ids', () => {
  it('slugifies labels into the allowed character set', () => {
    expect(slugify('Date of birth?')).toBe('date_of_birth');
    expect(slugify('  Café — naïve résumé ')).toBe('cafe_naive_resume');
    expect(slugify('***')).toBe('');
    expect(slugify('x'.repeat(60))).toHaveLength(40);
  });

  it('adds a numeric suffix until the id is unique, staying within 40 characters', () => {
    expect(uniqueId('phone', new Set())).toBe('phone');
    expect(uniqueId('phone', new Set(['phone', 'phone_2']))).toBe('phone_3');
    const long = 'a'.repeat(40);
    const next = uniqueId(long, new Set([long]));
    expect(next).toHaveLength(40);
    expect(next.endsWith('_2')).toBe(true);
    expect(next).toMatch(/^[a-z0-9_]{1,40}$/);
  });

  it('falls back to a name based on the field type', () => {
    expect(fieldIdFor('', 'heading', new Set())).toBe('section');
    expect(fieldIdFor('', 'short_text', new Set(['question']))).toBe('question_2');
  });

  it('follows the label until edited by hand', () => {
    let fields = addField([], 'short_text').fields;
    const uid = fields[0].uid;
    fields = updateField(fields, uid, { label: 'Preferred pronouns' });
    expect(fields[0].id).toBe('preferred_pronouns');
    fields = setFieldId(fields, uid, 'pronouns');
    fields = updateField(fields, uid, { label: 'Your pronouns' });
    expect(fields[0].id).toBe('pronouns');
    expect(fields[0].autoId).toBe(false);
  });

  it('never gives two fields the same generated id', () => {
    let fields = addField([], 'short_text').fields;
    fields = addField(fields, 'short_text').fields;
    fields = updateField(fields, fields[0].uid, { label: 'Phone' });
    fields = updateField(fields, fields[1].uid, { label: 'Phone' });
    expect(fields.map((field) => field.id)).toEqual(['phone', 'phone_2']);
  });

  it('keeps saved ids fixed when a saved label changes', () => {
    const draft = draftWith([q({ id: 'nickname', label: 'Nickname' })]);
    const fields = updateField(draft.fields, draft.fields[0].uid, { label: 'What should we call you?' });
    expect(fields[0].id).toBe('nickname');
  });
});

describe('adding, moving, duplicating and removing fields', () => {
  const base = (): DraftField[] => draftWith([q({ id: 'a', label: 'A' }), q({ id: 'b', label: 'B' }), q({ id: 'c', label: 'C' })]).fields;
  const ids = (fields: DraftField[]) => fields.map((field) => field.id);

  it('adds at the end by default or at an index', () => {
    const fields = base();
    expect(ids(addField(fields, 'heading').fields)).toEqual(['a', 'b', 'c', 'section']);
    expect(ids(addField(fields, 'date', 1).fields)).toEqual(['a', 'date', 'b', 'c']);
  });

  it('creates choice fields with two starter options', () => {
    const field = createField('single_choice', new Set());
    expect(field.options.map((option) => [option.label, option.value])).toEqual([
      ['Option 1', 'option_1'],
      ['Option 2', 'option_2'],
    ]);
  });

  it('moves up and down and ignores moves past either end', () => {
    const fields = base();
    expect(ids(moveField(fields, 0, 1))).toEqual(['b', 'a', 'c']);
    expect(ids(moveField(fields, 2, -2))).toEqual(['c', 'a', 'b']);
    expect(moveField(fields, 0, -1)).toBe(fields);
    expect(moveField(fields, 2, 1)).toBe(fields);
  });

  it('removes by index', () => {
    expect(ids(removeField(base(), 1))).toEqual(['a', 'c']);
    const fields = base();
    expect(removeField(fields, 5)).toBe(fields);
  });

  it('duplicates right after the original with a fresh id and without the record mapping', () => {
    const fields = draftWith([q({ id: 'phone', label: 'Phone', maps_to: 'phone' }), q({ id: 'x', label: 'X' })]).fields;
    const { fields: next, field } = duplicateField(fields, 0);
    expect(ids(next)).toEqual(['phone', 'phone_2', 'x']);
    expect(field?.maps_to).toBeNull();
    expect(field?.uid).not.toBe(fields[0].uid);
    expect(duplicateField(fields, 9).field).toBeNull();
  });
});

describe('changing types and editing options', () => {
  it('drops settings the new type cannot have and seeds options for choice types', () => {
    const draft = draftWith([q({ id: 'phone', required: true, maps_to: 'phone' })]);
    const uid = draft.fields[0].uid;
    const asHeading = changeFieldType(draft.fields, uid, 'heading');
    expect(asHeading[0].required).toBe(false);
    expect(asHeading[0].maps_to).toBeNull();
    const asChoice = changeFieldType(draft.fields, uid, 'multi_choice');
    expect(asChoice[0].options).toHaveLength(2);
    const asLong = changeFieldType(draft.fields, uid, 'long_text');
    expect(asLong[0].maps_to).toBe('phone');
  });

  it('derives text option values from labels until the value is edited', () => {
    let fields = draftWith([choice(['a', 'b'])]).fields;
    const uid = fields[0].uid;
    fields = addOption(fields, uid);
    const added = fields[0].options[2];
    expect(added.value).toBe('option_3');
    fields = updateOption(fields, uid, added.uid, { label: 'Several days' });
    expect(fields[0].options[2].value).toBe('several_days');
    fields = updateOption(fields, uid, added.uid, { value: 'custom' });
    fields = updateOption(fields, uid, added.uid, { label: 'Most days' });
    expect(fields[0].options[2].value).toBe('custom');
  });

  it('switches between numeric and text values', () => {
    let fields = draftWith([choice(['low', 'high'])]).fields;
    const uid = fields[0].uid;
    fields = setNumericValues(fields, uid, true);
    expect(fields[0].options.map((option) => option.value)).toEqual(['0', '1']);
    fields = addOption(fields, uid);
    expect(fields[0].options[2].value).toBe('2');
    expect(fromDraft({ ...draftWith([]), fields }).fields[0].options?.map((option) => option.value)).toEqual([0, 1, 2]);
  });

  it('reorders and removes options', () => {
    let fields = draftWith([choice(['a', 'b', 'c'])]).fields;
    const uid = fields[0].uid;
    fields = moveOption(fields, uid, 2, -2);
    expect(fields[0].options.map((option) => option.value)).toEqual(['c', 'a', 'b']);
    fields = removeOption(fields, uid, fields[0].options[0].uid);
    expect(fields[0].options.map((option) => option.value)).toEqual(['a', 'b']);
  });
});

describe('validateDraft mirrors the API template rules', () => {
  it.each<[string, FormField[], string]>([
    ['no fields', [], 'Add at least one field'],
    ['duplicate ids', [q(), q({ label: 'Again' })], 'Another field already uses this ID'],
    ['id with capitals and dashes', [q({ id: 'Bad-Id' })], 'Use 1–40 lowercase letters, numbers or underscores'],
    ['id longer than 40', [q({ id: 'x'.repeat(41) })], 'Use 1–40 lowercase letters, numbers or underscores'],
    ['empty question', [q({ label: '  ' })], 'Add the question'],
    ['one option', [choice([1])], 'Add at least 2 options'],
    ['duplicate option values', [choice([1, 1])], 'Each option needs a different value'],
    ['phone filled by a choice question', [choice([0, 1], { maps_to: 'phone' })], "This kind of question can't fill in Phone"],
    ['date of birth filled by text', [q({ maps_to: 'date_of_birth' })], "This kind of question can't fill in Date of birth"],
    ['city filled by a date', [q({ type: 'date', maps_to: 'city' })], "This kind of question can't fill in City"],
    ['required heading', [q({ type: 'heading', required: true })], "Headings and text blocks can't be required"],
    ['paragraph filling a record field', [q({ type: 'paragraph', maps_to: 'city' })], "This kind of question can't fill in City"],
    [
      'two questions filling the same field',
      [q({ maps_to: 'phone' }), q({ id: 'q2', maps_to: 'phone' })],
      'Only one question can fill in Phone',
    ],
    ['more than 200 fields', Array.from({ length: 201 }, (_, n) => q({ id: `q${n}` })), 'A form can have at most 200 fields'],
    ['help text over 1000 characters', [q({ help: 'x'.repeat(1001) })], 'Keep help text to 1,000 characters'],
    ['more than 50 options', [choice(Array.from({ length: 51 }, (_, n) => n))], 'Use at most 50 options'],
  ])('%s', (_, fields, message) => {
    expect(problemsFor(fields)).toContain(message);
  });

  it('checks numeric values are whole numbers and text values are present', () => {
    let fields = draftWith([choice([0, 1])]).fields;
    const uid = fields[0].uid;
    fields = updateOption(fields, uid, fields[0].options[0].uid, { value: '1.5' });
    fields = updateOption(fields, uid, fields[0].options[1].uid, { label: '' });
    const errors = validateDraft({ ...draftWith([]), fields });
    const issues = errors.fields[uid];
    expect(Object.values(issues.optionValues ?? {})).toContain('Use a whole number');
    expect(Object.values(issues.optionLabels ?? {})).toContain('Add a label');
    expect(countErrors(errors)).toBe(2);
  });

  it('requires a template name', () => {
    const draft = { ...draftWith([q()]), name: '   ' };
    expect(validateDraft(draft).name).toBe('Give the form a name');
  });

  it('accepts the built-in style of form', () => {
    const fields: FormField[] = [
      { id: 'intro', type: 'paragraph', label: 'Please answer.' },
      { id: 'dob', type: 'date', label: 'Date of birth', required: true, maps_to: 'date_of_birth' },
      { id: 'q1', type: 'single_choice', label: 'Mood', required: true, options: [{ label: 'Low', value: 0 }, { label: 'OK', value: 1 }] },
      { id: 'ok', type: 'yes_no', label: 'OK to text?' },
    ];
    const errors = validateDraft(draftWith(fields));
    expect(countErrors(errors)).toBe(0);
  });
});

describe('conversion', () => {
  it('round-trips a saved template into the same API fields', () => {
    const fields: FormField[] = [
      { id: 'intro', type: 'heading', label: 'About you' },
      { id: 'nickname', type: 'short_text', label: 'Nickname', required: false, help: 'Optional', maps_to: 'preferred_name' },
      { id: 'q1', type: 'single_choice', label: 'Mood', required: true, options: [{ label: 'Low', value: 0 }, { label: 'OK', value: 1 }] },
    ];
    expect(fromDraft(draftWith(fields)).fields).toEqual([
      { id: 'intro', type: 'heading', label: 'About you' },
      { id: 'nickname', type: 'short_text', label: 'Nickname', required: false, help: 'Optional', maps_to: 'preferred_name' },
      { id: 'q1', type: 'single_choice', label: 'Mood', required: true, options: [{ label: 'Low', value: 0 }, { label: 'OK', value: 1 }] },
    ]);
  });

  it('drops options from non-choice fields and trims labels', () => {
    let fields = draftWith([choice(['a', 'b'], { label: '  Pick  ' })]).fields;
    fields = changeFieldType(fields, fields[0].uid, 'short_text');
    const [saved] = fromDraft({ ...draftWith([]), fields }).fields;
    expect(saved.options).toBeUndefined();
    expect(saved.label).toBe('Pick');
  });

  it('detects real changes but not new React keys', () => {
    const fields = [q({ id: 'a', label: 'A' })];
    const first = draftWith(fields);
    expect(sameContent(first, draftWith(fields))).toBe(true);
    expect(sameContent(first, { ...first, fields: updateField(first.fields, first.fields[0].uid, { required: true }) })).toBe(false);
  });

  it('lists field ids used by scoring and flags', () => {
    const ids = scoringFieldIds({
      method: 'sum',
      items: ['q1', 'q2'],
      max_score: 6,
      bands: [],
      flags: [{ item: 'safety', equals: true, reason: 'Safety' }],
    });
    expect([...ids].sort()).toEqual(['q1', 'q2', 'safety']);
    expect(scoringFieldIds(null).size).toBe(0);
  });
});
