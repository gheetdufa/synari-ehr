import { api, downloadFile } from './client';

/** Where a released copy of the record goes. */
export type RecordDelivery = 'portal' | 'third_party';
export type RecordRequestStatus = 'open' | 'fulfilled' | 'denied';
export type AmendmentStatus = 'open' | 'accepted' | 'denied';

/** The client's request for a copy of their record (right of access). */
export interface PortalRecordRequest {
  id: number;
  received_at: string;
  /** The practice's deadline (a plain date): 30 days, or 60 after one extension. */
  due_on: string;
  extended_on: string | null;
  extension_reason: string;
  scope: string;
  delivery: RecordDelivery;
  /** Who to send it to (name and address) for third-party delivery. */
  recipient: string;
  status: RecordRequestStatus;
  fulfilled_at: string | null;
  denial_reason: string;
  /** Whether the released copy can be downloaded now (released and not yet expired). */
  release_available: boolean;
  release_expires_at: string | null;
}

export interface RecordRequestInput {
  scope: string;
  delivery: RecordDelivery;
  recipient?: string;
}

/** A disclosure of the client's information outside treatment, payment and operations. */
export interface PortalDisclosure {
  id: number;
  disclosed_on: string;
  recipient_name: string;
  recipient_address: string;
  description: string;
  purpose: string;
  legal_basis: string;
}

/** The accounting of disclosures over the last six years. */
export interface DisclosureAccounting {
  client_id: number;
  client_name: string;
  practice_name: string;
  period_start: string;
  period_end: string;
  generated_at: string;
  disclosures: PortalDisclosure[];
}

/** The client's request to change something in their record. */
export interface PortalAmendmentRequest {
  id: number;
  received_at: string;
  /** The practice's deadline to decide (a plain date, 60 days after the request). */
  due_on: string;
  request: string;
  status: AmendmentStatus;
  decided_at: string | null;
  denial_reason: string;
  /** The client's statement of disagreement with a denial (empty until filed). */
  disagreement: string;
  /** The practice's response to the statement of disagreement. */
  rebuttal: string;
  /** Whether a statement of disagreement can still be filed (denied, none filed yet). */
  can_disagree: boolean;
}

const CLIENT = { realm: 'client' } as const;

/** The signed-in client's record requests, accounting of disclosures and amendment requests. */
export const portalRecordsApi = {
  recordRequests: () => api<PortalRecordRequest[]>('/portal/record-requests', CLIENT),
  requestRecord: (input: RecordRequestInput) =>
    api<PortalRecordRequest>('/portal/record-requests', { ...CLIENT, method: 'POST', body: input }),
  downloadRelease: (requestId: number) =>
    downloadFile(`/portal/record-requests/${requestId}/download`, CLIENT),
  disclosures: () => api<DisclosureAccounting>('/portal/disclosures', CLIENT),
  downloadDisclosuresPdf: () => downloadFile('/portal/disclosures/report.pdf', CLIENT),
  amendmentRequests: () => api<PortalAmendmentRequest[]>('/portal/amendment-requests', CLIENT),
  requestAmendment: (request: string) =>
    api<PortalAmendmentRequest>('/portal/amendment-requests', { ...CLIENT, method: 'POST', body: { request } }),
  disagree: (amendmentId: number, statement: string) =>
    api<PortalAmendmentRequest>(`/portal/amendment-requests/${amendmentId}/disagreement`, {
      ...CLIENT,
      method: 'POST',
      body: { statement },
    }),
};

export const portalRecordKeys = {
  all: ['portal', 'records'] as const,
  requests: ['portal', 'records', 'requests'] as const,
  disclosures: ['portal', 'records', 'disclosures'] as const,
  amendments: ['portal', 'records', 'amendments'] as const,
};
