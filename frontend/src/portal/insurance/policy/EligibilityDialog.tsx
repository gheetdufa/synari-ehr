import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { insuranceApi, insuranceKeys, type EligibilityCheck } from '../../../api/insurance';
import { useSession } from '../../../auth/StaffAuth';
import { formatDateTime } from '../../../lib/format';
import { Button } from '../../../ui/Button';
import { Alert, EmptyState, ErrorState } from '../../../ui/Display';
import { Modal } from '../../../ui/Modal';
import { SectionSpinner } from '../../../ui/Spinner';
import { EligibilityBadge } from '../Badges';
import { useInsuranceSettings } from '../hooks';
import { eligibilityHeadline, eligibilityRows } from './eligibility';

function CheckResult({ check }: { check: EligibilityCheck }) {
  const { staff } = useSession();
  const { result } = check;
  return (
    <section aria-label="Eligibility result" className="rounded-xl border border-sage-100 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <EligibilityBadge status={check.status} />
        <p className="text-sm text-sage-600">
          Checked {formatDateTime(check.created_at, staff.time_zone)}
          {check.checked_by_id === null && ' (automatic)'}
        </p>
      </div>
      {check.status === 'error' ? (
        <p className="mt-3 text-sm text-sage-800">{check.error || "The payer couldn't be reached. Try again later."}</p>
      ) : (
        <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {eligibilityRows(result).map((row) => (
            <div key={row.label}>
              <dt className="text-xs font-medium text-sage-500">{row.label}</dt>
              <dd className="text-sm text-sage-900">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {result.errors.length > 0 && (
        <div className="mt-3">
          <Alert tone="danger" title="The payer reported">
            <ul className="list-disc space-y-0.5 pl-5">
              {result.errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </Alert>
        </div>
      )}
      {result.messages.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-sage-500">Payer notes</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-sage-700">
            {result.messages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * A policy's eligibility: the latest answer (coverage, copay, coinsurance, deductible left),
 * past checks, and a new check through the clearinghouse.
 */
export function EligibilityDialog({
  policyId,
  payerName,
  clientName,
  onClose,
}: {
  policyId: number;
  payerName: string;
  clientName?: string;
  onClose: () => void;
}) {
  const { staff } = useSession();
  const queryClient = useQueryClient();
  const settings = useInsuranceSettings();
  const checks = useQuery({ queryKey: insuranceKeys.eligibility(policyId), queryFn: () => insuranceApi.eligibilityChecks(policyId) });
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const check = useMutation({
    mutationFn: () => insuranceApi.checkEligibility(policyId),
    onSuccess: (created) => {
      queryClient.setQueryData<EligibilityCheck[]>(insuranceKeys.eligibility(policyId), (current) => [created, ...(current ?? [])]);
      void queryClient.invalidateQueries({ queryKey: ['claims', 'unbilled'] });
      setSelectedId(created.id);
    },
  });

  const history = checks.data ?? [];
  const shown = history.find((entry) => entry.id === selectedId) ?? history[0];
  const clearinghouse = settings.data?.clearinghouse_enabled ?? false;

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`${payerName} eligibility`}
      description={clientName}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button
            icon={<RefreshCw className="h-4 w-4" />}
            loading={check.isPending}
            disabled={!clearinghouse}
            onClick={() => check.mutate()}
          >
            Check eligibility now
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {settings.data && !clearinghouse && (
          <Alert tone="info">
            Eligibility checks need a clearinghouse.{' '}
            <Link to="/portal/settings?tab=insurance" className="font-medium underline-offset-2 hover:underline">
              See insurance settings
            </Link>
            .
          </Alert>
        )}
        {check.isError && <Alert tone="danger">{check.error.message}</Alert>}
        {checks.isPending && <SectionSpinner />}
        {checks.isError && <ErrorState error={checks.error} onRetry={() => void checks.refetch()} />}
        {checks.data && history.length === 0 && (
          <EmptyState title="No eligibility checks yet" description="Check with the payer to see coverage and benefits." />
        )}
        {shown && <CheckResult check={shown} />}
        {history.length > 1 && (
          <section aria-label="Past checks">
            <h3 className="text-sm font-semibold text-sage-900">History</h3>
            <ul className="mt-2 divide-y divide-sage-100 rounded-lg border border-sage-100">
              {history.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    aria-current={entry.id === shown?.id ? 'true' : undefined}
                    onClick={() => setSelectedId(entry.id)}
                    className={`flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-sm hover:bg-sage-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 ${
                      entry.id === shown?.id ? 'bg-primary-50/60' : ''
                    }`}
                  >
                    <span className="text-sage-700">{formatDateTime(entry.created_at, staff.time_zone)}</span>
                    <EligibilityBadge status={entry.status} />
                    <span className="text-xs text-sage-500">{eligibilityHeadline(entry.result)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Modal>
  );
}
