import type { ClientDetail } from '../../api/clients';
import { BillingSection } from './BillingSection';
import { CareTeamSection } from './CareTeamSection';
import { ClinicalSection } from './ClinicalSection';
import { CommunicationSection } from './CommunicationSection';
import { ContactsSection } from './ContactsSection';
import { InsuranceSection } from './InsuranceSection';
import { ContactSection, PersonalSection } from './PersonalSections';
import { StatusSection } from './StatusSection';

/**
 * The chart's overview: demographic, contact, clinical, billing and portal details. Each section
 * is editable in place by the roles allowed to change it.
 */
export default function ClientOverviewTab({ client }: { client: ClientDetail }) {
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <div className="space-y-6">
        <PersonalSection client={client} />
        <ContactSection client={client} />
        <ContactsSection client={client} />
        <ClinicalSection client={client} />
      </div>
      <div className="space-y-6">
        <CareTeamSection client={client} />
        <BillingSection client={client} />
        <InsuranceSection client={client} />
        <CommunicationSection client={client} />
        <StatusSection key={client.status} client={client} />
      </div>
    </div>
  );
}
