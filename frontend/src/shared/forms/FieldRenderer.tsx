import type { ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import type { AnswerValue, ChoiceOption, FormField, MappableField, OptionValue } from '../../api/forms';
import { Input, Textarea } from '../../ui/Form';
import { formatAnswer } from './answers';
import { INVALID_CONTROL, textLimit } from './fieldTypes';

export interface FieldRendererProps {
  field: FormField;
  value: AnswerValue | undefined;
  onChange?: (value: AnswerValue | undefined) => void;
  onBlur?: () => void;
  error?: string | null;
  /** Show the answer as text instead of an input. */
  readOnly?: boolean;
  /** Read-only: append numeric option values (scores) to chosen options. */
  showValues?: boolean;
  /** Makes DOM ids unique when several forms are on one page. */
  idPrefix: string;
  headingLevel?: 2 | 3;
}

/** DOM id of a field's wrapper, used to scroll to it. */
export function fieldWrapperId(idPrefix: string, fieldId: string): string {
  return `${idPrefix}-${fieldId}-field`;
}

const AUTOCOMPLETE: Partial<Record<MappableField, string>> = {
  preferred_name: 'nickname',
  date_of_birth: 'bday',
  phone: 'tel',
  address_line1: 'address-line1',
  address_line2: 'address-line2',
  city: 'address-level2',
  state: 'address-level1',
  postal_code: 'postal-code',
};

function autoCompleteFor(field: FormField): string {
  return (field.maps_to && AUTOCOMPLETE[field.maps_to]) || 'off';
}

function isPhone(field: FormField): boolean {
  return field.maps_to === 'phone' || field.maps_to === 'emergency_contact_phone';
}

function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function RequiredMark() {
  return (
    <>
      <span aria-hidden="true" className="ml-1 text-red-600">
        *
      </span>
      <span className="sr-only"> (required)</span>
    </>
  );
}

function LabelText({ field }: { field: FormField }) {
  const text = field.label.trim();
  return (
    <>
      {text ? <span className="whitespace-pre-line">{text}</span> : <span className="italic text-sage-400">Untitled question</span>}
      {field.required && <RequiredMark />}
    </>
  );
}

function ErrorMessage({ id, message }: { id: string; message: string }) {
  return (
    <p id={id} className="mt-2 flex items-start gap-1.5 text-sm font-medium text-red-700">
      <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      {message}
    </p>
  );
}

function sameValue(a: unknown, b: OptionValue): boolean {
  return typeof a === typeof b && a === b;
}

function ChoiceTile({
  type,
  id,
  name,
  checked,
  label,
  onToggle,
  onBlur,
  describedBy,
  invalid,
}: {
  type: 'radio' | 'checkbox';
  id: string;
  name: string;
  checked: boolean;
  label: ReactNode;
  onToggle: () => void;
  onBlur?: () => void;
  describedBy?: string;
  invalid: boolean;
}) {
  return (
    <label
      htmlFor={id}
      className={`flex min-h-[48px] cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-base transition-colors focus-within:ring-2 focus-within:ring-primary-300 ${
        checked
          ? 'border-primary-500 bg-primary-50 text-primary-900'
          : invalid
            ? 'border-red-300 bg-white text-sage-800 hover:bg-sage-50'
            : 'border-sage-200 bg-white text-sage-800 hover:border-sage-300 hover:bg-sage-50'
      }`}
    >
      <input
        id={id}
        type={type}
        name={name}
        checked={checked}
        onChange={onToggle}
        onBlur={onBlur}
        aria-describedby={describedBy}
        className="h-5 w-5 shrink-0 accent-primary-600 focus:outline-none"
      />
      <span className="min-w-0 flex-1 break-words">{label}</span>
    </label>
  );
}

function ReadOnlyAnswer({ field, value, showValues }: { field: FormField; value: AnswerValue | undefined; showValues: boolean }) {
  const text = formatAnswer(field, value, { showValues });
  return (
    <div>
      <p className="text-sm font-medium text-sage-600">
        <LabelText field={{ ...field, required: false }} />
      </p>
      <p className="mt-1 whitespace-pre-line break-words text-base text-sage-900">
        {text || <span className="italic text-sage-400">No answer</span>}
      </p>
    </div>
  );
}

/** One form item: display text, an input for its type, or (read-only) the given answer. */
export function FieldRenderer({
  field,
  value,
  onChange,
  onBlur,
  error,
  readOnly = false,
  showValues = false,
  idPrefix,
  headingLevel = 2,
}: FieldRendererProps) {
  const base = `${idPrefix}-${field.id}`;
  const wrapperId = fieldWrapperId(idPrefix, field.id);

  if (field.type === 'heading') {
    const Heading = headingLevel === 2 ? 'h2' : 'h3';
    return (
      <div id={wrapperId} className="border-t border-sage-100 pt-6 first:border-t-0 first:pt-0">
        <Heading className="text-lg font-semibold text-sage-900">
          {field.label.trim() || <span className="italic text-sage-400">Untitled section</span>}
        </Heading>
      </div>
    );
  }
  if (field.type === 'paragraph') {
    return (
      <div id={wrapperId}>
        <p className="whitespace-pre-line break-words text-[15px] leading-relaxed text-sage-700">
          {field.label.trim() || <span className="italic text-sage-400">Empty text block</span>}
        </p>
      </div>
    );
  }
  if (readOnly) {
    return (
      <div id={wrapperId} data-answer-field={field.id}>
        <ReadOnlyAnswer field={field} value={value} showValues={showValues} />
      </div>
    );
  }

  const helpId = field.help ? `${base}-help` : undefined;
  const errorId = error ? `${base}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(' ') || undefined;
  const invalid = Boolean(error);
  const change = (next: AnswerValue | undefined) => onChange?.(next);
  const help = field.help ? (
    <p id={helpId} className="mt-1 text-sm text-sage-500">
      {field.help}
    </p>
  ) : null;
  const errorMessage = error ? <ErrorMessage id={`${base}-error`} message={error} /> : null;

  if (field.type === 'short_text' || field.type === 'long_text' || field.type === 'date') {
    const text = typeof value === 'string' ? value : '';
    const common = {
      id: base,
      value: text,
      onBlur,
      'aria-describedby': describedBy,
      'aria-invalid': invalid || undefined,
      'aria-required': field.required || undefined,
    };
    const setText = (next: string) => change(next === '' ? undefined : next);
    let control: ReactNode;
    if (field.type === 'long_text') {
      control = (
        <Textarea
          {...common}
          rows={4}
          maxLength={textLimit(field)}
          onChange={(event) => setText(event.target.value)}
          className={`text-base ${INVALID_CONTROL}`}
        />
      );
    } else if (field.type === 'date') {
      control = (
        <Input
          {...common}
          type="date"
          autoComplete={autoCompleteFor(field)}
          max={field.maps_to === 'date_of_birth' ? todayIso() : undefined}
          onChange={(event) => setText(event.target.value)}
          className={`h-12 text-base sm:max-w-xs ${INVALID_CONTROL}`}
        />
      );
    } else {
      control = (
        <Input
          {...common}
          type={isPhone(field) ? 'tel' : 'text'}
          inputMode={isPhone(field) ? 'tel' : undefined}
          autoComplete={autoCompleteFor(field)}
          maxLength={textLimit(field)}
          onChange={(event) => setText(event.target.value)}
          className={`h-12 text-base ${INVALID_CONTROL}`}
        />
      );
    }
    return (
      <div id={wrapperId} data-answer-field={field.id}>
        <label htmlFor={base} className="block text-base font-medium text-sage-900">
          <LabelText field={field} />
        </label>
        {help}
        <div className="mt-2">{control}</div>
        {errorMessage}
      </div>
    );
  }

  let tiles: ReactNode;
  const groupRole = field.type === 'multi_choice' ? undefined : 'radiogroup';
  if (field.type === 'yes_no') {
    tiles = (
      <div className="grid grid-cols-2 gap-3 sm:max-w-sm">
        {[true, false].map((choice) => (
          <ChoiceTile
            key={String(choice)}
            type="radio"
            id={`${base}-${choice ? 'yes' : 'no'}`}
            name={base}
            checked={value === choice}
            label={choice ? 'Yes' : 'No'}
            onToggle={() => change(choice)}
            onBlur={onBlur}
            invalid={invalid}
          />
        ))}
      </div>
    );
  } else {
    const options: ChoiceOption[] = field.options ?? [];
    const chosen = Array.isArray(value) ? value : [];
    tiles = (
      <div className="space-y-2">
        {options.map((option, index) => {
          const checked =
            field.type === 'multi_choice' ? chosen.some((item) => sameValue(item, option.value)) : sameValue(value, option.value);
          const toggle = () => {
            if (field.type === 'single_choice') {
              change(option.value);
              return;
            }
            const next = checked ? chosen.filter((item) => !sameValue(item, option.value)) : [...chosen, option.value];
            change(next.length ? next : undefined);
          };
          return (
            <ChoiceTile
              key={`${index}-${String(option.value)}`}
              type={field.type === 'multi_choice' ? 'checkbox' : 'radio'}
              id={`${base}-opt-${index}`}
              name={base}
              checked={checked}
              label={option.label.trim() || <span className="italic text-sage-400">Untitled option</span>}
              onToggle={toggle}
              onBlur={onBlur}
              invalid={invalid}
            />
          );
        })}
      </div>
    );
  }

  return (
    <div id={wrapperId} data-answer-field={field.id}>
      <fieldset
        role={groupRole}
        aria-describedby={describedBy}
        aria-invalid={groupRole && invalid ? true : undefined}
        aria-required={groupRole && field.required ? true : undefined}
      >
        <legend className="text-base font-medium text-sage-900">
          <LabelText field={field} />
        </legend>
        {help}
        {field.type === 'multi_choice' && <p className="mt-1 text-sm text-sage-500">Select all that apply.</p>}
        <div className="mt-3">{tiles}</div>
      </fieldset>
      {errorMessage}
    </div>
  );
}
