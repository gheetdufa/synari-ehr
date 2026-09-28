import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import {
  clientKeys,
  clientsApi,
  type ClientDetail,
  type InsurancePolicy,
  type InsurancePolicyFields,
  type SubscriberRelationship,
} from '../../api/clients';
import { formatMoney, formatPlainDate } from '../../lib/format';
import { Button, IconButton } from '../../ui/Button';
import { Card, CardBody, CardHeader } from '../../ui/Card';
import { Badge, EmptyState, ErrorState } from '../../ui/Display';
import { ConfirmDialog } from '../../ui/Modal';
import { SectionSpinner } from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import { PolicyInsuranceActions } from '../insurance/policy/PolicyInsuranceActions';
import { useClientPermissions } from './clientPermissions';
import { NotAvailable } from './EditableSection';
import { fieldErrors } from './formUtils';
import { InsurancePolicyModal, RANK_LABELS, SELF, SEX_LABELS } from './InsurancePolicyModal';

type Editing = { policy: InsurancePolicy | null } | null;

/** How the client relates to someone else who holds the policy. */
const CLIENT_RELATION: Record<Exclude<SubscriberRelationship, typeof SELF>, string> = {
  '01': 'client is their spouse',
  '53': 'client is their life partner',
  '19': 'client is their child',
  '20': 'client is their employee',
  G8: 'other relationship',
  '21': 'relationship unknown',
};

/**
 * "Pat Rivera · Female · born Jan 1, 1980 · client is their child", or "Client" when the client
 * is the subscriber.
 */
export function subscriberSummary(policy: InsurancePolicy): string {
  if (policy.subscriber_relationship === SELF) return 'Client';
  return [
    [policy.subscriber_first_name, policy.subscriber_last_name].filter(Boolean).join(' '),
    policy.subscriber_sex ? SEX_LABELS[policy.subscriber_sex] : '',
    policy.subscriber_dob ? `born ${formatPlainDate(policy.subscriber_dob)}` : '',
    CLIENT_RELATION[policy.subscriber_relationship],
  ]
    .filter(Boolean)
    .join(' · ');
}

/** "Jan 1, 2026 – Dec 31, 2026", "From Jan 1, 2026", "Until ..." or blank. */
export function coverageDates(policy: Pick<InsurancePolicy, 'effective_date' | 'termination_date'>): string {
  const { effective_date: start, termination_date: end } = policy;
  if (start && end) return `${formatPlainDate(start)} – ${formatPlainDate(end)}`;
  if (start) return `From ${formatPlainDate(start)}`;
  if (end) return `Until ${formatPlainDate(end)}`;
  return '';
}

function PolicyCard({
  policy,
  onEdit,
  onDelete,
}: {
  policy: InsurancePolicy;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const details = [
    ['Member ID', policy.member_id],
    ['Group', policy.group_number],
    ['Plan', policy.plan_name],
    ['Payer ID', policy.payer.external_id],
    ['Coverage', coverageDates(policy)],
    ['Copay', policy.copay_cents !== null ? formatMoney(policy.copay_cents) : ''],
    ['Coinsurance', policy.coinsurance_percent !== null ? `${policy.coinsurance_percent}%` : ''],
    ['Claim filing', policy.claim_filing_indicator],
    ['Subscriber', subscriberSummary(policy)],
  ].filter(([, value]) => value);

  return (
    <li className="px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-sage-900">{policy.payer.name}</p>
            <Badge tone={policy.rank === 'primary' ? 'primary' : 'neutral'}>{RANK_LABELS[policy.rank]}</Badge>
          </div>
          <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {details.map(([label, value]) => (
              <div key={label} className="flex gap-2">
                <dt className="text-sage-500">{label}</dt>
                <dd className="min-w-0 break-words text-sage-800">{value}</dd>
              </div>
            ))}
          </dl>
          {policy.authorizations.length > 0 && (
            <div className="mt-3">
              <h3 className="text-xs font-medium uppercase tracking-wide text-sage-500">Prior authorizations</h3>
              <ul className="mt-1 space-y-0.5 text-sm text-sage-800">
                {policy.authorizations.map((authorization) => (
                  <li key={authorization.id}>
                    <span className="font-mono text-xs">{authorization.number}</span> ·{' '}
                    {coverageDates({ effective_date: authorization.start_date, termination_date: authorization.end_date })}
                    {authorization.visits_authorized !== null && ` · ${authorization.visits_authorized} visits`}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <PolicyInsuranceActions policyId={policy.id} payerName={policy.payer.name} />
        </div>
        <div className="flex shrink-0 gap-1">
          <IconButton label={`Edit ${policy.payer.name} policy`} onClick={onEdit}>
            <Pencil className="h-4 w-4" />
          </IconButton>
          <IconButton label={`Delete ${policy.payer.name} policy`} onClick={onDelete} className="hover:text-red-700">
            <Trash2 className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
    </li>
  );
}

function Policies({ client }: { client: ClientDetail }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const policies = useQuery({
    queryKey: clientKeys.insurance(client.id),
    queryFn: () => clientsApi.insurance.list(client.id),
  });
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<InsurancePolicy | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: clientKeys.insurance(client.id) });

  const save = useMutation({
    mutationFn: ({ policy, input }: { policy: InsurancePolicy | null; input: InsurancePolicyFields }) =>
      policy
        ? clientsApi.insurance.update(client.id, policy.id, input)
        : clientsApi.insurance.create(client.id, input),
    onSuccess: (_, { policy }) => {
      void refresh();
      toast.success(policy ? 'Insurance policy updated' : 'Insurance policy added');
      setEditing(null);
    },
    onError: (error) => {
      const found = fieldErrors(error);
      if (Object.keys(found).length > 0) setServerErrors(found);
      else setFormError(error.message);
    },
  });

  const remove = useMutation({
    mutationFn: (policy: InsurancePolicy) => clientsApi.insurance.remove(client.id, policy.id),
    onSuccess: () => {
      void refresh();
      toast.success('Insurance policy removed');
      setDeleting(null);
    },
    onError: (error) => {
      toast.error(error);
      setDeleting(null);
    },
  });

  const open = (policy: InsurancePolicy | null) => {
    setServerErrors({});
    setFormError(null);
    setEditing({ policy });
  };

  const list = policies.data ?? [];
  const hasPrimary = list.some((policy) => policy.rank === 'primary');

  return (
    <Card>
      <CardHeader
        title="Insurance"
        description={client.billing_type === 'self_pay' ? 'This client is self-pay; policies are kept for reference.' : undefined}
        actions={
          <Button variant="ghost" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => open(null)}>
            Add policy
          </Button>
        }
      />
      {policies.isPending && <SectionSpinner />}
      {policies.isError && <ErrorState error={policies.error} onRetry={() => void policies.refetch()} />}
      {policies.data && list.length === 0 && (
        <EmptyState
          icon={<ShieldCheck />}
          title="No insurance on file"
          description="Add a policy to bill insurance and include it on superbills."
        />
      )}
      {list.length > 0 && (
        <ul className="divide-y divide-sage-100">
          {list.map((policy) => (
            <PolicyCard key={policy.id} policy={policy} onEdit={() => open(policy)} onDelete={() => setDeleting(policy)} />
          ))}
        </ul>
      )}

      {editing && (
        <InsurancePolicyModal
          policy={editing.policy}
          defaultRank={hasPrimary ? 'secondary' : 'primary'}
          saving={save.isPending}
          serverErrors={serverErrors}
          formError={formError}
          onClose={() => setEditing(null)}
          onSave={(input) => {
            setServerErrors({});
            setFormError(null);
            save.mutate({ policy: editing.policy, input });
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete insurance policy?"
        danger
        confirmLabel="Delete policy"
        loading={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting)}
        message={
          deleting && (
            <p>
              Remove the {RANK_LABELS[deleting.rank].toLowerCase()} policy with <strong>{deleting.payer.name}</strong>?
              Its prior authorizations are removed too. Superbills already created keep their details.
            </p>
          )
        }
      />
    </Card>
  );
}

/** A client's insurance policies (billing access); others see that it's outside their role. */
export function InsuranceSection({ client }: { client: ClientDetail }) {
  const { billing } = useClientPermissions(client);
  if (billing) return <Policies client={client} />;
  return (
    <Card>
      <CardHeader title="Insurance" />
      <CardBody>
        <NotAvailable />
      </CardBody>
    </Card>
  );
}
