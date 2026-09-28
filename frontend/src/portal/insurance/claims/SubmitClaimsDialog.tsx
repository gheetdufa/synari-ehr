import { useId, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { claimsApi, claimsKeys, rejectedClaims, type ClaimValidation, type SubmissionMethod } from '../../../api/claims';
import type { InsuranceSettings } from '../../../api/insurance';
import { Button } from '../../../ui/Button';
import { Alert } from '../../../ui/Display';
import { Modal } from '../../../ui/Modal';
import { SectionSpinner } from '../../../ui/Spinner';
import { useToast } from '../../../ui/Toast';
import { useInsuranceSettings } from '../hooks';

interface MethodOption {
  id: SubmissionMethod;
  label: string;
  description: ReactNode;
  unavailable: ReactNode | null;
}

const SETTINGS_LINK = (
  <Link to="/portal/settings?tab=insurance" className="font-medium text-primary-700 hover:underline">
    Settings › Insurance
  </Link>
);

function methodOptions(settings: InsuranceSettings): MethodOption[] {
  return [
    {
      id: 'stedi',
      label: 'Send through the clearinghouse',
      description: 'Submitted electronically. Acknowledgments and payments come back automatically.',
      unavailable: settings.clearinghouse_enabled ? null : <>No clearinghouse is connected. See {SETTINGS_LINK}.</>,
    },
    {
      id: 'x12_file',
      label: 'Download an 837P file',
      description: 'Upload the file to your clearinghouse. The claims are marked submitted.',
      unavailable:
        settings.x12_submitter_id && settings.x12_receiver_id ? null : (
          <>Add your clearinghouse&apos;s submitter and receiver IDs in {SETTINGS_LINK} first.</>
        ),
    },
    {
      id: 'paper',
      label: 'Print CMS-1500 forms',
      description: 'A PDF to print on red CMS-1500 forms and mail. The claims are marked submitted.',
      unavailable: null,
    },
  ];
}

const SUCCESS: Record<SubmissionMethod, (count: number) => string> = {
  stedi: (count) => `${count === 1 ? 'Claim' : `${count} claims`} queued for the clearinghouse`,
  x12_file: () => '837P file downloaded. Upload it to your clearinghouse.',
  paper: () => 'CMS-1500 forms downloaded. Print them on red CMS-1500 forms.',
};

function Problems({ claims, onNavigate }: { claims: ClaimValidation[]; onNavigate: () => void }) {
  return (
    <Alert tone="danger" title="Fix these claims before submitting them">
      <ul className="mt-1 space-y-3">
        {claims.map((claim) => (
          <li key={claim.claim_id}>
            <Link
              to={`/portal/billing/claims/${claim.claim_id}`}
              onClick={onNavigate}
              className="font-semibold underline-offset-2 hover:underline"
            >
              Claim {claim.patient_control_number}
            </Link>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {claim.issues.map((issue, index) => (
                <li key={`${issue.field}-${index}`}>{issue.message}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <p className="mt-2">Nothing was submitted.</p>
    </Alert>
  );
}

/** Choose how to submit draft or rejected claims: clearinghouse, 837P file or paper. */
export function SubmitClaimsDialog({ claimIds, onClose }: { claimIds: number[]; onClose: () => void }) {
  const settings = useInsuranceSettings();
  const queryClient = useQueryClient();
  const toast = useToast();
  const name = useId();
  const [choice, setChoice] = useState<SubmissionMethod | null>(null);
  const [problems, setProblems] = useState<ClaimValidation[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const options = settings.data ? methodOptions(settings.data) : [];
  const method = choice ?? options.find((option) => !option.unavailable)?.id ?? 'paper';

  const submit = useMutation({
    mutationFn: () => claimsApi.submit(claimIds, method),
    onSuccess: () => {
      toast.success(SUCCESS[method](claimIds.length));
      onClose();
    },
    onError: (failure) => {
      const found = rejectedClaims(failure);
      if (found) setProblems(found);
      else setError(failure.message);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: claimsKeys.all }),
  });

  const count = claimIds.length === 1 ? 'this claim' : `${claimIds.length} claims`;
  const close = () => !submit.isPending && onClose();

  return (
    <Modal
      open
      onClose={close}
      title={claimIds.length === 1 ? 'Submit claim' : `Submit ${claimIds.length} claims`}
      description={`Choose how to send ${count} to the payer.`}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={submit.isPending}>
            Cancel
          </Button>
          <Button
            loading={submit.isPending}
            disabled={!settings.data}
            onClick={() => {
              setProblems(null);
              setError(null);
              submit.mutate();
            }}
          >
            {method === 'stedi' ? 'Submit' : method === 'x12_file' ? 'Download 837P' : 'Download CMS-1500'}
          </Button>
        </>
      }
    >
      {settings.isPending && <SectionSpinner />}
      {settings.isError && <Alert tone="danger">{settings.error.message}</Alert>}
      {settings.data && (
        <div className="space-y-4">
          {problems && <Problems claims={problems} onNavigate={onClose} />}
          {error && <Alert tone="danger">{error}</Alert>}
          <fieldset className="space-y-2">
            <legend className="sr-only">Submission method</legend>
            {options.map((option) => (
              <label
                key={option.id}
                className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                  option.unavailable
                    ? 'cursor-not-allowed border-sage-100 bg-sage-50/60'
                    : method === option.id
                      ? 'cursor-pointer border-primary-400 bg-primary-50'
                      : 'cursor-pointer border-sage-200 hover:bg-sage-50'
                }`}
              >
                <input
                  type="radio"
                  name={name}
                  value={option.id}
                  checked={method === option.id}
                  disabled={Boolean(option.unavailable)}
                  onChange={() => setChoice(option.id)}
                  className="mt-0.5 h-4 w-4 accent-primary-600"
                />
                <span>
                  <span className={`font-medium ${option.unavailable ? 'text-sage-500' : 'text-sage-900'}`}>
                    {option.label}
                  </span>
                  <span className="block text-xs text-sage-600">{option.unavailable ?? option.description}</span>
                </span>
              </label>
            ))}
          </fieldset>
        </div>
      )}
    </Modal>
  );
}
