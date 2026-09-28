import { ChevronDown, ChevronUp, Plus, X } from 'lucide-react';
import { MAX_OPTIONS, MAX_OPTION_LABEL_LENGTH, MAX_OPTION_VALUE_LENGTH } from '../../shared/forms/fieldTypes';
import { Button, IconButton } from '../../ui/Button';
import { Checkbox, Input } from '../../ui/Form';
import type { DraftField, FieldIssues } from './templateDraft';

/** Answer choices for a single- or multi-choice question: labels, stored values and order. */
export function OptionsEditor({
  field,
  issues,
  onAdd,
  onChange,
  onRemove,
  onMove,
  onNumericChange,
}: {
  field: DraftField;
  issues?: FieldIssues;
  onAdd: () => void;
  onChange: (optionUid: string, changes: { label?: string; value?: string }) => void;
  onRemove: (optionUid: string) => void;
  onMove: (index: number, delta: number) => void;
  onNumericChange: (numeric: boolean) => void;
}) {
  const { options } = field;
  return (
    <fieldset>
      <legend className="text-sm font-medium text-sage-800">Options</legend>
      <p className="mt-0.5 text-xs text-sage-500">
        The value is what's stored and exported. Use numeric values when answers are added up into a score.
      </p>
      <div className="mt-2 hidden grid-cols-[1fr_7rem_auto] gap-2 px-1 text-xs font-medium uppercase tracking-wide text-sage-500 sm:grid">
        <span>Label</span>
        <span>Value</span>
        <span className="sr-only">Actions</span>
      </div>
      <ol className="mt-1 space-y-2">
        {options.map((option, index) => {
          const labelError = issues?.optionLabels?.[option.uid];
          const valueError = issues?.optionValues?.[option.uid];
          const labelErrorId = `${option.uid}-label-error`;
          const valueErrorId = `${option.uid}-value-error`;
          return (
            <li key={option.uid}>
              <div className="grid grid-cols-[1fr_5.5rem] gap-2 sm:grid-cols-[1fr_7rem_auto]">
                <Input
                  aria-label={`Option ${index + 1} label`}
                  value={option.label}
                  maxLength={MAX_OPTION_LABEL_LENGTH}
                  onChange={(event) => onChange(option.uid, { label: event.target.value })}
                  aria-invalid={labelError ? true : undefined}
                  aria-describedby={labelError ? labelErrorId : undefined}
                />
                <Input
                  aria-label={`Option ${index + 1} value`}
                  value={option.value}
                  inputMode={field.numericValues ? 'numeric' : undefined}
                  maxLength={field.numericValues ? 10 : MAX_OPTION_VALUE_LENGTH}
                  onChange={(event) => onChange(option.uid, { value: event.target.value })}
                  aria-invalid={valueError ? true : undefined}
                  aria-describedby={valueError ? valueErrorId : undefined}
                  className="font-mono"
                />
                <div className="col-span-2 flex justify-end gap-0.5 sm:col-span-1">
                  <IconButton label={`Move option ${index + 1} up`} disabled={index === 0} onClick={() => onMove(index, -1)}>
                    <ChevronUp className="h-4 w-4" />
                  </IconButton>
                  <IconButton
                    label={`Move option ${index + 1} down`}
                    disabled={index === options.length - 1}
                    onClick={() => onMove(index, 1)}
                  >
                    <ChevronDown className="h-4 w-4" />
                  </IconButton>
                  <IconButton label={`Remove option ${index + 1}`} onClick={() => onRemove(option.uid)}>
                    <X className="h-4 w-4" />
                  </IconButton>
                </div>
              </div>
              {labelError && (
                <p id={labelErrorId} className="mt-1 text-sm text-red-600">
                  {labelError}
                </p>
              )}
              {valueError && (
                <p id={valueErrorId} className="mt-1 text-sm text-red-600">
                  {valueError}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {issues?.options && (
        <p className="mt-2 text-sm text-red-600" role="alert">
          {issues.options}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <Button
          variant="secondary"
          size="sm"
          icon={<Plus className="h-4 w-4" />}
          onClick={onAdd}
          disabled={options.length >= MAX_OPTIONS}
        >
          Add option
        </Button>
        <Checkbox
          label="Numeric values (for scoring)"
          checked={field.numericValues}
          onChange={(event) => onNumericChange(event.target.checked)}
        />
      </div>
    </fieldset>
  );
}
