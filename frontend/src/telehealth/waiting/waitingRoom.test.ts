import { describe, expect, it } from 'vitest';
import type { WaitingRoomEntry, WaitingStatus } from '../../api/telehealth';
import { participant } from '../appointment.fixture';
import { arrivalMessage, clientPresence, groupEntries, linkClientName, newArrivals } from './waitingRoom';

function entry(id: number, status: WaitingStatus, createdAt: string, name = `Person ${id}`): WaitingRoomEntry {
  return {
    id,
    display_name: name,
    status,
    recording_consent: false,
    current_location: '',
    client_id: null,
    created_at: createdAt,
    admitted_at: status === 'admitted' ? createdAt : null,
  };
}

describe('groupEntries', () => {
  it('splits by status, oldest first', () => {
    const groups = groupEntries([
      entry(3, 'waiting', '2026-10-05T14:05:00Z'),
      entry(1, 'waiting', '2026-10-05T14:01:00Z'),
      entry(2, 'admitted', '2026-10-05T14:02:00Z'),
      entry(4, 'left', '2026-10-05T14:03:00Z'),
      entry(5, 'declined', '2026-10-05T14:04:00Z'),
    ]);
    expect(groups.waiting.map((e) => e.id)).toEqual([1, 3]);
    expect(groups.admitted.map((e) => e.id)).toEqual([2]);
    expect(groups.past.map((e) => e.id)).toEqual([4, 5]);
  });
});

describe('newArrivals', () => {
  const first = [entry(1, 'waiting', '2026-10-05T14:01:00Z'), entry(2, 'admitted', '2026-10-05T14:02:00Z')];

  it('treats people already waiting on first load as not new', () => {
    const result = newArrivals(null, first);
    expect(result.arrivals).toEqual([]);
    expect([...result.seen]).toEqual([1]);
  });

  it('reports only people who started waiting since the last look', () => {
    const { seen } = newArrivals(null, first);
    const next = [...first, entry(3, 'waiting', '2026-10-05T14:03:00Z')];
    const result = newArrivals(seen, next);
    expect(result.arrivals.map((e) => e.id)).toEqual([3]);
    expect(newArrivals(result.seen, next).arrivals).toEqual([]);
  });
});

describe('arrivalMessage', () => {
  it('names one or two people and counts more', () => {
    const a = entry(1, 'waiting', '2026-10-05T14:01:00Z', 'Alex');
    const b = entry(2, 'waiting', '2026-10-05T14:01:00Z', 'Sam');
    const c = entry(3, 'waiting', '2026-10-05T14:01:00Z', 'Jo');
    expect(arrivalMessage([a])).toBe('Alex is in the waiting room');
    expect(arrivalMessage([a, b])).toBe('Alex and Sam are in the waiting room');
    expect(arrivalMessage([a, b, c])).toBe('3 people are in the waiting room');
  });
});

describe('linkClientName', () => {
  const session = { participants: [participant(7, 'Alex Rivera'), participant(8, 'Sam Lee')] };

  it("names the client whose link was used, if they're in the session", () => {
    expect(linkClientName(session, 8)).toBe('Sam Lee');
    expect(linkClientName(session, 9)).toBeNull();
    expect(linkClientName(session, null)).toBeNull();
  });
});

describe('clientPresence', () => {
  const onLink = (id: number, status: WaitingStatus, clientId: number) => ({
    ...entry(id, status, '2026-10-05T14:01:00Z'),
    client_id: clientId,
  });

  it('prefers in the session, then waiting, then not here', () => {
    const entries = [onLink(1, 'left', 7), onLink(2, 'waiting', 7), onLink(3, 'admitted', 8), onLink(4, 'waiting', 8)];
    expect(clientPresence(entries, 7)).toBe('waiting');
    expect(clientPresence(entries, 8)).toBe('admitted');
    expect(clientPresence(entries, 9)).toBe('absent');
  });
});
