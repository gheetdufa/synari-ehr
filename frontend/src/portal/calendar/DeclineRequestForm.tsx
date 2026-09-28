import { useState, type FormEvent } from 'react';
import { Button } from '../../ui/Button';
import { Checkbox, Field, Textarea } from '../../ui/Form';

/** Reason for declining a request, and whether the requester sees it in the email. */
export function DeclineRequestForm({
  loading,
  onSubmit,
  onBack,
}: {
  loading: boolean;
  onSubmit: (reason: string, includeReason: boolean) => void;
  onBack: () => void;
}) {
  const [reason, setReason] = useState('');
  const [includeReason, setIncludeReason] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(reason.trim(), includeReason && reason.trim() !== '');
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Reason (optional)" hint="Kept on the appointment for your records.">
        {(props) => (
          <Textarea
            {...props}
            rows={3}
            maxLength={1000}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. That time is no longer available"
          />
        )}
      </Field>
      <Checkbox
        label="Include the reason in the email"
        description="Otherwise the requester is told only that the time isn't available."
        checked={includeReason}
        disabled={reason.trim() === ''}
        onChange={(event) => setIncludeReason(event.target.checked)}
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onBack} disabled={loading}>
          Back
        </Button>
        <Button type="submit" variant="danger" loading={loading}>
          Decline request
        </Button>
      </div>
    </form>
  );
}
