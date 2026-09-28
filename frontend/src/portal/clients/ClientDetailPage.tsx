import { useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router-dom';
import { UserX } from 'lucide-react';
import { ApiError } from '../../api/client';
import { clientKeys, clientsApi } from '../../api/clients';
import { useSession } from '../../auth/StaffAuth';
import { LinkButton } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { EmptyState, ErrorState, Tabs } from '../../ui/Display';
import { SectionSpinner } from '../../ui/Spinner';
import ClientBillingTab from '../billing/ClientBillingTab';
import ClientDocumentsTab from '../forms/ClientDocumentsTab';
import ClientEstimatesTab from '../estimates/ClientEstimatesTab';
import ClientNotesTab from '../notes/ClientNotesTab';
import ClientPrivacyTab from '../records/ClientPrivacyTab';
import ClientAccessHistoryTab from './ClientAccessHistoryTab';
import ClientAppointmentsTab from './ClientAppointmentsTab';
import { ClientHeader } from './ClientHeader';
import { CLIENT_TABS, clientTabFrom, type ClientTab } from './clientHelpers';
import { clientPermissions, type ClientPermissions } from './clientPermissions';
import ClientOverviewTab from './ClientOverviewTab';
import { ChartUnavailable, ClinicalAccessNotice, EmergencyAccessBanner, useEmergencyGrant } from './EmergencyAccess';

const TAB_LABELS: Record<ClientTab, string> = {
  overview: 'Overview',
  appointments: 'Appointments',
  notes: 'Notes',
  documents: 'Documents',
  billing: 'Billing',
  estimates: 'Estimates',
  privacy: 'Privacy requests',
  access: 'Access history',
};

/**
 * The chart tabs this person may open: notes and privacy requests need clinical access, billing
 * needs billing access, good faith estimates need either (billing staff and the client's
 * clinicians write them), and the access history is for audit-log reviewers and the primary
 * clinician.
 */
export function visibleTabs(
  permissions: Pick<ClientPermissions, 'clinical' | 'billing' | 'accessHistory'>,
): ClientTab[] {
  const allowed: Record<ClientTab, boolean> = {
    overview: true,
    appointments: true,
    notes: permissions.clinical,
    documents: true,
    billing: permissions.billing,
    estimates: permissions.clinical || permissions.billing,
    privacy: permissions.clinical,
    access: permissions.accessHistory,
  };
  return CLIENT_TABS.filter((tab) => allowed[tab]);
}

function NotFound() {
  return (
    <Card>
      <EmptyState
        icon={<UserX />}
        title="Client not found"
        description="This client doesn't exist or isn't part of your practice."
        action={
          <LinkButton to="/portal/clients" variant="secondary" size="sm">
            Back to clients
          </LinkButton>
        }
      />
    </Card>
  );
}

/**
 * A client's chart: header with quick actions, and the tabs this role may open, synced to `?tab=`.
 * Clinicians who can't open the chart are offered emergency access.
 */
export default function ClientDetailPage() {
  const session = useSession();
  const isClinician = session.staff.is_clinician;
  const { clientId: rawId } = useParams();
  const clientId = Number(rawId);
  const validId = Number.isInteger(clientId) && clientId > 0;
  const [params, setParams] = useSearchParams();

  const client = useQuery({
    queryKey: clientKeys.detail(clientId),
    queryFn: () => clientsApi.get(clientId),
    enabled: validId,
  });
  const emergencyGrant = useEmergencyGrant(clientId, isClinician && validId);

  const selectTab = (next: ClientTab) =>
    setParams(
      (current) => {
        const updated = new URLSearchParams(current);
        if (next === 'overview') updated.delete('tab');
        else updated.set('tab', next);
        return updated;
      },
      { replace: true },
    );

  if (!validId) return <NotFound />;
  if (client.error instanceof ApiError && client.error.status === 404) {
    return isClinician ? <ChartUnavailable clientId={clientId} /> : <NotFound />;
  }
  if (client.isPending) return <SectionSpinner />;
  if (client.isError) {
    return (
      <Card>
        <ErrorState error={client.error} onRetry={() => void client.refetch()} />
      </Card>
    );
  }

  const record = client.data;
  const tabs = visibleTabs(clientPermissions(session, record));
  const requested = clientTabFrom(params.get('tab'));
  const tab = tabs.includes(requested) ? requested : 'overview';
  return (
    <div>
      {emergencyGrant && <EmergencyAccessBanner grant={emergencyGrant} />}
      <ClientHeader client={record} emergencyAccess={Boolean(emergencyGrant)} />
      {isClinician && !record.access.clinical && !emergencyGrant && <ClinicalAccessNotice clientId={record.id} />}
      <div className="mb-6">
        <Tabs tabs={tabs.map((id) => ({ id, label: TAB_LABELS[id] }))} active={tab} onChange={selectTab} />
      </div>
      <div role="tabpanel" aria-label={TAB_LABELS[tab]}>
        {tab === 'overview' && <ClientOverviewTab client={record} />}
        {tab === 'appointments' && <ClientAppointmentsTab clientId={record.id} />}
        {tab === 'notes' && <ClientNotesTab clientId={record.id} />}
        {tab === 'documents' && <ClientDocumentsTab clientId={record.id} />}
        {tab === 'billing' && <ClientBillingTab clientId={record.id} />}
        {tab === 'estimates' && <ClientEstimatesTab client={record} />}
        {tab === 'privacy' && <ClientPrivacyTab clientId={record.id} />}
        {tab === 'access' && <ClientAccessHistoryTab clientId={record.id} />}
      </div>
    </div>
  );
}
