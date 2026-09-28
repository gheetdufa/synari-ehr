import type { AnswerValue, Answers, ChoiceOption, FormField, OptionValue } from '../../api/forms';
import { formatPlainDate } from '../../lib/format';
import {
  SIGNATURE_MAX_LENGTH,
  SIGNATURE_MIN_LENGTH,
  answerableFields,
  isDisplayType,
  isTextType,
  textLimit,
} from './fieldTypes';

/** Answers being filled in; a missing key means the question hasn't been answered. */
export type DraftAnswers = Partial<Answers>;

/** Error messages keyed by field id. */
export type FieldErrors = Record<string, string>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True when an answer counts as left blank (the API drops these before checking "required"). */
export function isBlank(value: AnswerValue | undefined): boolean {
  if (value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Exact type match so `true` never counts as the option value 1 (mirrors the API). */
function matchesOption(value: unknown, options: ChoiceOption[]): boolean {
  return options.some((option) => typeof option.value === typeof value && option.value === value);
}

function isRealDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** The problem with one answer, or null. Mirrors clean_answers() in the API. */
export function validateAnswer(field: FormField, value: AnswerValue | undefined): string | null {
  if (isDisplayType(field.type)) return null;
  if (isBlank(value)) return field.required ? 'This question is required' : null;
  if (isTextType(field.type)) {
    if (typeof value !== 'string') return 'Enter text';
    const limit = textLimit(field);
    return value.trim().length > limit ? `Keep this to ${limit} characters or fewer` : null;
  }
  if (field.type === 'date') {
    if (typeof value !== 'string' || !ISO_DATE.test(value)) return 'Enter a date as YYYY-MM-DD';
    return isRealDate(value) ? null : 'Enter a valid date';
  }
  if (field.type === 'yes_no') return typeof value === 'boolean' ? null : 'Answer yes or no';
  const options = field.options ?? [];
  if (field.type === 'single_choice') return matchesOption(value, options) ? null : 'Choose one of the options';
  if (!Array.isArray(value) || !value.every((item) => matchesOption(item, options))) return 'Choose from the options';
  return null;
}

/** Every problem in a set of answers, keyed by field id. */
export function validateAnswers(fields: FormField[], answers: DraftAnswers): FieldErrors {
  const errors: FieldErrors = {};
  for (const field of answerableFields(fields)) {
    const problem = validateAnswer(field, answers[field.id]);
    if (problem) errors[field.id] = problem;
  }
  return errors;
}

/**
 * The answers to send: only questions on the form, blanks left out, text trimmed and
 * multi-choice values in option order (the same normalization the API applies).
 */
export function buildSubmissionAnswers(fields: FormField[], answers: DraftAnswers): Answers {
  const result: Answers = {};
  for (const field of answerableFields(fields)) {
    const value = answers[field.id];
    if (value === undefined || isBlank(value)) continue;
    if (typeof value === 'string') {
      result[field.id] = value.trim();
    } else if (Array.isArray(value) && field.type === 'multi_choice') {
      result[field.id] = (field.options ?? [])
        .map((option) => option.value)
        .filter((optionValue) => value.some((chosen) => typeof chosen === typeof optionValue && chosen === optionValue));
    } else {
      result[field.id] = value;
    }
  }
  return result;
}

/** Why a typed signature isn't acceptable yet, or null. Mirrors signature_problem() in the API. */
export function signatureProblem(name: string, agreed: boolean): string | null {
  const trimmed = name.trim();
  if (trimmed.length < SIGNATURE_MIN_LENGTH) return 'Type your full name to sign';
  if (trimmed.length > SIGNATURE_MAX_LENGTH) return `Keep your name to ${SIGNATURE_MAX_LENGTH} characters or fewer`;
  if (!agreed) return 'Agree to sign electronically to continue';
  return null;
}

function optionLabel(options: ChoiceOption[], value: OptionValue, showValues: boolean): string {
  const option = options.find((candidate) => typeof candidate.value === typeof value && candidate.value === value);
  if (!option) return String(value);
  return showValues && typeof option.value === 'number' ? `${option.label} (${option.value})` : option.label;
}

/**
 * A human-readable answer ("Yes", an option's label, a formatted date); '' when blank.
 * `showValues` appends numeric option values, which clinicians use to check scores.
 */
export function formatAnswer(
  field: FormField,
  value: AnswerValue | undefined,
  { showValues = false }: { showValues?: boolean } = {},
): string {
  if (value === undefined || isBlank(value)) return '';
  const options = field.options ?? [];
  if (field.type === 'yes_no') return value === true ? 'Yes' : value === false ? 'No' : String(value);
  if (field.type === 'single_choice' && !Array.isArray(value) && typeof value !== 'boolean') {
    return optionLabel(options, value, showValues);
  }
  if (field.type === 'multi_choice' && Array.isArray(value)) {
    return value.map((item) => optionLabel(options, item, showValues)).join(', ');
  }
  if (field.type === 'date' && typeof value === 'string' && ISO_DATE.test(value) && isRealDate(value)) {
    return formatPlainDate(value);
  }
  return Array.isArray(value) ? value.join(', ') : String(value);
}

export interface AnswerProgress {
  answered: number;
  total: number;
  requiredLeft: number;
}

/** How much of a form has been filled in. */
export function answerProgress(fields: FormField[], answers: DraftAnswers): AnswerProgress {
  const questions = answerableFields(fields);
  let answered = 0;
  let requiredLeft = 0;
  for (const field of questions) {
    const blank = isBlank(answers[field.id]);
    if (!blank) answered += 1;
    else if (field.required) requiredLeft += 1;
  }
  return { answered, total: questions.length, requiredLeft };
}

/** Keep only answers that belong to answerable fields with a plausible type (for restored drafts). */
export function sanitizeDraftAnswers(fields: FormField[], raw: unknown): DraftAnswers {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const result: DraftAnswers = {};
  for (const field of answerableFields(fields)) {
    const value = source[field.id];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[field.id] = value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === 'string' || typeof item === 'number')) {
      result[field.id] = value as Array<string | number>;
    }
  }
  return result;
}
