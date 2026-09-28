import type { KeyboardEvent } from 'react';
import { AlertCircle, ChevronDown, ChevronUp, Copy, Flag, Lock, Trash2 } from 'lucide-react';
import type { FieldType, MappableField } from '../../api/forms';
import {
  FIELD_ID_MAX_LENGTH,
  FIELD_TYPES,
  FIELD_TYPE_LABELS,
  MAPPABLE_FIELDS,
  MAPPABLE_FIELD_IDS,
  MAX_HELP_LENGTH,
  canMapTo,
  isChoiceType,
  isDisplayType,
  isMappableType,
} from '../../shared/forms/fieldTypes';
import { IconButton } from '../../ui/Button';
import { Badge } from '../../ui/Display';
import { Checkbox, Field, Input, Select, Textarea } from '../../ui/Form';
import { FIELD_ICONS } from './fieldIcons';
import { OptionsEditor } from './OptionsEditor';
import {
  addOption,
  changeFieldType,
  moveOption,
  removeOption,
  setFieldId,
  setNumericValues,
  updateField,
  updateOption,
  type DraftField,
  type FieldIssues,
} from './templateDraft';

export type FieldsUpdater = (update: (fields: DraftField[]) => DraftField[]) => void;
export type CardControl = 'toggle' | 'up' | 'down' | 'duplicate' | 'delete' | 'label';

function summaryText(field: DraftField): string {
  const label = field.label.trim().replace(/\s+/g, ' ');
  return label.length > 140 ? `${label.slice(0, 140)}…` : label;
}

/** One field in the builder: a summary row with reorder controls, and its settings when expanded. */
export function FieldEditorCard({
  field,
  index,
  total,
  issues,
  expanded,
  locked,
  mappedElsewhere,
  update,
  onToggle,
  onMove,
  onDuplicate,
  onDelete,
}: {
  field: DraftField;
  index: number;
  total: number;
  issues?: FieldIssues;
  expanded: boolean;
  /** The field's id is used by automatic scoring or flags, so it can't change. */
  locked: boolean;
  mappedElsewhere: Set<MappableField>;
  update: FieldsUpdater;
  onToggle: () => void;
  onMove: (delta: number, control: CardControl) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const Icon = FIELD_ICONS[field.type];
  const bodyId = `${field.uid}-settings`;
  const display = isDisplayType(field.type);
  const hasIssues = Boolean(issues && Object.keys(issues).length);
  const summary = summaryText(field);
  const name = summary || FIELD_TYPE_LABELS[field.type];

  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    const control = (event.target as HTMLElement).closest<HTMLElement>('[data-control]')?.dataset.control;
    event.preventDefault();
    onMove(event.key === 'ArrowUp' ? -1 : 1, control === 'up' || control === 'down' ? control : 'toggle');
  };

  const change = (changes: Parameters<typeof updateField>[2]) => update((fields) => updateField(fields, field.uid, changes));

  return (
    <li
      data-field-uid={field.uid}
      onKeyDown={onKeyDown}
      className={`rounded-xl border bg-white shadow-sm ${hasIssues ? 'border-red-300' : expanded ? 'border-primary-300' : 'border-sage-200'}`}
    >
      <div className="flex items-start gap-1 p-2 sm:gap-2 sm:p-3">
        <button
          type="button"
          data-control="toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-start gap-3 rounded-lg p-1.5 text-left hover:bg-sage-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-50 text-primary-700">
            <Icon aria-hidden className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-xs text-sage-500">
              {index + 1}. {FIELD_TYPE_LABELS[field.type]}
            </span>
            <span className={`block truncate text-sm font-medium ${summary ? 'text-sage-900' : 'italic text-sage-400'}`}>
              {summary || (display ? 'No text yet' : 'Untitled question')}
            </span>
            {(field.required || field.maps_to || locked || hasIssues) && (
              <span className="mt-1 flex flex-wrap gap-1">
                {hasIssues && (
                  <Badge tone="danger">
                    <AlertCircle aria-hidden="true" className="h-3 w-3" /> Needs attention
                  </Badge>
                )}
                {field.required && <Badge tone="primary">Required</Badge>}
                {field.maps_to && <Badge tone="info">Fills {MAPPABLE_FIELDS[field.maps_to].label.toLowerCase()}</Badge>}
                {locked && (
                  <Badge tone="warning">
                    <Flag aria-hidden="true" className="h-3 w-3" /> Used for flagging
                  </Badge>
                )}
              </span>
            )}
          </span>
        </button>
        <div className="flex shrink-0 items-center">
          <IconButton data-control="up" label={`Move ${name} up`} disabled={index === 0} onClick={() => onMove(-1, 'up')}>
            <ChevronUp className="h-4 w-4" />
          </IconButton>
          <IconButton
            data-control="down"
            label={`Move ${name} down`}
            disabled={index === total - 1}
            onClick={() => onMove(1, 'down')}
          >
            <ChevronDown className="h-4 w-4" />
          </IconButton>
          <IconButton data-control="duplicate" label={`Duplicate ${name}`} onClick={onDuplicate}>
            <Copy className="h-4 w-4" />
          </IconButton>
          <IconButton data-control="delete" label={`Delete ${name}`} onClick={onDelete} className="hover:!bg-red-50 hover:!text-red-700">
            <Trash2 className="h-4 w-4" />
          </IconButton>
        </div>
      </div>

      {expanded && (
        <div id={bodyId} className="space-y-4 border-t border-sage-100 px-4 py-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Type">
              {(props) => (
                <Select
                  {...props}
                  value={field.type}
                  onChange={(event) => update((fields) => changeFieldType(fields, field.uid, event.target.value as FieldType))}
                >
                  {FIELD_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {FIELD_TYPE_LABELS[type]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label="Field ID"
              error={issues?.id}
              hint={
                locked
                  ? 'Automatic flagging uses this ID, so it can’t change.'
                  : field.autoId
                    ? 'Generated from the question. Used in exports.'
                    : 'Lowercase letters, numbers and underscores. Used in exports.'
              }
            >
              {(props) => (
                <div className="relative">
                  <Input
                    {...props}
                    value={field.id}
                    maxLength={FIELD_ID_MAX_LENGTH}
                    readOnly={locked}
                    spellCheck={false}
                    autoCapitalize="none"
                    onChange={(event) => update((fields) => setFieldId(fields, field.uid, event.target.value))}
                    className={`font-mono ${locked ? 'bg-sage-50 pr-9 text-sage-600' : ''}`}
                  />
                  {locked && <Lock aria-hidden="true" className="absolute right-3 top-3 h-4 w-4 text-sage-400" />}
                </div>
              )}
            </Field>
          </div>

          <Field
            label={field.type === 'heading' ? 'Heading' : field.type === 'paragraph' ? 'Text' : 'Question'}
            error={issues?.label}
            hint={field.type === 'paragraph' ? 'Shown to clients as written. Line breaks are kept.' : undefined}
          >
            {(props) =>
              field.type === 'heading' ? (
                <Input {...props} data-control="label" value={field.label} onChange={(event) => change({ label: event.target.value })} />
              ) : (
                <Textarea
                  {...props}
                  data-control="label"
                  rows={field.type === 'paragraph' ? 5 : 2}
                  value={field.label}
                  onChange={(event) => change({ label: event.target.value })}
                />
              )
            }
          </Field>

          {!display && (
            <>
              <Field label="Help text" hint="Optional hint shown under the question." error={issues?.help}>
                {(props) => (
                  <Input {...props} value={field.help} maxLength={MAX_HELP_LENGTH} onChange={(event) => change({ help: event.target.value })} />
                )}
              </Field>
              <Checkbox
                label="Required"
                description="Clients must answer before they can submit."
                checked={field.required}
                onChange={(event) => change({ required: event.target.checked })}
              />
            </>
          )}

          {isChoiceType(field.type) && (
            <OptionsEditor
              field={field}
              issues={issues}
              onAdd={() => update((fields) => addOption(fields, field.uid))}
              onChange={(optionUid, changes) => update((fields) => updateOption(fields, field.uid, optionUid, changes))}
              onRemove={(optionUid) => update((fields) => removeOption(fields, field.uid, optionUid))}
              onMove={(optionIndex, delta) => update((fields) => moveOption(fields, field.uid, optionIndex, delta))}
              onNumericChange={(numeric) => update((fields) => setNumericValues(fields, field.uid, numeric))}
            />
          )}

          {isMappableType(field.type) && (
            <Field
              label="Fills client record"
              error={issues?.maps_to}
              hint="If this part of the client's record is blank, their answer is copied into it."
            >
              {(props) => (
                <Select
                  {...props}
                  value={field.maps_to ?? ''}
                  onChange={(event) => change({ maps_to: (event.target.value || null) as MappableField | null })}
                >
                  <option value="">Don't fill in the client record</option>
                  {MAPPABLE_FIELD_IDS.filter((column) => canMapTo(field.type, column)).map((column) => (
                    <option key={column} value={column} disabled={mappedElsewhere.has(column)}>
                      {MAPPABLE_FIELDS[column].label}
                      {mappedElsewhere.has(column) ? ' (used by another question)' : ''}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
        </div>
      )}
    </li>
  );
}
