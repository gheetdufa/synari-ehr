import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { claimsApi, claimsKeys, type ClaimDetail } from '../../../api/claims';
import { useSession } from '../../../auth/StaffAuth';
import { formatDate, formatMoney } from '../../../lib/format';
import { Card, CardBody } from '../../../ui/Card';
import { Alert, ErrorState, PageHeader } from '../../../ui/Display';
import { SectionSpinner } from '../../../ui/Spinner';
import { ClaimStatusBadge } from '../Badges';
import { BillingSubNav } from '../BillingSubNav';
import { useClaimsRealtime } from '../hooks';
import {
  CLAIM_STATUS_HINTS,
  EDITABLE_CLAIM_STATUSES,
  FREQUENCY_LABELS,
  RESPONSIBILITY_LABELS,
  SUBMISSION_METHOD_LABELS,
} from '../labels';
import { ClaimActions } from './ClaimActions';
import { ClaimEditor } from './ClaimEditor';
import { ClaimIssues } from './ClaimIssues';
import { ClaimReadOnly } from './ClaimReadOnly';
import { ClaimTimeline } from './ClaimTimeline';
import { serviceDates } from './queue';

function Amount({ label, cents, emphasis = false }: { label: string; cents: number; emphasis?: boolean }) {
  return (
    <div className="rounded-lg bg-sage-50/70 px-3 py-2">
      <dt className="text-xs font-medium text-sage-500">{label}</dt>
      <dd className={`mt-0.5 tabular-nums ${emphasis ? 'text-lg font-semibold text-sage-900' : 'text-base font-medium text-sage-800'}`}>
        {formatMoney(cents)}
      </dd>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-sage-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-sage-900">{children}</dd>
    </div>
  );
}

function ClaimLink({ claimId, children }: { claimId: number; children: ReactNode }) {
  return (
    <Link to={`/portal/billing/claims/${claimId}`} className="font-medium text-primary-700 hover:underline">
      {children}
    </Link>
  );
}

function ClaimSummary({ claim }: { claim: ClaimDetail }) {
  const { staff } = useSession();
  const submitted = claim.submitted_at
    ? `${formatDate(claim.submitted_at, staff.time_zone)} · ${SUBMISSION_METHOD_LABELS[claim.submission_method]}`
    : 'Not yet';
  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <ClaimStatusBadge status={claim.status} />
          <p className="text-sm text-sage-600">{CLAIM_STATUS_HINTS[claim.status]}</p>
        </div>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <Amount label="Billed" cents={claim.total_charge_cents} />
          <Amount label="Insurance paid" cents={claim.paid_cents} />
          <Amount label="Adjustments" cents={claim.adjustment_cents} />
          <Amount label="Client responsibility" cents={claim.patient_responsibility_cents} />
          <Amount label="Insurance balance" cents={claim.insurance_balance_cents} emphasis />
        </dl>
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Detail label="Client">
            <Link to={`/portal/clients/${claim.client_id}`} className="font-medium text-primary-700 hover:underline">
              {claim.client_name}
            </Link>
          </Detail>
          <Detail label="Payer">
            {claim.payer_name} · {RESPONSIBILITY_LABELS[claim.payer_responsibility]}
          </Detail>
          <Detail label="Dates of service">{serviceDates(claim) || '—'}</Detail>
          <Detail label="Rendering clinician">
            {claim.rendering_clinician_name}
            {claim.supervising_clinician_name && (
              <span className="block text-xs text-sage-500">Supervised by {claim.supervising_clinician_name}</span>
            )}
          </Detail>
          <Detail label="Claim type">{FREQUENCY_LABELS[claim.frequency_code] ?? claim.frequency_code}</Detail>
          <Detail label="Submitted">{submitted}</Detail>
          {claim.payer_claim_number && <Detail label="Payer's claim number">{claim.payer_claim_number}</Detail>}
          {claim.prior_authorization_number && <Detail label="Prior authorization">{claim.prior_authorization_number}</Detail>}
          {claim.adjudicated_at && <Detail label="Processed">{formatDate(claim.adjudicated_at, staff.time_zone)}</Detail>}
          {claim.original_claim_id !== null && (
            <Detail label={claim.frequency_code === '8' ? 'Voids' : 'Replaces'}>
              <ClaimLink claimId={claim.original_claim_id}>The original claim</ClaimLink>
            </Detail>
          )}
          {claim.primary_claim_id !== null && (
            <Detail label="Secondary to">
              <ClaimLink claimId={claim.primary_claim_id}>The primary claim</ClaimLink>
            </Detail>
          )}
        </dl>
      </CardBody>
    </Card>
  );
}

/** One claim: amounts, what to fix, editing (drafts and rejected claims), actions and history. */
export default function ClaimDetailPage() {
  const claimId = Number(useParams().claimId);
  useClaimsRealtime();
  const claim = useQuery({
    queryKey: claimsKeys.detail(claimId),
    queryFn: () => claimsApi.get(claimId),
    enabled: Number.isInteger(claimId) && claimId > 0,
  });

  const back = (
    <Link to="/portal/billing/claims?view=claims" className="mb-3 inline-flex items-center gap-1 text-sm text-sage-600 hover:text-sage-900">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" /> All claims
    </Link>
  );

  if (claim.isError || !Number.isInteger(claimId) || claimId <= 0) {
    return (
      <div>
        <BillingSubNav />
        {back}
        <Card>
          <ErrorState error={claim.error ?? new Error('Claim not found')} onRetry={() => void claim.refetch()} />
        </Card>
      </div>
    );
  }
  if (claim.isPending) return <SectionSpinner />;

  const data = claim.data;
  const editable = EDITABLE_CLAIM_STATUSES.includes(data.status);

  return (
    <div>
      <BillingSubNav />
      {back}
      <PageHeader
        title={`Claim ${data.patient_control_number}`}
        description={`${data.client_name} · ${data.payer_name}`}
        actions={<ClaimActions claim={data} />}
      />
      <div className="space-y-6">
        {data.status === 'rejected' && data.last_error && (
          <Alert tone="danger" title="Rejected">
            {data.last_error}
          </Alert>
        )}
        <ClaimSummary claim={data} />
        {editable && <ClaimIssues claim={data} />}
        {editable ? <ClaimEditor key={data.id} claim={data} /> : <ClaimReadOnly claim={data} />}
        <ClaimTimeline events={data.events} />
      </div>
    </div>
  );
}
