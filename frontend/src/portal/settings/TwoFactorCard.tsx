import { useEffect, useState, type FormEvent } from 'react';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import { mfaApi } from '../../api/auth';
import { MfaSetupForm, RecoveryCodes } from '../../auth/MfaSetup';
import { useSession, useStaffAuth } from '../../auth/StaffAuth';
import { Button } from '../../ui/Button';
import { Card, CardBody, CardHeader } from '../../ui/Card';
import { Alert, Badge } from '../../ui/Display';
import { Field, Input } from '../../ui/Form';
import { Modal } from '../../ui/Modal';
import { useToast } from '../../ui/Toast';

function EnableModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { setSession } = useStaffAuth();
  return (
    <Modal open={open} onClose={onClose} title="Turn on two-factor authentication" size="md">
      <MfaSetupForm onEnabled={() => setSession()} onDone={onClose} />
    </Modal>
  );
}

function ConfirmIdentityModal({
  open,
  title,
  action,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  action: string;
  onClose: () => void;
  onSubmit: (password: string, code: string) => Promise<string[] | null>;
}) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setPassword('');
      setCode('');
      setCodes(null);
      setError(null);
    }
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const result = await onSubmit(password, code.trim());
      if (result) setCodes(result);
      else onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={title} size="sm">
      {codes ? (
        <RecoveryCodes codes={codes} onDone={onClose} />
      ) : (
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Password" required>
            {(props) => <Input {...props} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          <Field label="Authenticator or recovery code" required>
            {(props) => <Input {...props} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />}
          </Field>
          <Button type="submit" loading={loading} disabled={!password || code.trim().length < 6}>
            {action}
          </Button>
        </form>
      )}
    </Modal>
  );
}

/** Turn two-factor authentication on or off and manage recovery codes. */
export function TwoFactorCard() {
  const { staff } = useSession();
  const { setSession } = useStaffAuth();
  const toast = useToast();
  const [dialog, setDialog] = useState<'enable' | 'disable' | 'codes' | null>(null);
  const close = () => setDialog(null);

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            Two-factor authentication
            {staff.mfa_enabled ? <Badge tone="success">On</Badge> : <Badge tone="warning">Off</Badge>}
          </span>
        }
        description="Require a code from your phone when you sign in, so a stolen password isn't enough to reach client records."
      />
      <CardBody className="flex flex-wrap gap-2">
        {staff.mfa_enabled ? (
          <>
            <Button variant="secondary" onClick={() => setDialog('codes')}>
              New recovery codes
            </Button>
            <Button variant="ghost" icon={<ShieldOff className="h-4 w-4" />} onClick={() => setDialog('disable')}>
              Turn off
            </Button>
          </>
        ) : (
          <Button icon={<ShieldCheck className="h-4 w-4" />} onClick={() => setDialog('enable')}>
            Turn on two-factor authentication
          </Button>
        )}
      </CardBody>
      <EnableModal open={dialog === 'enable'} onClose={close} />
      <ConfirmIdentityModal
        open={dialog === 'disable'}
        title="Turn off two-factor authentication"
        action="Turn off"
        onClose={close}
        onSubmit={async (password, code) => {
          await mfaApi.disable(password, code);
          await setSession();
          toast.success('Two-factor authentication is off');
          return null;
        }}
      />
      <ConfirmIdentityModal
        open={dialog === 'codes'}
        title="Create new recovery codes"
        action="Create new codes"
        onClose={close}
        onSubmit={async (password, code) => (await mfaApi.regenerateRecoveryCodes(password, code)).recovery_codes}
      />
    </Card>
  );
}
