/**
 * Where conversations open. Notifications and emails from the API link to the same URLs
 * (`?conversation=ID`), so keep these in step with services/messaging.py.
 */

/** The staff messages page with one conversation open. */
export function staffConversationPath(conversationId: number): string {
  return `/portal/messaging?conversation=${conversationId}`;
}

/**
 * The staff messages page opening your own conversation with a client (created on arrival if
 * needed). Other screens' "Message" buttons link here.
 */
export function staffClientMessagesPath(clientId: number): string {
  return `/portal/messaging?client=${clientId}`;
}

/** The client portal's messages page with one conversation open. */
export function portalConversationPath(conversationId: number): string {
  return `/client/messages?conversation=${conversationId}`;
}

/** The client portal's messages page open on a clinician they haven't written to yet. */
export function portalClinicianPath(clinicianId: number): string {
  return `/client/messages?clinician=${clinicianId}`;
}

/** A positive integer id from a URL search parameter, or null when missing or malformed. */
export function parseIdParam(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
