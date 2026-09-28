import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCheck, Download } from 'lucide-react';
import { MAX_PAGE_SIZE } from '../../../api/client';
import { claimsApi, claimsKeys, type Claim } from '../../../api/claims';
import {
  remittanceKeys,
  remittancesApi,
  type Adjustment,
  type RemittanceClaim,
  type RemittanceDetail,
} from '../../../api/remittances';
import { useCan, useSession } from '../../../auth/StaffAuth';
import { formatDate, formatMoney, formatPlainDate } from '../../../lib/format';
import { Button } from '../../../ui/Button';
import { Card, CardBody, CardHeader } from '../../../ui/Card';
import { Alert, Badge, ErrorState, PageHeader, Table, Td, Th } from '../../../ui/Display';
import { Field, Select } from '../../../ui/Form';
import { ConfirmDialog } from '../../../ui/Modal';
import { SectionSpinner } from '../../../ui/Spinner';
import { useToast } from '../../../ui/Toast';
import { RemittanceStatusBadge } from '../Badges';
import { BillingSubNav } from '../BillingSubNav';
import { useClaimsRealtime } from '../hooks';
import { PAYMENT_METHOD_LABELS, providerAdjustmentDescription } from '../labels';
import { adjustmentText, candidateLabel, claimCandidates, unmatchedPayments } from './matching';
import { RemittancesLocked } from './RemittancesPage';

type Assignments = Record<number, number>;

function Adjustments({ adjustments }: { adjustments: Adjustment[] }) {
  if (adjustments.length === 0) return null;
  return (
    <ul className="space-y-0.5">
      {adjustments.map((adjustment, index) => {
        const { code, meaning } = adjustmentText(adjustment);
        return (
          <li key={`${code}-${index}`} className="text-xs">
            <span className="font-mono font-semibold text-sage-800">{code}</span>{' '}
            <span className="tabular-nums text-sage-900">{formatMoney(adjustment.amount_cents)}</span>{' '}
            <span className="text-sage-500">{meaning}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-sage-500">{label}</dt>
      <dd className="text-sm font-medium tabular-nums text-sage-900">{children}</dd>
    </div>
  );
}

function AssignClaim({
  payment,
  claims,
  value,
  onChange,
}: {
  payment: RemittanceClaim;
  claims: Claim[] | undefined;
  value: number | undefined;
  onChange: (claimId: number | undefined) => void;
}) {
  const { suggested, others } = claimCandidates(claims ?? [], payment);
  return (
    <Field
      label="Match to a claim"
      hint={`The remittance lists claim number ${payment.patient_control_number || '(blank)'}. Pick the claim this payment is for.`}
      className="sm:max-w-xl"
    >
      {(props) => (
        <Select
          {...props}
          value={value ?? ''}
          disabled={!claims}
          onChange={(event) => onChange(event.target.value ? Number(event.target.value) : undefined)}
        >
          <option value="">Leave unmatched</option>
          {suggested.length > 0 && (
            <optgroup label="Same amount billed">
              {suggested.map((claim) => (
                <option key={claim.id} value={claim.id}>
                  {candidateLabel(claim)}
                </option>
              ))}
            </optgroup>
          )}
          {others.length > 0 && (
            <optgroup label="Other claims">
              {others.map((claim) => (
                <option key={claim.id} value={claim.id}>
                  {candidateLabel(claim)}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
      )}
    </Field>
  );
}

function ClaimPayment({
  payment,
  assignable,
  claims,
  assigned,
  onAssign,
}: {
  payment: RemittanceClaim;
  assignable: boolean;
  claims: Claim[] | undefined;
  assigned: number | undefined;
  onAssign: (claimId: number | undefined) => void;
}) {
  const { staff } = useSession();
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-medium text-sage-900">
            <span>Claim {payment.patient_control_number || '(no number)'}</span>
            {payment.claim_id !== null ? (
              <Link to={`/portal/billing/claims/${payment.claim_id}`} className="text-sm text-primary-700 hover:underline">
                View claim
              </Link>
            ) : (
              <Badge tone="warning">Unmatched</Badge>
            )}
            {payment.posted_at && <Badge tone="success">Posted {formatDate(payment.posted_at, staff.time_zone)}</Badge>}
          </p>
          <p className="text-sm text-sage-600">
            {[payment.client_name, payment.status_description || `Status ${payment.status_code}`].filter(Boolean).join(' · ')}
          </p>
          {payment.payer_claim_number && (
            <p className="text-xs text-sage-500">Payer&apos;s claim number {payment.payer_claim_number}</p>
          )}
        </div>
        <dl className="flex gap-5">
          <Figure label="Billed">{formatMoney(payment.charge_cents)}</Figure>
          <Figure label="Paid">{formatMoney(payment.paid_cents)}</Figure>
          <Figure label="Client owes">{formatMoney(payment.patient_responsibility_cents)}</Figure>
        </dl>
      </div>
      {payment.adjustments.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-medium uppercase tracking-wide text-sage-500">Claim adjustments</p>
          <Adjustments adjustments={payment.adjustments} />
        </div>
      )}
      {payment.lines.length > 0 && (
        <div className="mt-3 overflow-hidden rounded-lg border border-sage-100">
          <Table>
            <thead className="bg-sage-50/60">
              <tr>
                <Th>Date</Th>
                <Th>Service</Th>
                <Th className="text-right">Billed</Th>
                <Th className="hidden text-right sm:table-cell">Allowed</Th>
                <Th className="text-right">Paid</Th>
                <Th>Adjustments</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-sage-100">
              {payment.lines.map((line, index) => (
                <tr key={`${line.line_control_number}-${index}`}>
                  <Td className="whitespace-nowrap">{line.service_date ? formatPlainDate(line.service_date) : '—'}</Td>
                  <Td>
                    {line.procedure_code}
                    {line.modifiers.length > 0 && <span className="text-sage-600"> {line.modifiers.join(' ')}</span>}
                    {line.remark_codes.length > 0 && (
                      <span className="block text-xs text-sage-500">Remarks {line.remark_codes.join(', ')}</span>
                    )}
                  </Td>
                  <Td className="text-right tabular-nums">{formatMoney(line.charge_cents)}</Td>
                  <Td className="hidden text-right tabular-nums sm:table-cell">
                    {line.allowed_cents === null ? '—' : formatMoney(line.allowed_cents)}
                  </Td>
                  <Td className="text-right tabular-nums">{formatMoney(line.paid_cents)}</Td>
                  <Td>
                    <Adjustments adjustments={line.adjustments} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
      {assignable && (
        <div className="mt-3">
          <AssignClaim payment={payment} claims={claims} value={assigned} onChange={onAssign} />
        </div>
      )}
    </li>
  );
}

function RemittanceView({ remittance }: { remittance: RemittanceDetail }) {
  const { staff } = useSession();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [assignments, setAssignments] = useState<Assignments>({});
  const [confirming, setConfirming] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const unmatched = unmatchedPayments(remittance);
  const postable = remittance.status !== 'posted';
  const payerFilter = remittance.payer_id === null ? {} : { payer_id: remittance.payer_id };
  // The payer's most recent claims are the ones an unmatched payment can belong to.
  const claims = useQuery({
    queryKey: claimsKeys.recent(payerFilter),
    queryFn: () => claimsApi.list({ ...payerFilter, limit: MAX_PAGE_SIZE }),
    select: (page) => page.items,
    enabled: postable && unmatched.length > 0,
  });

  const post = useMutation({
    mutationFn: () =>
      remittancesApi.post(
        remittance.id,
        Object.entries(assignments).map(([paymentId, claimId]) => ({ remittance_claim_id: Number(paymentId), claim_id: claimId })),
      ),
    onSuccess: (posted) => {
      queryClient.setQueryData(remittanceKeys.detail(remittance.id), posted);
      void queryClient.invalidateQueries({ queryKey: remittanceKeys.all });
      void queryClient.invalidateQueries({ queryKey: claimsKeys.all });
      setAssignments({});
      setConfirming(false);
      toast.success('Payment posted');
    },
    onError: (error) => {
      setConfirming(false);
      toast.error(error);
    },
  });

  const assign = (paymentId: number, claimId: number | undefined) =>
    setAssignments((current) => {
      const next = { ...current };
      if (claimId === undefined) delete next[paymentId];
      else next[paymentId] = claimId;
      return next;
    });

  const stillUnmatched = unmatched.filter((payment) => assignments[payment.id] === undefined).length;
  const download = async () => {
    setDownloading(true);
    try {
      await remittancesApi.downloadFile(remittance.id);
    } catch (error) {
      toast.error(error);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <>
      <PageHeader
        title={`${remittance.payer_name || 'Unknown payer'} · ${formatMoney(remittance.total_paid_cents)}`}
        description={`${PAYMENT_METHOD_LABELS[remittance.payment_method] ?? remittance.payment_method} ${remittance.trace_number}`}
        actions={
          <>
            {remittance.file_id !== null && (
              <Button variant="secondary" icon={<Download className="h-4 w-4" />} loading={downloading} onClick={() => void download()}>
                Original file
              </Button>
            )}
            {postable && (
              <Button icon={<CheckCheck className="h-4 w-4" />} onClick={() => setConfirming(true)}>
                Post payment
              </Button>
            )}
          </>
        }
      />
      <div className="space-y-6">
        {remittance.status === 'needs_review' && (
          <Alert tone="warning" title="This payment needs review">
            It couldn&apos;t be posted automatically
            {unmatched.length > 0 ? ': some payments below didn’t match one of your claims. Match them, then post.' : '. Check the payments below, then post.'}
          </Alert>
        )}
        <Card>
          <CardBody>
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Figure label="Status">
                <RemittanceStatusBadge status={remittance.status} />
              </Figure>
              <Figure label="Payment date">{remittance.payment_date ? formatPlainDate(remittance.payment_date) : '—'}</Figure>
              <Figure label={remittance.source === 'upload' ? 'Uploaded' : 'Received'}>
                {formatDate(remittance.created_at, staff.time_zone)}
              </Figure>
              <Figure label="Posted">{remittance.posted_at ? formatDate(remittance.posted_at, staff.time_zone) : 'Not yet'}</Figure>
            </dl>
            {remittance.provider_adjustments.length > 0 && (
              <div className="mt-4 border-t border-sage-100 pt-3">
                <p className="text-xs font-medium uppercase tracking-wide text-sage-500">Provider adjustments</p>
                <ul className="mt-1 space-y-0.5 text-sm">
                  {remittance.provider_adjustments.map((adjustment, index) => (
                    <li key={`${adjustment.reason_code}-${index}`}>
                      <span className="font-mono font-semibold">{adjustment.reason_code}</span>{' '}
                      <span className="tabular-nums">{formatMoney(adjustment.amount_cents)}</span>{' '}
                      <span className="text-sage-500">
                        {[providerAdjustmentDescription(adjustment.reason_code), adjustment.reference].filter(Boolean).join(' · ')}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title={`Claim payments (${remittance.claims.length})`}
            description="What the payer paid and adjusted for each claim. Adjustment codes: CO contractual, PR client responsibility, OA other, PI payer reduction."
          />
          <ul className="divide-y divide-sage-100">
            {remittance.claims.map((payment) => (
              <ClaimPayment
                key={payment.id}
                payment={payment}
                assignable={postable && payment.claim_id === null && payment.posted_at === null}
                claims={claims.data}
                assigned={assignments[payment.id]}
                onAssign={(claimId) => assign(payment.id, claimId)}
              />
            ))}
          </ul>
        </Card>
      </div>
      <ConfirmDialog
        open={confirming}
        title="Post this payment?"
        confirmLabel="Post payment"
        loading={post.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => post.mutate()}
        message={
          <div className="space-y-2">
            <p>Matched payments are applied to their claims, and what clients owe moves to their balances.</p>
            {stillUnmatched > 0 && (
              <p>
                {stillUnmatched === 1 ? '1 payment stays' : `${stillUnmatched} payments stay`} unmatched and won&apos;t be
                posted.
              </p>
            )}
          </div>
        }
      />
    </>
  );
}

/** One insurance payment: its claim payments and adjustments, matching and posting. */
export default function RemittanceDetailPage() {
  const remittanceId = Number(useParams().remittanceId);
  const billsEveryone = useCan('billing_all');
  useClaimsRealtime();
  const valid = Number.isInteger(remittanceId) && remittanceId > 0;
  const remittance = useQuery({
    queryKey: remittanceKeys.detail(remittanceId),
    queryFn: () => remittancesApi.get(remittanceId),
    enabled: billsEveryone && valid,
  });

  const back = (
    <Link to="/portal/billing/remittances" className="mb-3 inline-flex items-center gap-1 text-sm text-sage-600 hover:text-sage-900">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" /> All insurance payments
    </Link>
  );

  let body: ReactNode;
  if (!billsEveryone) body = <RemittancesLocked />;
  else if (!valid || remittance.isError) {
    body = (
      <Card>
        <ErrorState error={remittance.error ?? new Error('Remittance not found')} onRetry={() => void remittance.refetch()} />
      </Card>
    );
  } else if (remittance.isPending) body = <SectionSpinner />;
  else body = <RemittanceView remittance={remittance.data} />;

  return (
    <div>
      <BillingSubNav />
      {billsEveryone && back}
      {body}
    </div>
  );
}
