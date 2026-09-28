import { useEffect, useRef, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { Download } from 'lucide-react';
import { mfaApi } from '../api/auth';
import { Button } from '../ui/Button';
import { Alert } from '../ui/Display';
import { Field, Input } from '../ui/Form';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong';
}

/** New recovery codes, shown once, with a download. `onDone` may be async; its error is shown here. */
export function RecoveryCodes({
  codes,
  doneLabel = "I've saved them",
  onDone,
}: {
  codes: string[];
  doneLabel?: string;
  onDone: () => void | Promise<void>;
}) {
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = () => {
    const blob = new Blob([`Synari recovery codes\n\n${codes.join('\n')}\n\nEach code works once.\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'synari-recovery-codes.txt';
    link.click();
    URL.revokeObjectURL(url);
  };

  const finish = async () => {
    setFinishing(true);
    setError(null);
    try {
      await onDone();
    } catch (err) {
      setError(errorText(err));
      setFinishing(false);
    }
  };

  return (
    <div className="space-y-4">
      <Alert tone="warning" title="Save these recovery codes now">
        If you lose your phone, each code lets you sign in once. They won't be shown again.
      </Alert>
      <ul className="grid grid-cols-2 gap-2 rounded-lg bg-sage-50 p-4 font-mono text-sm text-sage-900">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" icon={<Download className="h-4 w-4" />} onClick={download}>
          Download codes
        </Button>
        <Button loading={finishing} onClick={() => void finish()}>
          {doneLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * Two-factor setup: scan a QR code (or type the key), confirm a code, then save the recovery
 * codes. Starts a new setup when it mounts. `onEnabled` runs as soon as the server turns 2FA on;
 * `onDone` when the person has saved their recovery codes.
 */
export function MfaSetupForm({
  onEnabled,
  onDone,
  doneLabel,
}: {
  onEnabled?: () => Promise<void>;
  onDone: () => void | Promise<void>;
  doneLabel?: string;
}) {
  const [secret, setSecret] = useState('');
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // One setup request per mount: StrictMode runs effects twice in development, and the ref keeps
  // the first request so both runs wait for it (a real remount starts a new one).
  const setupRequest = useRef<ReturnType<typeof mfaApi.setup> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setupRequest.current ??= mfaApi.setup();
    setupRequest.current
      .then(async (data) => {
        const image = await QRCode.toDataURL(data.otpauth_uri, { margin: 1, width: 200 });
        if (cancelled) return;
        setSecret(data.secret);
        setQr(image);
      })
      .catch((err: unknown) => !cancelled && setError(errorText(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const result = await mfaApi.enable(code.trim());
      setCodes(result.recovery_codes);
      await onEnabled?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  };

  if (codes) return <RecoveryCodes codes={codes} doneLabel={doneLabel} onDone={onDone} />;

  return (
    <form onSubmit={(event) => void confirm(event)} className="space-y-4">
      <ol className="list-decimal space-y-1 pl-5 text-sm text-sage-700">
        <li>Open an authenticator app (1Password, Google Authenticator, Authy, Microsoft Authenticator…).</li>
        <li>Scan this QR code, or enter the key by hand.</li>
        <li>Type the 6-digit code the app shows.</li>
      </ol>
      {qr && <img src={qr} alt="QR code for your authenticator app" className="mx-auto h-48 w-48" />}
      {secret && (
        <p className="break-all text-center font-mono text-sm tracking-wider text-sage-800">
          {secret.match(/.{1,4}/g)?.join(' ')}
        </p>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="6-digit code" required>
        {(props) => (
          <Input
            {...props}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            className="tracking-widest"
          />
        )}
      </Field>
      <Button type="submit" loading={loading} disabled={code.trim().length !== 6}>
        Turn on
      </Button>
    </form>
  );
}
