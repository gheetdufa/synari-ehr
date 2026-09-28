import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { claimsKeys } from '../../../api/claims';
import { remittanceKeys, remittancesApi, type ResponseFileResult } from '../../../api/remittances';
import { formatMoney } from '../../../lib/format';
import { Button } from '../../../ui/Button';
import { Alert } from '../../../ui/Display';
import { Modal } from '../../../ui/Modal';

const KIND_LABELS: Record<ResponseFileResult['kind'], string> = {
  '835': 'Remittance (835)',
  '277': 'Claim acknowledgment (277CA)',
  '999': 'File acknowledgment (999)',
};

function Result({ result, onNavigate }: { result: ResponseFileResult; onNavigate: () => void }) {
  return (
    <Alert tone="success" title={`${KIND_LABELS[result.kind]}: ${result.message}`}>
      {result.remittances.length > 0 && (
        <ul className="mt-1 space-y-1">
          {result.remittances.map((remittance) => (
            <li key={remittance.id}>
              <Link
                to={`/portal/billing/remittances/${remittance.id}`}
                onClick={onNavigate}
                className="font-medium underline-offset-2 hover:underline"
              >
                {remittance.payer_name || 'Payment'} · {formatMoney(remittance.total_paid_cents)}
              </Link>
              {remittance.status === 'needs_review' && ' needs review'}
            </li>
          ))}
        </ul>
      )}
      {result.kind !== '835' && result.claim_ids.length > 0 && (
        <Link to="/portal/billing/claims?view=claims" onClick={onNavigate} className="mt-1 inline-block font-medium hover:underline">
          View claims
        </Link>
      )}
    </Alert>
  );
}

/** Import an 835 remittance, 277CA or 999 file downloaded from a clearinghouse. */
export function UploadResponseFileDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const inputId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ResponseFileResult | null>(null);
  // Remounts the file input after an upload so the next file starts from a clear picker.
  const [inputKey, setInputKey] = useState(0);

  const upload = useMutation({
    mutationFn: (chosen: File) => remittancesApi.upload(chosen),
    onSuccess: (uploaded) => {
      setResult(uploaded);
      setFile(null);
      setInputKey((key) => key + 1);
      void queryClient.invalidateQueries({ queryKey: remittanceKeys.all });
      void queryClient.invalidateQueries({ queryKey: claimsKeys.all });
    },
  });

  const close = () => !upload.isPending && onClose();

  return (
    <Modal
      open
      onClose={close}
      title="Upload a clearinghouse file"
      description="An 835 remittance (ERA), a 277CA claim acknowledgment or a 999 file acknowledgment."
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={upload.isPending}>
            {result ? 'Done' : 'Cancel'}
          </Button>
          <Button loading={upload.isPending} disabled={!file} onClick={() => file && upload.mutate(file)}>
            Upload
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {result && <Result result={result} onNavigate={onClose} />}
        {upload.isError && <Alert tone="danger">{upload.error.message}</Alert>}
        <div>
          <label htmlFor={inputId} className="mb-1 block text-sm font-medium text-sage-800">
            File
          </label>
          <input
            key={inputKey}
            id={inputId}
            type="file"
            accept=".835,.277,.999,.txt,.edi,.x12,.dat"
            onChange={(event) => {
              upload.reset();
              setResult(null);
              setFile(event.target.files?.[0] ?? null);
            }}
            className="block w-full text-sm text-sage-700 file:mr-3 file:rounded-lg file:border file:border-sage-200 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-sage-800 hover:file:bg-sage-50"
          />
          <p className="mt-1 text-xs text-sage-500">
            Payments are posted automatically when they balance and match your claims; anything else waits for review.
          </p>
        </div>
      </div>
    </Modal>
  );
}
