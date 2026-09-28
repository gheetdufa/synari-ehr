import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from './Button';
import { Field, Textarea } from './Form';
import { Modal } from './Modal';

/**
 * A dialog that asks for required text before an action: the reason for unlocking a signed note,
 * extending or denying a request, a rebuttal. The text is trimmed; submitting empty text shows an
 * error instead of calling `onSubmit`.
 */
export function ReasonDialog({
  open,
  title,
  description,
  label,
  hint,
  confirmLabel,
  maxLength,
  danger = false,
  loading = false,
  children,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  label: string;
  hint?: ReactNode;
  confirmLabel: string;
  maxLength: number;
  danger?: boolean;
  loading?: boolean;
  /** Shown above the text field. */
  children?: ReactNode;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setText('');
      setError(null);
    }
  }, [open]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) {
      setError(`Enter ${label.toLowerCase()}`);
      return;
    }
    onSubmit(trimmed);
  };

  const formId = `reason-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant={danger ? 'danger' : 'primary'} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-4">
        {children}
        <Field label={label} hint={hint} error={error} required>
          {(props) => (
            <Textarea
              {...props}
              rows={4}
              maxLength={maxLength}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                if (error) setError(null);
              }}
            />
          )}
        </Field>
      </form>
    </Modal>
  );
}
