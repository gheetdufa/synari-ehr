import { useQuery } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { clientKeys, clientsApi } from '../../api/clients';
import { useSession } from '../../auth/StaffAuth';
import { Card, CardBody, CardHeader } from '../../ui/Card';
import { ErrorState } from '../../ui/Display';
import { SectionSpinner } from '../../ui/Spinner';
import { ClientFilesSection } from './ClientFilesSection';
import { ClientFormsSection } from './ClientFormsSection';

/** Files are part of the clinical record; staff without clinical access see why they're missing. */
function FilesUnavailable() {
  return (
    <Card>
      <CardHeader title="Files" />
      <CardBody>
        <p className="flex items-start gap-2 text-sm text-sage-600">
          <Lock aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-sage-400" />
          Documents shared with the client and files they upload are part of their clinical record, so they're visible to
          the client's care team.
        </p>
      </CardBody>
    </Card>
  );
}

/** Client chart tab: forms shared with the client, and documents shared or uploaded. */
export default function ClientDocumentsTab({ clientId }: { clientId: number }) {
  const { staff } = useSession();
  const client = useQuery({ queryKey: clientKeys.detail(clientId), queryFn: () => clientsApi.get(clientId) });

  if (client.isPending) return <SectionSpinner />;
  if (client.error) {
    return (
      <Card>
        <ErrorState error={client.error} onRetry={() => void client.refetch()} />
      </Card>
    );
  }
  return (
    <div className="space-y-6">
      <ClientFormsSection client={client.data} timeZone={staff.time_zone} />
      {client.data.access.clinical ? (
        <ClientFilesSection client={client.data} timeZone={staff.time_zone} />
      ) : (
        <FilesUnavailable />
      )}
    </div>
  );
}
