import { api } from './client';

/** Limits on the reason a clinician gives for emergency ("break-glass") access. */
export const EMERGENCY_REASON_MIN = 20;
export const EMERGENCY_REASON_MAX = 1000;
export const REVIEW_NOTE_MAX = 1000;

/** Temporary access to a chart a clinician can't normally open. */
export interface EmergencyGrant {
  id: number;
  client_id: number;
  created_at: string;
  expires_at: string;
}

/** An emergency access grant as owners review it. */
export interface EmergencyGrantReview {
  id: number;
  staff_id: number;
  staff_name: string;
  client_id: number;
  client_name: string;
  reason: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  reviewed_at: string | null;
  reviewed_by_name: string;
  review_note: string;
  /** Still open: not expired and not ended. */
  active: boolean;
}

/**
 * Emergency access: a clinician opens a chart outside their caseload for a few hours, with a
 * reason; owners and the client's clinician are notified and owners review every use.
 */
export const emergencyAccessApi = {
  request: (clientId: number, reason: string) =>
    api<EmergencyGrant>(`/clients/${clientId}/emergency-access`, { body: { reason } }),
  /** Your grants that are still active. */
  mine: () => api<EmergencyGrant[]>('/me/emergency-access'),
  reviews: (pendingOnly: boolean) =>
    api<EmergencyGrantReview[]>('/practice/emergency-access', { query: { pending_only: pendingOnly } }),
  markReviewed: (grantId: number, note: string) =>
    api<EmergencyGrantReview>(`/practice/emergency-access/${grantId}/review`, { body: { note } }),
  /** End a grant now. */
  revoke: (grantId: number) =>
    api<EmergencyGrantReview>(`/practice/emergency-access/${grantId}/revoke`, { method: 'POST' }),
};

export const emergencyAccessKeys = {
  mine: ['me', 'emergency-access'] as const,
  reviews: ['practice', 'emergency-access'] as const,
  reviewList: (pendingOnly: boolean) => ['practice', 'emergency-access', { pendingOnly }] as const,
};

/** Your active grant for a client, if any. */
export function activeGrantFor(
  grants: EmergencyGrant[] | undefined,
  clientId: number,
  now = Date.now(),
): EmergencyGrant | undefined {
  return grants?.find((grant) => grant.client_id === clientId && new Date(grant.expires_at).getTime() > now);
}
