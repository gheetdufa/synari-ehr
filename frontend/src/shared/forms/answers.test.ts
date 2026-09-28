import { describe, expect, it } from 'vitest';
import type { Answers, FormField } from '../../api/forms';
import {
  answerProgress,
  buildSubmissionAnswers,
  formatAnswer,
  isBlank,
  sanitizeDraftAnswers,
  signatureProblem,
  validateAnswer,
  validateAnswers,
  type DraftAnswers,
} from './answers';

/** Same fields as CUSTOM_FIELDS in backend/tests/test_forms.py. */
const FIELDS: FormField[] = [
  { id: 'intro', type: 'heading', label: 'Getting started' },
  { id: 'nickname', type: 'short_text', label: 'Nickname', maps_to: 'preferred_name' },
  {
    id: 'topics',
    type: 'multi_choice',
    label: 'What would you like to work on?',
    required: true,
    options: [
      { label: 'Sleep', value: 'sleep' },
      { label: 'Mood', value: 'mood' },
      { label: 'Work', value: 'work' },
    ],
  },
  { id: 'start', type: 'date', label: 'When did this start?' },
  { id: 'ok_to_text', type: 'yes_no', label: 'May we text you?', required: true },
];

const SCORED: FormField = {
  id: 'q1',
  type: 'single_choice',
  label: 'Feeling nervous',
  required: true,
  options: [
    { label: 'Not at all', value: 0 },
    { label: 'Several days', value: 1 },
  ],
};

describe('validateAnswers (mirrors clean_answers in the API)', () => {
  it.each<[string, DraftAnswers, Record<string, string>]>([
    ['required multi choice missing', { ok_to_text: true }, { topics: 'This question is required' }],
    ['required multi choice empty', { topics: [], ok_to_text: true }, { topics: 'This question is required' }],
    ['required yes/no missing', { topics: ['mood'] }, { ok_to_text: 'This question is required' }],
    ['yes/no given as text', { topics: ['mood'], ok_to_text: 'yes' }, { ok_to_text: 'Answer yes or no' }],
    ['yes/no given as a number', { topics: ['mood'], ok_to_text: 1 }, { ok_to_text: 'Answer yes or no' }],
    ['unknown option', { topics: ['cats'], ok_to_text: true }, { topics: 'Choose from the options' }],
    ['multi choice given as text', { topics: 'mood', ok_to_text: true }, { topics: 'Choose from the options' }],
    ['date in the wrong format', { topics: ['mood'], ok_to_text: true, start: '09/25/2026' }, { start: 'Enter a date as YYYY-MM-DD' }],
    ['impossible date', { topics: ['mood'], ok_to_text: true, start: '2026-02-30' }, { start: 'Enter a valid date' }],
    ['text given as a number', { topics: ['mood'], ok_to_text: true, nickname: 7 }, { nickname: 'Enter text' }],
    [
      'text longer than the mapped column',
      { topics: ['mood'], ok_to_text: true, nickname: 'x'.repeat(101) },
      { nickname: 'Keep this to 100 characters or fewer' },
    ],
  ])('%s', (_, answers, errors) => {
    expect(validateAnswers(FIELDS, answers)).toEqual(errors);
  });

  it('accepts a complete, valid set of answers', () => {
    expect(validateAnswers(FIELDS, { nickname: 'Lex', topics: ['work'], start: '2024-02-29', ok_to_text: false })).toEqual({});
  });

  it('treats whitespace-only text as blank', () => {
    expect(validateAnswer({ id: 'a', type: 'long_text', label: 'A', required: true }, '   ')).toBe('This question is required');
    expect(validateAnswer({ id: 'a', type: 'long_text', label: 'A' }, '   ')).toBeNull();
  });

  it('allows 5000 characters of unmapped text but not more', () => {
    const field: FormField = { id: 'a', type: 'long_text', label: 'A' };
    expect(validateAnswer(field, 'x'.repeat(5000))).toBeNull();
    expect(validateAnswer(field, 'x'.repeat(5001))).toBe('Keep this to 5000 characters or fewer');
  });

  it('requires exact option types so booleans and numeric strings are rejected for scored items', () => {
    expect(validateAnswer(SCORED, 1)).toBeNull();
    expect(validateAnswer(SCORED, true)).toBe('Choose one of the options');
    expect(validateAnswer(SCORED, '1')).toBe('Choose one of the options');
    expect(validateAnswer(SCORED, 4)).toBe('Choose one of the options');
  });

  it('never validates headings or paragraphs', () => {
    expect(validateAnswer({ id: 'p', type: 'paragraph', label: 'Read this' }, undefined)).toBeNull();
  });
});

describe('buildSubmissionAnswers', () => {
  it('trims text, drops blanks and display fields, and orders multi-choice values like the options', () => {
    const answers: DraftAnswers = {
      intro: 'ignored',
      nickname: '  Lex  ',
      topics: ['work', 'sleep'],
      start: '',
      ok_to_text: false,
    };
    const expected: Answers = { nickname: 'Lex', topics: ['sleep', 'work'], ok_to_text: false };
    expect(buildSubmissionAnswers(FIELDS, answers)).toEqual(expected);
  });

  it('keeps numeric option values as numbers', () => {
    expect(buildSubmissionAnswers([SCORED], { q1: 0 })).toEqual({ q1: 0 });
  });

  it('leaves out answers for questions that are not on the form', () => {
    expect(buildSubmissionAnswers(FIELDS, { bogus: 'x', ok_to_text: true })).toEqual({ ok_to_text: true });
  });
});

describe('signatureProblem (mirrors signature_problem in the API)', () => {
  it('needs at least two characters of name', () => {
    expect(signatureProblem(' A ', true)).toBe('Type your full name to sign');
  });
  it('needs the agreement checkbox', () => {
    expect(signatureProblem('Alex Rivera', false)).toBe('Agree to sign electronically to continue');
  });
  it('accepts a name with agreement', () => {
    expect(signatureProblem('Alex Rivera', true)).toBeNull();
  });
  it('rejects names over 200 characters', () => {
    expect(signatureProblem('x'.repeat(201), true)).toMatch(/200 characters/);
  });
});

describe('answer helpers', () => {
  it('detects blank answers', () => {
    expect(isBlank(undefined)).toBe(true);
    expect(isBlank('  ')).toBe(true);
    expect(isBlank([])).toBe(true);
    expect(isBlank(false)).toBe(false);
    expect(isBlank(0)).toBe(false);
  });

  it('formats answers for reading', () => {
    expect(formatAnswer(FIELDS[4], true)).toBe('Yes');
    expect(formatAnswer(FIELDS[4], false)).toBe('No');
    expect(formatAnswer(FIELDS[2], ['sleep', 'work'])).toBe('Sleep, Work');
    expect(formatAnswer(FIELDS[3], '2026-01-05')).toBe('Jan 5, 2026');
    expect(formatAnswer(SCORED, 1)).toBe('Several days');
    expect(formatAnswer(SCORED, 1, { showValues: true })).toBe('Several days (1)');
    expect(formatAnswer(FIELDS[1], undefined)).toBe('');
  });

  it('counts progress over answerable questions', () => {
    expect(answerProgress(FIELDS, { nickname: 'Lex', topics: [] })).toEqual({ answered: 1, total: 4, requiredLeft: 2 });
  });

  it('keeps only plausible answers when restoring a saved draft', () => {
    const restored = sanitizeDraftAnswers(FIELDS, {
      nickname: 'Lex',
      topics: ['mood', { bad: true }],
      ok_to_text: true,
      intro: 'heading',
      unknown: 'x',
    });
    expect(restored).toEqual({ nickname: 'Lex', ok_to_text: true });
    expect(sanitizeDraftAnswers(FIELDS, 'garbage')).toEqual({});
  });
});
