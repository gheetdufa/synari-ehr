import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Ban, ChevronDown, ChevronUp, FilePenLine, FilePlus2, RefreshCw, Send, Trash2 } from 'lucide-react';
import type { ClientDetail } from '../../api/clients';
import { estimateKeys, estimatesApi, type Estimate } from '../../api/estimates';
import { useSession } from '../../auth/StaffAuth';
import { formatDate, formatMoney, formatPlainDate } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Alert, Badge, EmptyState, ErrorState } from '../../ui/Display';
import { SectionSpinner } from '../../ui/Spinner';
import { Detail, PdfButton } from '../billing/components/BillingDisplay';
import { usePracticeDay } from '../billing/hooks';
import { DeleteEstimateDialog, IssueEstimateDialog, SupersedeEstimateDialog, VoidEstimateDialog } from './EstimateDialogs';
import { EstimateFormModal } from './EstimateFormModal';
import {
  DELIVERY_LABELS,
  ESTIMATE_REASON_LABELS,
  ESTIMATE_STATUS_LABELS,
  ESTIMATE_STATUS_TONES,
  canChangeEstimate,
  diagnosisLetter,
  totalLabel,
} from './estimateHelpers';

type Dialog =
  | { kind: 'form'; estimate?: Estimate }
  | { kind: 'issue'; estimate: Estimate }
  | { kind: 'supersede'; estimate: Estimate }
  | { kind: 'void'; estimate: Estimate }
  | { kind: 'delete'; estimate: Estimate };

function EstimateDetails({ estimate, timeZone }: { estimate: Estimate; timeZone: string }) {
  const provider = estimate.provider;
  return (
    <div className="mt-3 space-y-4 rounded-lg bg-sage-50/70 p-3 text-sm">
      {estimate.change_summary && (
        <p>
          <span className="font-medium text-sage-900">What changed: </span>
          <span className="text-sage-700">{estimate.change_summary}</span>
        </p>
      )}
      {estimate.void_reason && (
        <p>
          <span className="font-medium text-sage-900">Void: </span>
          <span className="text-sage-700">{estimate.void_reason}</span>
        </p>
      )}
      {estimate.items.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm" aria-label="Estimated services">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-sage-500">
                <th scope="col" className="py-1 pr-3 font-semibold">Service</th>
                <th scope="col" className="py-1 pr-3 font-semibold">Code</th>
                <th scope="col" className="py-1 pr-3 font-semibold">Diagnoses</th>
                <th scope="col" className="py-1 pr-3 text-right font-semibold">Quantity</th>
                <th scope="col" className="py-1 pr-3 text-right font-semibold">Fee each</th>
                <th scope="col" className="py-1 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-sage-100">
              {estimate.items.map((item) => (
                <tr key={item.id}>
                  <td className="py-1.5 pr-3 text-sage-900">
                    {item.description}
                    {(item.frequency || item.location) && (
                      <span className="block text-xs text-sage-500">{[item.frequency, item.location].filter(Boolean).join(' · ')}</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-sage-700">{item.service_code || '—'}</td>
                  <td className="py-1.5 pr-3 text-sage-700">{item.diagnosis_pointers.join(', ') || '—'}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{item.quantity}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{formatMoney(item.unit_fee_cents)}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatMoney(item.total_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sage-600">No services yet.</p>
      )}
      <dl className="grid gap-3 sm:grid-cols-2">
        <Detail label="Diagnoses">
          {estimate.diagnosis_codes.length === 0
            ? 'Not yet determined'
            : estimate.diagnosis_codes.map((diagnosis, index) => (
                <span key={diagnosis.code} className="block">
                  {diagnosisLetter(index)}. {diagnosis.code}
                  {diagnosis.description && ` ${diagnosis.description}`}
                </span>
              ))}
        </Detail>
        <Detail label="Scheduled dates">
          {estimate.scheduled_dates.length === 0 ? 'Not yet scheduled' : estimate.scheduled_dates.map(formatPlainDate).join(', ')}
        </Detail>
        <Detail label="Provider">
          {provider.name || estimate.clinician_name}
          {provider.npi && <span className="block text-sage-600">NPI {provider.npi}{provider.npi_kind === 'group' ? ' (group)' : ''}</span>}
          {provider.tin && <span className="block text-sage-600">Tax ID {provider.tin}</span>}
        </Detail>
        {estimate.issued_at && (
          <Detail label="Issued">
            {formatDate(estimate.issued_at, timeZone)}
            {estimate.issued_by_name && ` by ${estimate.issued_by_name}`} · {DELIVERY_LABELS[estimate.delivery_method]}
          </Detail>
        )}
      </dl>
      {estimate.separately_scheduled.length > 0 && (
        <div>
          <p className="font-medium text-sage-900">Scheduled separately</p>
          <ul className="list-disc pl-5 text-sage-700">
            {estimate.separately_scheduled.map((entry, index) => (
              <li key={index}>{[entry.description, entry.provider, entry.note].filter(Boolean).join(' · ')}</li>
            ))}
          </ul>
        </div>
      )}
      {estimate.notes && <p className="whitespace-pre-wrap text-sage-700">{estimate.notes}</p>}
    </div>
  );
}

function EstimateRow({
  estimate,
  canChange,
  timeZone,
  onAction,
}: {
  estimate: Estimate;
  canChange: boolean;
  timeZone: string;
  onAction: (dialog: Dialog) => void;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = `estimate-${estimate.id}-details`;
  return (
    <li className="px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-medium text-sage-900">
            {estimate.primary_service}
            <Badge tone={ESTIMATE_STATUS_TONES[estimate.status]}>{ESTIMATE_STATUS_LABELS[estimate.status]}</Badge>
            {estimate.status === 'draft' && estimate.overdue && <Badge tone="danger">Overdue</Badge>}
          </p>
          <p className="mt-0.5 text-sm text-sage-600">
            {estimate.clinician_name} · {formatPlainDate(estimate.period_start)} – {formatPlainDate(estimate.period_end)} ·{' '}
            <span className="tabular-nums">{totalLabel(estimate.total_cents)}</span>
          </p>
          {estimate.status === 'draft' && (
            <p className={`mt-0.5 text-sm ${estimate.overdue ? 'font-medium text-red-700' : 'text-sage-600'}`}>
              {ESTIMATE_REASON_LABELS[estimate.reason]}
              {estimate.due_on && ` · due ${formatPlainDate(estimate.due_on)}`}
            </p>
          )}
          {estimate.issued_at && estimate.status !== 'draft' && (
            <p className="mt-0.5 text-sm text-sage-600">
              Issued {formatDate(estimate.issued_at, timeZone)}
              {estimate.acknowledged_at
                ? ` · acknowledged by ${estimate.acknowledged_name} on ${formatDate(estimate.acknowledged_at, timeZone)}`
                : ''}
            </p>
          )}
          {estimate.supersedes_id !== null && estimate.status === 'draft' && (
            <p className="mt-0.5 text-sm text-sage-600">Replaces an issued estimate when issued.</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PdfButton
            download={() => estimatesApi.downloadPdf(estimate.id)}
            label={estimate.status === 'draft' ? 'Preview' : 'PDF'}
            accessibleLabel={`Download ${estimate.status === 'draft' ? 'a preview of the draft' : 'the estimate'} as PDF`}
          />
          {canChange && estimate.status === 'draft' && (
            <>
              <Button size="sm" variant="secondary" icon={<FilePenLine className="h-4 w-4" />} onClick={() => onAction({ kind: 'form', estimate })}>
                Edit
              </Button>
              <Button size="sm" icon={<Send className="h-4 w-4" />} onClick={() => onAction({ kind: 'issue', estimate })}>
                Issue
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash2 className="h-4 w-4" />}
                aria-label="Delete draft"
                onClick={() => onAction({ kind: 'delete', estimate })}
              >
                <span className="hidden sm:inline">Delete</span>
              </Button>
            </>
          )}
          {canChange && estimate.status === 'issued' && (
            <>
              <Button size="sm" variant="secondary" icon={<RefreshCw className="h-4 w-4" />} onClick={() => onAction({ kind: 'supersede', estimate })}>
                Update
              </Button>
              <Button size="sm" variant="ghost" icon={<Ban className="h-4 w-4" />} onClick={() => onAction({ kind: 'void', estimate })}>
                Void
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={open}
            aria-controls={detailsId}
            icon={open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            onClick={() => setOpen((value) => !value)}
          >
            Details
          </Button>
        </div>
      </div>
      <div id={detailsId} hidden={!open}>
        {open && <EstimateDetails estimate={estimate} timeZone={timeZone} />}
      </div>
    </li>
  );
}

/** A client's Good Faith Estimates: drafts to finish and issue, and every estimate given. */
export default function ClientEstimatesTab({ client }: { client: ClientDetail }) {
  const session = useSession();
  const { today, timeZone } = usePracticeDay();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const estimates = useQuery({ queryKey: estimateKeys.forClient(client.id), queryFn: () => estimatesApi.forClient(client.id) });
  const options = useQuery({ queryKey: estimateKeys.options(client.id), queryFn: () => estimatesApi.options(client.id) });
  const who = { billing: client.access.billing, staffId: session.staff.id };
  const canCreate = (options.data?.clinicians.length ?? 0) > 0 && options.data?.enabled !== false;
  const close = () => setDialog(null);

  return (
    <Card>
      <CardHeader
        title="Good faith estimates"
        description="Expected charges for self-pay and uninsured clients, as the No Surprises Act requires. Clients see issued estimates in their portal."
        actions={
          canCreate && (
            <Button icon={<FilePlus2 className="h-4 w-4" />} onClick={() => setDialog({ kind: 'form' })}>
              New estimate
            </Button>
          )
        }
      />
      {options.data && !options.data.enabled && (
        <div className="px-4 pt-4 sm:px-5">
          <Alert tone="info">Good faith estimates are turned off for your practice. An owner or manager can turn them on in Settings, under Billing.</Alert>
        </div>
      )}
      {options.data?.enabled && !options.data.self_pay && (
        <div className="px-4 pt-4 sm:px-5">
          <Alert tone="neutral">
            This client is billed to insurance. Estimates are required for self-pay or uninsured clients, or when a client asks
            for one.
          </Alert>
        </div>
      )}
      {estimates.isLoading && <SectionSpinner />}
      {estimates.isError && <ErrorState error={estimates.error} onRetry={() => estimates.refetch()} />}
      {estimates.isSuccess && estimates.data.length === 0 && (
        <EmptyState
          icon={<FilePlus2 />}
          title="No estimates yet"
          description="When a self-pay client schedules care, a draft is started for you with a due date."
        />
      )}
      {estimates.isSuccess && estimates.data.length > 0 && (
        <ul className="divide-y divide-sage-100" aria-label="Good faith estimates">
          {estimates.data.map((estimate) => (
            <EstimateRow
              key={estimate.id}
              estimate={estimate}
              canChange={canChangeEstimate(estimate, who)}
              timeZone={timeZone}
              onAction={setDialog}
            />
          ))}
        </ul>
      )}

      {dialog?.kind === 'form' && options.data && (
        <EstimateFormModal
          key={dialog.estimate?.id ?? 'new'}
          clientId={client.id}
          options={options.data}
          today={today}
          estimate={dialog.estimate}
          onClose={close}
        />
      )}
      {dialog?.kind === 'issue' && (
        <IssueEstimateDialog estimate={dialog.estimate} missingClientFields={options.data?.missing_client_fields ?? []} onClose={close} />
      )}
      {dialog?.kind === 'supersede' && (
        <SupersedeEstimateDialog
          estimate={dialog.estimate}
          onClose={close}
          onCreated={(draft) => setDialog({ kind: 'form', estimate: draft })}
        />
      )}
      {dialog?.kind === 'void' && <VoidEstimateDialog estimate={dialog.estimate} onClose={close} />}
      {dialog?.kind === 'delete' && <DeleteEstimateDialog estimate={dialog.estimate} onClose={close} />}
    </Card>
  );
}
