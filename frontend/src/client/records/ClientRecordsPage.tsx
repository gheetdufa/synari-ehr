import { usePortalClient } from '../../auth/ClientAuth';
import { displayFirstName } from '../../lib/format';
import { PageHeader } from '../../ui/Display';
import { AmendmentsSection } from './AmendmentsSection';
import { DisclosuresSection } from './DisclosuresSection';
import { RecordRequestsSection } from './RecordRequestsSection';

/** /client/records — the client's privacy rights: a copy of the record, the accounting of
 * disclosures and corrections (amendments). */
export default function ClientRecordsPage() {
  const client = usePortalClient();
  const whose = client.acting_contact ? `${displayFirstName(client)}’s record` : 'your record';
  return (
    <div className="space-y-6">
      <PageHeader
        title="My records"
        description={`Ask for a copy of ${whose}, see who the practice shared it with, or ask for a correction.`}
      />
      <RecordRequestsSection timeZone={client.time_zone} />
      <DisclosuresSection />
      <AmendmentsSection timeZone={client.time_zone} />
    </div>
  );
}
