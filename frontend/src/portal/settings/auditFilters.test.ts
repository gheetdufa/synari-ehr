import { describe, expect, it } from 'vitest';
import { humanizeAction } from './auditActions';
import { ACTION_CATEGORIES, EMPTY_AUDIT_FILTERS, auditFiltersFrom, dateRangeProblem, dayStartIso, hasFilters, shortHash } from './auditFilters';

describe('audit log filters', () => {
  it('turns local days into UTC instants, with the end day inclusive', () => {
    expect(dayStartIso('2026-03-10', 'America/New_York')).toBe('2026-03-10T04:00:00.000Z');
    expect(dayStartIso('2026-03-10', 'America/New_York', 1)).toBe('2026-03-11T04:00:00.000Z');
    // The day clocks spring forward still starts at local midnight.
    expect(dayStartIso('2026-03-08', 'America/New_York')).toBe('2026-03-08T05:00:00.000Z');
    expect(dayStartIso('2026-12-31', 'Asia/Tokyo', 1)).toBe('2026-12-31T15:00:00.000Z');
  });

  it('builds API filters from the form', () => {
    expect(auditFiltersFrom(EMPTY_AUDIT_FILTERS, 'UTC')).toEqual({});
    expect(
      auditFiltersFrom(
        { clientId: 7, actorId: 2, action: 'note.', fromDay: '2026-09-01', toDay: '2026-09-30' },
        'America/Chicago',
      ),
    ).toEqual({
      client_id: 7,
      actor_id: 2,
      action: 'note.',
      from: '2026-09-01T05:00:00.000Z',
      to: '2026-10-01T05:00:00.000Z',
    });
  });

  it('leaves out a reversed date range and explains why', () => {
    const form = { ...EMPTY_AUDIT_FILTERS, fromDay: '2026-09-10', toDay: '2026-09-01' };
    expect(dateRangeProblem(form)).toBe('The start date is after the end date');
    expect(auditFiltersFrom(form, 'UTC')).toEqual({});
    expect(dateRangeProblem({ fromDay: '2026-09-01', toDay: '2026-09-01' })).toBeNull();
  });

  it('knows when anything is filtered and shortens hashes', () => {
    expect(hasFilters(EMPTY_AUDIT_FILTERS)).toBe(false);
    expect(hasFilters({ ...EMPTY_AUDIT_FILTERS, action: 'auth.' })).toBe(true);
    expect(shortHash('a'.repeat(64))).toBe('aaaaaaaaaaaa');
    expect(shortHash(null)).toBe('');
  });

  it.each([
    ['audit_log.export', 'Exported the activity log'],
    ['client.access_history_view', "Viewed a client's access history"],
    ['record_request.fulfill', 'Fulfilled a request for records'],
    ['amendment.disagreement', 'Filed a statement of disagreement'],
    ['note.addendum_create', 'Added an addendum to a note'],
    ['estimate.request', 'Requested a good faith estimate'],
    ['estimate.acknowledge', 'Acknowledged a good faith estimate'],
    ['estimate.needed_list', 'Viewed clients who need a good faith estimate'],
    ['invoice.auto_create', 'Created an invoice automatically'],
    ['invoice.dispute', 'Marked an invoice as disputed'],
    ['payment.card_failed', 'A card payment failed'],
    ['claim.submit', 'Submitted a claim'],
    ['eligibility.list', 'Viewed eligibility checks'],
  ])('labels the new action %s', (action, label) => {
    expect(humanizeAction(action)).toBe(label);
  });

  it('offers each kind of activity once, including estimates, imports and security', () => {
    const prefixes = ACTION_CATEGORIES.map((category) => category.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(new Set(ACTION_CATEGORIES.map((category) => category.label)).size).toBe(prefixes.length);
    expect(prefixes).toEqual(
      expect.arrayContaining([
        'estimate.',
        'invoice.',
        'payment.',
        'superbill.',
        'billing.',
        'import.',
        'client.emergency_access',
        'emergency_access.',
        'security_event.',
        'practice.security_update',
        'team.mfa_reset',
        'team.sessions_revoked',
        'auth.',
        'calendar_sync.',
        'record_request.',
        'amendment.',
        'disclosure.',
      ]),
    );
  });
});
