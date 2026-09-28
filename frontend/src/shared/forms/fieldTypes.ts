import type { FieldType, FormField, MappableField } from '../../api/forms';

/** Limits enforced by the API (backend/synari/services/forms.py and schemas/forms.py). */
export const FIELD_ID_PATTERN = /^[a-z0-9_]{1,40}$/;
export const FIELD_ID_MAX_LENGTH = 40;
export const MAX_FIELDS = 200;
export const MAX_OPTIONS = 50;
export const MAX_ANSWER_LENGTH = 5000;
export const MAX_LABEL_LENGTH = 10_000;
export const MAX_HELP_LENGTH = 1000;
export const MAX_OPTION_LABEL_LENGTH = 500;
export const MAX_OPTION_VALUE_LENGTH = 100;
export const MAX_TEMPLATE_NAME_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 5000;
export const SIGNATURE_MIN_LENGTH = 2;
export const SIGNATURE_MAX_LENGTH = 200;

/** Red outline for inputs marked aria-invalid (added to the shared ui/ controls' classes). */
export const INVALID_CONTROL = 'aria-[invalid=true]:border-red-400 aria-[invalid=true]:focus:ring-red-200';

export const FIELD_TYPES: FieldType[] = [
  'heading',
  'paragraph',
  'short_text',
  'long_text',
  'date',
  'single_choice',
  'multi_choice',
  'yes_no',
];

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  heading: 'Section heading',
  paragraph: 'Text block',
  short_text: 'Short answer',
  long_text: 'Long answer',
  date: 'Date',
  single_choice: 'Single choice',
  multi_choice: 'Checkboxes',
  yes_no: 'Yes / No',
};

export const FIELD_TYPE_DESCRIPTIONS: Record<FieldType, string> = {
  heading: 'Starts a new section',
  paragraph: 'Instructions or consent text',
  short_text: 'One line of text',
  long_text: 'Several sentences',
  date: 'A calendar date',
  single_choice: 'Pick one option',
  multi_choice: 'Pick any options',
  yes_no: 'Yes or no',
};

export function isDisplayType(type: FieldType): boolean {
  return type === 'heading' || type === 'paragraph';
}

export function isChoiceType(type: FieldType): boolean {
  return type === 'single_choice' || type === 'multi_choice';
}

export function isTextType(type: FieldType): boolean {
  return type === 'short_text' || type === 'long_text';
}

/** Fields that take an answer (everything except headings and paragraphs). */
export function answerableFields(fields: FormField[]): FormField[] {
  return fields.filter((field) => !isDisplayType(field.type));
}

interface MappableInfo {
  label: string;
  /** Column length on the client record; answers that fill it can't be longer. */
  maxLength: number;
}

/** Client record fields a question can fill in, in display order (the backend allowlist). */
export const MAPPABLE_FIELDS: Record<MappableField, MappableInfo> = {
  preferred_name: { label: 'Preferred name', maxLength: 100 },
  pronouns: { label: 'Pronouns', maxLength: 50 },
  date_of_birth: { label: 'Date of birth', maxLength: 10 },
  gender_identity: { label: 'Gender identity', maxLength: 100 },
  phone: { label: 'Phone', maxLength: 30 },
  address_line1: { label: 'Street address', maxLength: 200 },
  address_line2: { label: 'Address line 2', maxLength: 200 },
  city: { label: 'City', maxLength: 100 },
  state: { label: 'State', maxLength: 50 },
  postal_code: { label: 'ZIP / postal code', maxLength: 20 },
  emergency_contact_name: { label: 'Emergency contact name', maxLength: 200 },
  emergency_contact_phone: { label: 'Emergency contact phone', maxLength: 30 },
  emergency_contact_relationship: { label: 'Emergency contact relationship', maxLength: 100 },
};

export const MAPPABLE_FIELD_IDS = Object.keys(MAPPABLE_FIELDS) as MappableField[];

/** Whether a question of this type may fill in the given client record field. */
export function canMapTo(type: FieldType, column: MappableField): boolean {
  if (column === 'date_of_birth') return type === 'date';
  return isTextType(type);
}

/** Whether any client record field can be filled in by this type of question. */
export function isMappableType(type: FieldType): boolean {
  return isTextType(type) || type === 'date';
}

/** Longest text answer allowed for a field (shorter when it fills a client record column). */
export function textLimit(field: Pick<FormField, 'maps_to'>): number {
  if (!field.maps_to) return MAX_ANSWER_LENGTH;
  return Math.min(MAX_ANSWER_LENGTH, MAPPABLE_FIELDS[field.maps_to].maxLength);
}
