import type { AnswerValue, FormField } from '../../api/forms';
import type { DraftAnswers, FieldErrors } from './answers';
import { FieldRenderer, fieldWrapperId } from './FieldRenderer';

export interface FormRendererProps {
  fields: FormField[];
  answers: DraftAnswers;
  onChange?: (fieldId: string, value: AnswerValue | undefined) => void;
  onBlur?: (fieldId: string) => void;
  errors?: FieldErrors;
  readOnly?: boolean;
  /** Read-only: show numeric option values (scores) next to chosen options. */
  showValues?: boolean;
  idPrefix: string;
  headingLevel?: 2 | 3;
}

/**
 * Renders a whole form: the builder preview, the client's form page and the staff
 * read-only view all use this, so clients see exactly what the template's author previewed.
 */
export function FormRenderer({
  fields,
  answers,
  onChange,
  onBlur,
  errors = {},
  readOnly = false,
  showValues = false,
  idPrefix,
  headingLevel = 2,
}: FormRendererProps) {
  return (
    <div className="space-y-7">
      {fields.map((field, index) => (
        <FieldRenderer
          key={`${index}-${field.id}`}
          field={field}
          value={answers[field.id]}
          onChange={onChange ? (value) => onChange(field.id, value) : undefined}
          onBlur={onBlur ? () => onBlur(field.id) : undefined}
          error={errors[field.id]}
          readOnly={readOnly}
          showValues={showValues}
          idPrefix={idPrefix}
          headingLevel={headingLevel}
        />
      ))}
    </div>
  );
}

/** Scroll an element into view and focus its first input (used to jump to the first error). */
export function scrollToElement(elementId: string): void {
  const element = document.getElementById(elementId);
  if (!element) return;
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  element.scrollIntoView?.({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
  element.querySelector<HTMLElement>('input, textarea, select')?.focus({ preventScroll: true });
}

/** Scroll a form field into view and focus it. */
export function scrollToField(idPrefix: string, fieldId: string): void {
  scrollToElement(fieldWrapperId(idPrefix, fieldId));
}
