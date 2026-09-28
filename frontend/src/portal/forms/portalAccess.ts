import type { ClientDetail } from '../../api/clients';

/**
 * Why forms can't be sent to this client, or null when they can. Mirrors the API's check
 * (an email address, portal access turned on, and an active or prospective client).
 */
export function portalAccessProblem(client: ClientDetail): string | null {
  const name = client.preferred_name || client.first_name;
  if (!client.email) return `Add an email address for ${name} so they can sign in to the client portal.`;
  if (!client.portal_enabled) return `Turn on client portal access for ${name} so they can complete forms.`;
  if (client.status !== 'active' && client.status !== 'prospective') {
    return `${name} is ${client.status}. Only active and prospective clients can use the client portal.`;
  }
  return null;
}
