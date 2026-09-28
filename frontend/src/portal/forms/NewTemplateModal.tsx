import { useState, type FormEvent } from 'react';
import { FORM_KINDS, FORM_KIND_LABELS, type FormKind } from '../../api/forms';
import { MAX_TEMPLATE_NAME_LENGTH } from '../../shared/forms/fieldTypes';
import { Button } from '../../ui/Button';
import { Field, Input, Select } from '../../ui/Form';
import { Modal } from '../../ui/Modal';
import { useCreateTemplate } from './useTemplateActions';

const KIND_HINTS: Record<FormKind, string> = {
  intake: 'Questions new clients answer before their first session.',
  consent: 'Text clients read and sign. E-signature is turned on for you.',
  assessment: 'A questionnaire or measure. Custom assessments aren’t scored automatically.',
  other: 'Anything else, such as a feedback form or release of information.',
};

/** Name and kind for a new template; creating it opens the editor. */
export function NewTemplateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<FormKind>('intake');
  const [error, setError] = useState<string | null>(null);
  const create = useCreateTemplate();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError('Give the form a name');
      return;
    }
    create.mutate({ kind, name });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New form template"
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="new-template-form" loading={create.isPending}>
            Create and edit
          </Button>
        </>
      }
    >
      <form id="new-template-form" onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Name" required error={error}>
          {(props) => (
            <Input
              {...props}
              value={name}
              maxLength={MAX_TEMPLATE_NAME_LENGTH}
              placeholder="e.g. Couples intake"
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
            />
          )}
        </Field>
        <Field label="Kind" hint={KIND_HINTS[kind]}>
          {(props) => (
            <Select {...props} value={kind} onChange={(event) => setKind(event.target.value as FormKind)}>
              {FORM_KINDS.map((option) => (
                <option key={option} value={option}>
                  {FORM_KIND_LABELS[option]}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </form>
    </Modal>
  );
}
