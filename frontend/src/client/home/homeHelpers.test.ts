import { describe, expect, it } from 'vitest';
import type { PortalAppointment } from '../../api/booking';
import type { PortalFormSummary } from '../../api/portalHome';
import { canJoinVideo, nextAppointment, pendingFormCount } from './homeHelpers';

function appointment(overrides: Partial<PortalAppointment>): PortalAppointment {
  return {
    id: 1,
    starts_at: '2026-09-25T15:00:00Z',
    ends_at: '2026-09-25T15:50:00Z',
    status: 'scheduled',
    location_type: 'video',
    location_details: '',
    has_video: true,
    clinician_name: 'Dana Lee, LCSW',
    service_description: 'Psychotherapy',
    is_group: false,
    other_participants: [],
    can_cancel: true,
    cancel_is_late: false,
    ...overrides,
  };
}

describe('canJoinVideo', () => {
  const visit = appointment({});
  it.each([
    ['2026-09-25T13:59:00Z', false],
    ['2026-09-25T14:00:00Z', true],
    ['2026-09-25T16:20:00Z', true],
    ['2026-09-25T16:21:00Z', false],
  ])('at %s -> %s', (iso, expected) => {
    expect(canJoinVideo(visit, new Date(iso))).toBe(expected);
  });

  it('is never offered for requests or in-person visits', () => {
    const now = new Date('2026-09-25T15:00:00Z');
    expect(canJoinVideo(appointment({ status: 'requested' }), now)).toBe(false);
    expect(canJoinVideo(appointment({ has_video: false, location_type: 'in_person' }), now)).toBe(false);
  });
});

describe('nextAppointment', () => {
  it('prefers the soonest confirmed appointment over an earlier request', () => {
    const request = appointment({ id: 1, status: 'requested', starts_at: '2026-09-26T15:00:00Z' });
    const later = appointment({ id: 2, starts_at: '2026-10-02T15:00:00Z' });
    const sooner = appointment({ id: 3, starts_at: '2026-09-28T15:00:00Z' });
    expect(nextAppointment([request, later, sooner])?.id).toBe(3);
    expect(nextAppointment([request])?.id).toBe(1);
    expect(nextAppointment([])).toBeNull();
  });
});

describe('pendingFormCount', () => {
  it('counts forms still to complete', () => {
    const form = (status: PortalFormSummary['status']): PortalFormSummary => ({
      id: 1,
      kind: 'intake',
      name: 'Intake',
      status,
      requires_signature: false,
      sent_at: '2026-09-01T00:00:00Z',
      completed_at: null,
    });
    expect(pendingFormCount([form('pending'), form('completed'), form('pending')])).toBe(2);
  });
});
