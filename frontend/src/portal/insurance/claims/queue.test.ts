import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../api/client';
import { claimSummary, sessionFixture } from '../insurance.fixture';
import { createClaimsFor, groupByClient, selectionWarnings, serviceDates, sessionWarnings } from './queue';

describe('ready-to-file queue', () => {
  it('flags unsigned notes, missing diagnoses and eligibility problems', () => {
    expect(sessionWarnings(sessionFixture())).toEqual([]);
    expect(
      sessionWarnings(sessionFixture({ note_signed: false, has_diagnoses: false, eligibility_status: 'inactive' })).map(
        (warning) => warning.label,
      ),
    ).toEqual(['Note not signed', 'No diagnosis', 'Coverage inactive']);
    expect(sessionWarnings(sessionFixture({ eligibility_status: 'review' }))[0].label).toBe('Eligibility needs review');
    expect(sessionWarnings(sessionFixture({ eligibility_status: null }))).toEqual([]);
  });

  it('summarizes what needs attention in a selection', () => {
    expect(
      selectionWarnings([
        sessionFixture({ note_signed: false }),
        sessionFixture({ participant_id: 8, note_signed: false, has_diagnoses: false }),
      ]),
    ).toEqual([
      '2 sessions have no signed note.',
      '1 session is for a client without a diagnosis; add one before submitting.',
    ]);
  });

  it('groups sessions by client in the order they come', () => {
    const groups = groupByClient([
      sessionFixture({ client_id: 9, client_name: 'Sam Okafor', participant_id: 1 }),
      sessionFixture({ participant_id: 2 }),
      sessionFixture({ participant_id: 3, payer_name: 'Cascade Mutual' }),
    ]);
    expect(groups.map((group) => [group.clientName, group.sessions.length, group.payerNames])).toEqual([
      ['Sam Okafor', 1, ['Evergreen Health Plan']],
      ['Alex Rivera', 2, ['Evergreen Health Plan', 'Cascade Mutual']],
    ]);
  });

  it('creates claims one client at a time and reports failures', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce([claimSummary({ id: 1 }), claimSummary({ id: 2 })])
      .mockRejectedValueOnce(new ApiError(409, 'The session on 09/03/2026 is already on a claim.'));
    const result = await createClaimsFor(
      [
        sessionFixture({ participant_id: 1 }),
        sessionFixture({ participant_id: 2 }),
        sessionFixture({ participant_id: 3, client_id: 9, client_name: 'Sam Okafor' }),
      ],
      create,
    );
    expect(create.mock.calls).toEqual([[[1, 2]], [[3]]]);
    expect(result.created.map((claim) => claim.id)).toEqual([1, 2]);
    expect(result.failures).toEqual([
      { clientName: 'Sam Okafor', message: 'The session on 09/03/2026 is already on a claim.' },
    ]);
  });

  it('shows a claim’s dates of service', () => {
    expect(serviceDates({ first_service_date: '2026-09-03', last_service_date: '2026-09-03' })).toBe('Sep 3, 2026');
    expect(serviceDates({ first_service_date: '2026-09-03', last_service_date: '2026-09-10' })).toBe('Sep 3, 2026 – Sep 10, 2026');
    expect(serviceDates({ first_service_date: null, last_service_date: null })).toBe('');
  });
});
