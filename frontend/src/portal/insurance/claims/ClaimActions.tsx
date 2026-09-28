import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Ban, CheckCircle2, CopyPlus, Download, FilePen, Send } from 'lucide-react';
import { claimsApi, claimsKeys, type ClaimDetail } from '../../../api/claims';
import { Button } from '../../../ui/Button';
import { ConfirmDialog } from '../../../ui/Modal';
import { useToast } from '../../../ui/Toast';
import { ADJUDICABLE_CLAIM_STATUSES, EDITABLE_CLAIM_STATUSES } from '../labels';
import { SubmitClaimsDialog } from './SubmitClaimsDialog';

type Confirming = 'void' | 'correct' | null;

/** Validate, submit, correct, void, create a secondary claim, or print the CMS-1500. */
export function ClaimActions({ claim }: { claim: ClaimDetail }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [downloading, setDownloading] = useState(false);

  const editable = EDITABLE_CLAIM_STATUSES.includes(claim.status);
  const withPayer = ADJUDICABLE_CLAIM_STATUSES.includes(claim.status);
  const canSecondary = claim.payer_responsibility === 'P' && (claim.status === 'paid' || claim.status === 'denied');

  const refresh = () => queryClient.invalidateQueries({ queryKey: claimsKeys.all });

  /** Show the claim an action produced (a correction, void or secondary claim). */
  const openResult = (result: ClaimDetail, message: string) => {
    void refresh();
    toast.success(message);
    setConfirming(null);
    if (result.id !== claim.id) navigate(`/portal/billing/claims/${result.id}`);
  };
  const onError = (error: Error) => {
    toast.error(error);
    setConfirming(null);
  };

  const validate = useMutation({
    mutationFn: () => claimsApi.validate(claim.id),
    onSuccess: (result) => {
      void refresh();
      const count = result.issues.length;
      if (count === 0) toast.success('No problems found. The claim is ready to submit.');
      else toast.error(`${count} ${count === 1 ? 'problem' : 'problems'} to fix before submitting`);
    },
    onError,
  });
  const correct = useMutation({
    mutationFn: () => claimsApi.correct(claim.id),
    onSuccess: (result) => openResult(result, `Corrected claim ${result.patient_control_number} created as a draft`),
    onError,
  });
  const voidClaim = useMutation({
    mutationFn: () => claimsApi.void(claim.id),
    onSuccess: (result) =>
      openResult(
        result,
        result.id === claim.id ? 'Claim voided' : `Void claim ${result.patient_control_number} created. Submit it to cancel the original.`,
      ),
    onError,
  });
  const secondary = useMutation({
    mutationFn: () => claimsApi.secondary(claim.id),
    onSuccess: (result) => openResult(result, `Secondary claim ${result.patient_control_number} created as a draft`),
    onError,
  });

  const downloadForm = async () => {
    setDownloading(true);
    try {
      await claimsApi.downloadCms1500(claim);
    } catch (error) {
      toast.error(error);
    } finally {
      setDownloading(false);
    }
  };

  const confirmations: Record<Exclude<Confirming, null>, { title: string; message: ReactNode; label: string; run: () => void }> = {
    void: withPayer
      ? {
          title: 'Void this claim?',
          message: (
            <p>
              This creates a void claim as a draft. Submit it to tell the payer to cancel claim{' '}
              <strong>{claim.patient_control_number}</strong>.
            </p>
          ),
          label: 'Create void claim',
          run: () => voidClaim.mutate(),
        }
      : {
          title: 'Void this claim?',
          message: (
            <p>
              Claim <strong>{claim.patient_control_number}</strong> won&apos;t be submitted
              {claim.frequency_code === '1' && claim.payer_responsibility === 'P'
                ? ', and its sessions go back to the ready-to-file list.'
                : '.'}
            </p>
          ),
          label: 'Void claim',
          run: () => voidClaim.mutate(),
        },
    correct: {
      title: 'Correct this claim?',
      message: (
        <p>
          This creates a corrected copy of claim <strong>{claim.patient_control_number}</strong> as a draft. Edit it and submit
          it to replace the original with the payer.
        </p>
      ),
      label: 'Create corrected claim',
      run: () => correct.mutate(),
    },
  };
  const current = confirming ? confirmations[confirming] : null;

  return (
    <>
      <Button variant="secondary" icon={<Download className="h-4 w-4" />} loading={downloading} onClick={() => void downloadForm()}>
        CMS-1500
      </Button>
      {editable && (
        <>
          <Button
            variant="secondary"
            icon={<CheckCircle2 className="h-4 w-4" />}
            loading={validate.isPending}
            onClick={() => validate.mutate()}
          >
            Validate
          </Button>
          <Button icon={<Send className="h-4 w-4" />} onClick={() => setSubmitting(true)}>
            Submit
          </Button>
        </>
      )}
      {withPayer && (
        <Button variant="secondary" icon={<FilePen className="h-4 w-4" />} onClick={() => setConfirming('correct')}>
          Correct
        </Button>
      )}
      {canSecondary && (
        <Button
          variant="secondary"
          icon={<CopyPlus className="h-4 w-4" />}
          loading={secondary.isPending}
          onClick={() => secondary.mutate()}
        >
          Create secondary claim
        </Button>
      )}
      {claim.status !== 'void' && (
        <Button variant="ghost" icon={<Ban className="h-4 w-4" />} onClick={() => setConfirming('void')}>
          Void
        </Button>
      )}

      {submitting && <SubmitClaimsDialog claimIds={[claim.id]} onClose={() => setSubmitting(false)} />}
      <ConfirmDialog
        open={current !== null}
        title={current?.title ?? ''}
        message={current?.message ?? null}
        confirmLabel={current?.label}
        danger={confirming === 'void'}
        loading={voidClaim.isPending || correct.isPending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => current?.run()}
      />
    </>
  );
}
