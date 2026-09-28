import { useEffect, useMemo, useRef, useState } from 'react';
import type { FieldType, MappableField } from '../../api/forms';
import { FIELD_TYPES, FIELD_TYPE_DESCRIPTIONS, FIELD_TYPE_LABELS, MAX_FIELDS } from '../../shared/forms/fieldTypes';
import { ConfirmDialog } from '../../ui/Modal';
import { FIELD_ICONS } from './fieldIcons';
import { FieldEditorCard, type CardControl, type FieldsUpdater } from './FieldEditorCard';
import { addField, duplicateField, moveField, removeField, type DraftField, type FieldIssues } from './templateDraft';

interface FocusRequest {
  uid: string;
  control: CardControl;
}

function describe(field: DraftField): string {
  const label = field.label.trim().replace(/\s+/g, ' ');
  return label ? `“${label.length > 60 ? `${label.slice(0, 60)}…` : label}”` : FIELD_TYPE_LABELS[field.type].toLowerCase();
}

/** The builder's field list: reorderable cards plus a palette for adding fields. */
export function FieldListEditor({
  fields,
  update,
  issues,
  expanded,
  setExpanded,
  lockedIds,
}: {
  fields: DraftField[];
  update: FieldsUpdater;
  /** Problems per field uid; empty until the editor first tries to save. */
  issues: Record<string, FieldIssues>;
  expanded: Set<string>;
  setExpanded: (next: Set<string>) => void;
  lockedIds: Set<string>;
}) {
  const [announcement, setAnnouncement] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const focusRequest = useRef<FocusRequest | null>(null);
  const paletteRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const request = focusRequest.current;
    if (!request) return;
    focusRequest.current = null;
    const card = document.querySelector<HTMLElement>(`[data-field-uid="${request.uid}"]`);
    if (!card) return;
    const target = card.querySelector<HTMLElement>(`[data-control="${request.control}"]`);
    const usable = target && !(target as HTMLButtonElement).disabled ? target : card.querySelector<HTMLElement>('[data-control="toggle"]');
    usable?.focus();
    if (request.control === 'label') card.scrollIntoView?.({ block: 'nearest' });
  });

  const mappedByField = useMemo(() => {
    const result = new Map<string, Set<MappableField>>();
    for (const field of fields) {
      const others = new Set<MappableField>();
      for (const other of fields) {
        if (other.uid !== field.uid && other.maps_to) others.add(other.maps_to);
      }
      result.set(field.uid, others);
    }
    return result;
  }, [fields]);

  const toggle = (uid: string) => {
    const next = new Set(expanded);
    if (next.has(uid)) next.delete(uid);
    else next.add(uid);
    setExpanded(next);
  };

  const move = (index: number, delta: number, control: CardControl) => {
    const target = index + delta;
    if (target < 0 || target >= fields.length) return;
    const field = fields[index];
    update((current) => moveField(current, index, delta));
    focusRequest.current = { uid: field.uid, control };
    setAnnouncement(`Moved ${describe(field)} to position ${target + 1} of ${fields.length}.`);
  };

  const add = (type: FieldType) => {
    const { fields: next, field } = addField(fields, type);
    update(() => next);
    setExpanded(new Set(expanded).add(field.uid));
    focusRequest.current = { uid: field.uid, control: 'label' };
    setAnnouncement(`Added a ${FIELD_TYPE_LABELS[type].toLowerCase()} at position ${next.length}.`);
  };

  const duplicate = (index: number) => {
    const { fields: next, field } = duplicateField(fields, index);
    if (!field) return;
    update(() => next);
    setExpanded(new Set(expanded).add(field.uid));
    focusRequest.current = { uid: field.uid, control: 'toggle' };
    setAnnouncement(`Duplicated ${describe(fields[index])}.`);
  };

  const remove = (uid: string) => {
    const index = fields.findIndex((field) => field.uid === uid);
    if (index < 0) return;
    const neighbour = fields[index + 1] ?? fields[index - 1];
    update((current) => removeField(current, current.findIndex((field) => field.uid === uid)));
    setAnnouncement(`Deleted ${describe(fields[index])}.`);
    if (neighbour) focusRequest.current = { uid: neighbour.uid, control: 'toggle' };
    else paletteRef.current?.querySelector<HTMLElement>('button')?.focus();
  };

  const requestDelete = (field: DraftField) => {
    if (lockedIds.has(field.id)) setConfirmDelete(field.uid);
    else remove(field.uid);
  };

  const pendingDelete = fields.find((field) => field.uid === confirmDelete);

  return (
    <div>
      <p id="field-list-help" className="mb-3 text-xs text-sage-500">
        Select a field to edit it. To reorder, use the arrows or press Alt + ↑ / ↓ while a field is focused.
      </p>
      {fields.length === 0 ? (
        <p className="rounded-xl border border-dashed border-sage-300 bg-white px-4 py-8 text-center text-sm text-sage-600">
          This form has no fields yet. Add one below.
        </p>
      ) : (
        <ol aria-label="Form fields" aria-describedby="field-list-help" className="space-y-2">
          {fields.map((field, index) => (
            <FieldEditorCard
              key={field.uid}
              field={field}
              index={index}
              total={fields.length}
              issues={issues[field.uid]}
              expanded={expanded.has(field.uid)}
              locked={lockedIds.has(field.id)}
              mappedElsewhere={mappedByField.get(field.uid) ?? new Set()}
              update={update}
              onToggle={() => toggle(field.uid)}
              onMove={(delta, control) => move(index, delta, control)}
              onDuplicate={() => duplicate(index)}
              onDelete={() => requestDelete(field)}
            />
          ))}
        </ol>
      )}

      <div ref={paletteRef} className="mt-4 rounded-xl border border-sage-200 bg-sage-50/60 p-3">
        <h3 className="px-1 text-sm font-semibold text-sage-800">Add a field</h3>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {FIELD_TYPES.map((type) => {
            const Icon = FIELD_ICONS[type];
            return (
              <button
                key={type}
                type="button"
                disabled={fields.length >= MAX_FIELDS}
                onClick={() => add(type)}
                className="flex min-h-[56px] items-start gap-2 rounded-lg border border-sage-200 bg-white px-3 py-2 text-left transition-colors hover:border-primary-300 hover:bg-primary-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 disabled:opacity-50"
              >
                <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-primary-700" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-sage-900">{FIELD_TYPE_LABELS[type]}</span>
                  <span className="block text-xs text-sage-500">{FIELD_TYPE_DESCRIPTIONS[type]}</span>
                </span>
              </button>
            );
          })}
        </div>
        {fields.length >= MAX_FIELDS && <p className="mt-2 text-xs text-sage-600">Forms can have up to {MAX_FIELDS} fields.</p>}
      </div>

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="Delete this question?"
        message="Automatic flagging uses this question to alert you to responses that may need prompt attention. If you delete it, completed copies of this form won't be flagged."
        confirmLabel="Delete question"
        danger
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) remove(confirmDelete);
          setConfirmDelete(null);
        }}
      />
    </div>
  );
}
