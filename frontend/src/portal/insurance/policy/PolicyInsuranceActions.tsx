import { useState } from 'react';
import { ClipboardCheck, ShieldCheck } from 'lucide-react';
import { Button } from '../../../ui/Button';
import { AuthorizationsDialog } from './AuthorizationsDialog';
import { EligibilityDialog } from './EligibilityDialog';

/**
 * Eligibility and prior-authorization buttons for a client's insurance policy card. Each opens
 * its dialog, which loads the policy's checks or authorizations when opened.
 */
export function PolicyInsuranceActions({
  policyId,
  payerName,
  clientName,
}: {
  policyId: number;
  payerName: string;
  clientName?: string;
}) {
  const [open, setOpen] = useState<'eligibility' | 'authorizations' | null>(null);
  const close = () => setOpen(null);
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      <Button
        size="sm"
        variant="secondary"
        icon={<ShieldCheck className="h-4 w-4" />}
        aria-label={`Eligibility for ${payerName}`}
        onClick={() => setOpen('eligibility')}
      >
        Eligibility
      </Button>
      <Button
        size="sm"
        variant="ghost"
        icon={<ClipboardCheck className="h-4 w-4" />}
        aria-label={`Authorizations for ${payerName}`}
        onClick={() => setOpen('authorizations')}
      >
        Authorizations
      </Button>
      {open === 'eligibility' && (
        <EligibilityDialog policyId={policyId} payerName={payerName} clientName={clientName} onClose={close} />
      )}
      {open === 'authorizations' && (
        <AuthorizationsDialog policyId={policyId} payerName={payerName} clientName={clientName} onClose={close} />
      )}
    </div>
  );
}
