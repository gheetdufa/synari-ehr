import { api } from './client';
import type { PortalAppointment } from './booking';

export interface PortalFormSummary {
  id: number;
  kind: 'intake' | 'consent' | 'assessment' | 'other';
  name: string;
  status: 'pending' | 'completed';
  requires_signature: boolean;
  sent_at: string;
  completed_at: string | null;
}

export interface PortalBillingSummary {
  balance_cents: number;
  credit_cents: number;
  payments_enabled: boolean;
  autopay_enabled: boolean;
  default_card: { id: number; brand: string; last4: string } | null;
}

/** Small read-only fetchers for the client portal's home screen. */
export const portalHomeApi = {
  upcomingAppointments: () =>
    api<PortalAppointment[]>('/portal/appointments', { realm: 'client', query: { when: 'upcoming' } }),
  forms: () => api<PortalFormSummary[]>('/portal/forms', { realm: 'client' }),
  billingSummary: () => api<PortalBillingSummary>('/portal/billing/summary', { realm: 'client' }),
  unreadMessages: () => api<{ count: number }>('/portal/messages/unread-count', { realm: 'client' }),
};

export const portalHomeKeys = {
  upcomingAppointments: ['portal', 'appointments', 'upcoming'] as const,
  forms: ['portal', 'forms', 'list'] as const,
  billingSummary: ['portal', 'billing', 'summary'] as const,
  unreadMessages: ['portal', 'messages', 'unread-count'] as const,
};
