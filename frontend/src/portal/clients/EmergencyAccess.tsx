import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, ShieldAlert } from 'lucide-react';
import { ApiError } from '../../api/client';
import { clientKeys } from '../../api/clients';
import {
  EMERGENCY_REASON_MAX,
  EMERGENCY_REASON_MIN,
  activeGrantFor,
  emergencyAccessApi,
  emergencyAccessKeys,
  type EmergencyGrant,
} from '../../api/emergencyAccess';
import { useSession } from '../../auth/StaffAuth';
import { formatTime } from '../../lib/format';
import { Button, LinkButton } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Alert, EmptyState } from '../../ui/Display';
import { Field, Textarea } from '../../ui/Form';
import { Modal } from '../../ui/Modal';
import { useToast } from '../../ui/Toast';

/** The live counter under the reason: how many more characters are needed, then how many are left. */
export function reasonCounter(length: number): string {
  if (length < EMERGENCY_REASON_MIN) {
    const needed = EMERGENCY_REASON_MIN - length;
    return `${needed} more ${needed === 1 ? 'character' : 'characters'} needed (at least ${EMERGENCY_REASON_MIN})`;
  }
  return `${length}/${EMERGENCY_REASON_MAX} characters`;
}

/** Your active emergency access to this client, if any (only clinicians can have one). */
export function useEmergencyGrant(clientId: number, enabled: boolean): EmergencyGrant | undefined {
  const grants = useQuery({ queryKey: emergencyAccessKeys.mine, queryFn: emergencyAccessApi.mine, enabled });
  return activeGrantFor(grants.data, clientId);
}

function EmergencyAccessDialog({ clientId, onClose }: { clientId: number; onClose: () => void }) {
  const { staff } = useSession();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const length = reason.trim().length;

  const reloadChart = () => {
    void queryClient.invalidateQueries({ queryKey: clientKeys.all });
    void queryClient.invalidateQueries({ queryKey: emergencyAccessKeys.mine });
  };

  const request = useMutation({
    mutationFn: () => emergencyAccessApi.request(clientId, reason.trim()),
    onMutate: () => setError(null),
    onSuccess: (grant) => {
      reloadChart();
      toast.success(`Emergency access granted until ${formatTime(grant.expires_at, staff.time_zone)}`);
      onClose();
    },
    onError: (err) => {
      // "You already have access to this chart": reload it so it opens.
      if (err instanceof ApiError && err.status === 409) reloadChart();
      setError(err.message);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (length >= EMERGENCY_REASON_MIN) request.mutate();
  };
  const close = () => !request.isPending && onClose();

  return (
    <Modal
      open
      onClose={close}
      size="md"
      title="Emergency access"
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={request.isPending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="emergency-access-form"
            variant="danger"
            loading={request.isPending}
            disabled={length < EMERGENCY_REASON_MIN}
          >
            Open chart
          </Button>
        </>
      }
    >
      <form id="emergency-access-form" onSubmit={submit} noValidate className="space-y-4">
        <Alert tone="warning" title="Only for emergencies">
          Use this when a client needs care now and their own clinician can&apos;t be reached, for example during a
          crisis.
        </Alert>
        <ul className="list-disc space-y-1 pl-5 text-sm text-sage-700">
          <li>You can open this chart for the next 4 hours.</li>
          <li>The practice owners and the client&apos;s clinician are notified right away.</li>
          <li>Your reason and everything you open are logged and reviewed.</li>
        </ul>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Reason" required hint={reasonCounter(length)}>
          {(props) => (
            <Textarea
              {...props}
              rows={4}
              maxLength={EMERGENCY_REASON_MAX}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
      </form>
    </Modal>
  );
}

function EmergencyAccessButton({ clientId }: { clientId: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" size="sm" icon={<ShieldAlert className="h-4 w-4" />} onClick={() => setOpen(true)}>
        Emergency access
      </Button>
      {open && <EmergencyAccessDialog clientId={clientId} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Shown to a clinician for a chart they can't open at all (the API answers 404). */
export function ChartUnavailable({ clientId }: { clientId: number }) {
  return (
    <Card>
      <EmptyState
        icon={<Lock />}
        title="This chart isn't available to you"
        description="This client isn't on your caseload, or isn't part of your practice. In an emergency, you can open the chart for 4 hours."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <EmergencyAccessButton clientId={clientId} />
            <LinkButton to="/portal/clients" variant="ghost" size="sm">
              Back to clients
            </LinkButton>
          </div>
        }
      />
    </Card>
  );
}

/** Shown to a clinician who sees a client's profile but not their clinical record. */
export function ClinicalAccessNotice({ clientId }: { clientId: number }) {
  return (
    <div className="mb-6">
      <Alert tone="neutral" title="This client's clinical record isn't available to you">
        <p>Notes and other clinical details are hidden because this client isn&apos;t on your caseload.</p>
        <div className="mt-3">
          <EmergencyAccessButton clientId={clientId} />
        </div>
      </Alert>
    </div>
  );
}

/** Reminds a clinician using emergency access that it's temporary and logged. */
export function EmergencyAccessBanner({ grant }: { grant: EmergencyGrant }) {
  const { staff } = useSession();
  return (
    <div className="mb-4">
      <Alert tone="warning" title={`Emergency access until ${formatTime(grant.expires_at, staff.time_zone)}`}>
        Every action is logged and reviewed by the practice owners. Exporting the record isn't included.
      </Alert>
    </div>
  );
}
