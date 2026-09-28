import type { PortalClient } from '../api/auth';
import { displayFirstName } from '../lib/format';

/** First name of whoever signed in: the guardian or contact acting for the client, or the client. */
export function viewerFirstName(client: PortalClient): string {
  if (client.acting_contact) return client.acting_contact.name.split(' ')[0];
  return displayFirstName(client);
}

/** "Signed in as Pat Rivera for Alex" when a contact signed in; null when the client did. */
export function actingContactNotice(client: PortalClient): string | null {
  if (!client.acting_contact) return null;
  return `Signed in as ${client.acting_contact.name} for ${displayFirstName(client)}`;
}
