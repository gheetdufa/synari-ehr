import { describe, expect, it } from 'vitest';
import type { Appointment } from '../../api/appointments';
import { testAppointment } from '../../test/appointments';
import { isInactive, statusLabel, videoJoinState } from './appointmentStyles';

const VIDEO: Appointment = testAppointment({ service_id: 1, service_description: 'Psychotherapy' });

describe('video join window', () => {
  it.each([
    ['2026-09-25T12:59:00Z', 'early'],
    ['2026-09-25T13:00:00Z', 'open'],
    ['2026-09-25T14:30:00Z', 'open'],
    ['2026-09-25T15:45:00Z', 'open'],
    ['2026-09-25T15:46:00Z', 'ended'],
  ])('at %s is %s', (now, state) => {
    expect(videoJoinState(VIDEO, new Date(now))).toBe(state);
  });

  it('is unavailable without video or once canceled', () => {
    const now = new Date('2026-09-25T14:00:00Z');
    expect(videoJoinState({ ...VIDEO, has_video: false }, now)).toBe('none');
    expect(videoJoinState({ ...VIDEO, status: 'canceled' }, now)).toBe('none');
    expect(videoJoinState({ ...VIDEO, status: 'requested' }, now)).toBe('none');
  });
});

describe('status presentation', () => {
  it('labels requests as pending and treats canceled and declined as inactive', () => {
    expect(statusLabel('requested')).toBe('Pending request');
    expect(isInactive({ status: 'declined' })).toBe(true);
    expect(isInactive({ status: 'late_canceled' })).toBe(false);
  });
});
