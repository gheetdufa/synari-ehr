import type { ClientDetail } from '../../api/clients';
import type { PracticeSettings } from '../../api/practice';

export interface MessagingBlocker {
  /** The same reason the API gives when it refuses a message. */
  reason: string;
  /** Where it can be fixed: practice settings or the client's chart. */
  fixIn: 'settings' | 'chart';
}

const PRACTICE_OFF: MessagingBlocker = { reason: 'Secure messaging is turned off for this practice', fixIn: 'settings' };
const NO_PORTAL: MessagingBlocker = { reason: "This client doesn't have client portal access", fixIn: 'chart' };
const CLIENT_OFF: MessagingBlocker = { reason: 'Secure messaging is turned off for this client', fixIn: 'chart' };

/**
 * Why a client can't receive secure messages right now, or null if they can. Mirrors the API's
 * check so the composer can explain the problem before a send is refused.
 */
export function messagingBlocker(client: ClientDetail, practice: PracticeSettings | undefined): MessagingBlocker | null {
  if (practice && !practice.messaging_enabled) return PRACTICE_OFF;
  const portalStatusAllowed = client.status === 'active' || client.status === 'prospective';
  if (!client.portal_enabled || !portalStatusAllowed) return NO_PORTAL;
  if (!client.portal_messaging) return CLIENT_OFF;
  return null;
}

/** The blocker behind a 409 refusal message, or null when the conflict is about something else. */
export function blockerFromReason(reason: string): MessagingBlocker | null {
  return [PRACTICE_OFF, NO_PORTAL, CLIENT_OFF].find((blocker) => blocker.reason === reason) ?? null;
}
