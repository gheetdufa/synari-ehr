import { useState, type FormEvent } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button } from '../ui/Button';
import { Alert } from '../ui/Display';
import { Field, Input } from '../ui/Form';

/** Second sign-in step: a 6-digit authenticator code, or a recovery code. */
export function MfaCodeForm({ onSubmit, onCancel }: { onSubmit: (code: string) => Promise<void>; onCancel: () => void }) {
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await onSubmit(code.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setLoading(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex items-start gap-3 text-sm text-sage-700">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-teal-600" />
        <p>
          {useRecovery
            ? 'Enter one of your recovery codes. Each code works once.'
            : 'Enter the 6-digit code from your authenticator app.'}
        </p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label={useRecovery ? 'Recovery code' : 'Authentication code'} required>
        {(props) => (
          <Input
            {...props}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            inputMode={useRecovery ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            autoFocus
            required
            maxLength={useRecovery ? 20 : 6}
            className="tracking-widest"
          />
        )}
      </Field>
      <Button type="submit" loading={loading} className="w-full">
        Verify and sign in
      </Button>
      <div className="flex justify-between text-sm">
        <button type="button" className="font-medium text-teal-700 hover:underline" onClick={() => { setUseRecovery(!useRecovery); setCode(''); }}>
          {useRecovery ? 'Use authenticator code' : 'Use a recovery code'}
        </button>
        <button type="button" className="text-sage-600 hover:underline" onClick={onCancel}>
          Start over
        </button>
      </div>
    </form>
  );
}
