import { DisclosuresSection } from './DisclosuresSection';
import { AmendmentList, RecordRequestList } from './RequestLists';

/**
 * The client's privacy requests on their chart: copies of the record, amendments and the
 * disclosure log with its accounting report. Needs clinical access to the client.
 */
export default function ClientPrivacyTab({ clientId }: { clientId: number }) {
  return (
    <div className="space-y-6">
      <RecordRequestList clientId={clientId} />
      <AmendmentList clientId={clientId} />
      <DisclosuresSection clientId={clientId} />
    </div>
  );
}
