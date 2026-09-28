import { describe, expect, it } from 'vitest';
import type { EntryState, EntryStatus } from '../../api/telehealth';
import { activeEntry, guestReducer, initialGuestState, pollDelay, type GuestAction, type GuestState } from './guestState';

const entry = { entryId: 7, secret: 's3cret' };

function status(value: EntryState, withToken = false): EntryStatus {
  return {
    status: value,
    livekit_url: withToken ? 'ws://localhost:7880' : null,
    token: withToken ? 'jwt' : null,
    room_name: withToken ? 'room' : null,
  };
}

function run(actions: GuestAction[], from: GuestState): GuestState {
  return actions.reduce(guestReducer, from);
}

const waiting: GuestState = { phase: 'waiting', entry, polls: 3, failures: 0 };

describe('initialGuestState', () => {
  it('resumes a stored visit after a reload', () => {
    expect(initialGuestState(entry)).toEqual({ phase: 'resuming', entry });
    expect(initialGuestState(null)).toEqual({ phase: 'form', error: null });
  });
});

describe('guestReducer', () => {
  it('checks in and waits', () => {
    const state = run([{ type: 'enter' }, { type: 'entered', entry }], { phase: 'form', error: null });
    expect(state).toEqual({ phase: 'waiting', entry, polls: 0, failures: 0 });
  });

  it('returns to the form with the error when checking in fails', () => {
    expect(run([{ type: 'enter' }, { type: 'enter_failed', error: 'Too early' }], { phase: 'form', error: null })).toEqual({
      phase: 'form',
      error: 'Too early',
    });
  });

  it('keeps waiting and counts polls', () => {
    expect(run([{ type: 'poll_result', result: status('waiting') }], waiting)).toEqual({ ...waiting, polls: 4 });
  });

  it('joins the call once admitted with a token', () => {
    expect(run([{ type: 'poll_result', result: status('admitted', true) }], waiting)).toEqual({
      phase: 'admitted',
      entry,
      access: { serverUrl: 'ws://localhost:7880', token: 'jwt' },
    });
  });

  it('keeps waiting if admitted without a token', () => {
    expect(run([{ type: 'poll_result', result: status('admitted') }], waiting).phase).toBe('waiting');
  });

  it.each(['declined', 'left', 'canceled', 'ended'] as const)('finishes when the visit is %s', (reason) => {
    expect(run([{ type: 'poll_result', result: status(reason) }], waiting)).toEqual({ phase: 'finished', reason });
  });

  it('backs off while the server is unreachable, then recovers', () => {
    const failing = run([{ type: 'poll_failed' }, { type: 'poll_failed' }], waiting);
    expect(failing).toEqual({ ...waiting, polls: 5, failures: 2 });
    expect(pollDelay(failing)).toBe(8_000);
    expect(pollDelay(run([{ type: 'poll_failed' }, { type: 'poll_failed' }, { type: 'poll_failed' }], failing))).toBe(15_000);
    const recovered = run([{ type: 'poll_result', result: status('waiting') }], failing);
    expect(pollDelay(recovered)).toBe(2_000);
  });

  it('polls right away after checking in or resuming', () => {
    expect(pollDelay({ phase: 'waiting', entry, polls: 0, failures: 0 })).toBe(0);
    expect(pollDelay({ phase: 'resuming', entry })).toBe(0);
  });

  it('ends the visit when the entry is gone or the guest leaves', () => {
    expect(run([{ type: 'entry_gone' }], waiting)).toEqual({ phase: 'finished', reason: 'expired' });
    const admitted: GuestState = { phase: 'admitted', entry, access: { serverUrl: 'wss://x', token: 't' } };
    expect(run([{ type: 'left' }], admitted)).toEqual({ phase: 'finished', reason: 'left' });
  });

  it('re-checks a dropped call and can start over after finishing', () => {
    const admitted: GuestState = { phase: 'admitted', entry, access: { serverUrl: 'wss://x', token: 't' } };
    expect(run([{ type: 'resume' }], admitted)).toEqual({ phase: 'resuming', entry });
    expect(run([{ type: 'rejoin' }], { phase: 'finished', reason: 'left' })).toEqual({ phase: 'form', error: null });
  });

  it('ignores stale poll results once the visit is over', () => {
    const finished: GuestState = { phase: 'finished', reason: 'left' };
    expect(run([{ type: 'poll_result', result: status('admitted', true) }], finished)).toBe(finished);
    expect(activeEntry(finished)).toBeNull();
  });
});
