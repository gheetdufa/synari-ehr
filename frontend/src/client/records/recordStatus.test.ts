import { describe, expect, it } from 'vitest';
import type { PortalAmendmentRequest, PortalRecordRequest } from '../../api/portalRecords';
import { amendmentStatus, recordRequestStatus } from './recordStatus';

const ZONE = 'America/Chicago';

function request(changes: Partial<PortalRecordRequest>): PortalRecordRequest {
  return {
    id: 1,
    received_at: '2026-09-01T15:00:00Z',
    due_on: '2026-10-01',
    extended_on: null,
    extension_reason: '',
    scope: 'Everything',
    delivery: 'portal',
    recipient: '',
    status: 'open',
    fulfilled_at: null,
    denial_reason: '',
    release_available: false,
    release_expires_at: null,
    ...changes,
  };
}

function amendment(changes: Partial<PortalAmendmentRequest>): PortalAmendmentRequest {
  return {
    id: 1,
    received_at: '2026-09-01T15:00:00Z',
    due_on: '2026-10-31',
    request: 'Fix it',
    status: 'open',
    decided_at: null,
    denial_reason: '',
    disagreement: '',
    rebuttal: '',
    can_disagree: false,
    ...changes,
  };
}

describe('recordRequestStatus', () => {
  it.each([
    [request({}), 'In progress', 'info'],
    [request({ extended_on: '2026-09-25', due_on: '2026-10-31' }), 'Extended', 'warning'],
    [request({ status: 'fulfilled', release_available: true, release_expires_at: '2026-10-10T15:00:00Z' }), 'Ready to download', 'success'],
    [request({ status: 'fulfilled', release_expires_at: '2026-07-10T15:00:00Z' }), 'Expired', 'neutral'],
    [request({ status: 'fulfilled', delivery: 'third_party', fulfilled_at: '2026-09-10T15:00:00Z' }), 'Sent', 'success'],
    [request({ status: 'denied' }), 'Denied', 'danger'],
  ])('labels %#', (value, label, tone) => {
    const status = recordRequestStatus(value, ZONE);
    expect(status.label).toBe(label);
    expect(status.tone).toBe(tone);
  });

  it('shows the new deadline and reason for an extension', () => {
    const status = recordRequestStatus(
      request({ extended_on: '2026-09-25', due_on: '2026-10-31', extension_reason: 'Waiting on archives' }),
      ZONE,
    );
    expect(status.detail).toBe('The practice needs more time and will respond by Oct 31, 2026. Reason: Waiting on archives');
  });

  it('shows a denial reason when given, and a plain sentence otherwise', () => {
    expect(recordRequestStatus(request({ status: 'denied', denial_reason: 'Duplicate' }), ZONE).detail).toBe('Reason: Duplicate');
    expect(recordRequestStatus(request({ status: 'denied' }), ZONE).detail).toBe('The practice denied this request.');
  });
});

describe('amendmentStatus', () => {
  it.each([
    [amendment({}), 'Under review'],
    [amendment({ status: 'accepted', decided_at: '2026-09-10T15:00:00Z' }), 'Accepted'],
    [amendment({ status: 'denied', denial_reason: 'Accurate' }), 'Denied'],
  ])('labels %#', (value, label) => {
    expect(amendmentStatus(value, ZONE).label).toBe(label);
  });

  it('shows the decision deadline while under review', () => {
    expect(amendmentStatus(amendment({}), ZONE).detail).toBe('The practice will decide by Oct 31, 2026.');
  });
});
