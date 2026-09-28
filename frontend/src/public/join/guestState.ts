import type { EntryStatus } from '../../api/telehealth';

/** Proof of a waiting-room visit: the entry id and the secret returned when checking in. */
export interface EntryCredentials {
  entryId: number;
  secret: string;
}

export interface GuestAccess {
  serverUrl: string;
  token: string;
}

export type FinishReason = 'declined' | 'left' | 'canceled' | 'ended' | 'expired';

/**
 * Where a guest is in the join flow.
 * - form: filling in their name (and consent)
 * - entering: checking in
 * - resuming: re-checking a visit after a reload or a dropped call
 * - waiting: in the waiting room, polled every couple of seconds
 * - admitted: in the call
 * - finished: the visit is over
 */
export type GuestState =
  | { phase: 'form'; error: string | null }
  | { phase: 'entering' }
  | { phase: 'resuming'; entry: EntryCredentials }
  | { phase: 'waiting'; entry: EntryCredentials; polls: number; failures: number }
  | { phase: 'admitted'; entry: EntryCredentials; access: GuestAccess }
  | { phase: 'finished'; reason: FinishReason };

export type GuestAction =
  | { type: 'enter' }
  | { type: 'enter_failed'; error: string }
  | { type: 'entered'; entry: EntryCredentials }
  | { type: 'poll_result'; result: EntryStatus }
  | { type: 'poll_failed' }
  | { type: 'entry_gone' }
  | { type: 'left' }
  | { type: 'resume' }
  | { type: 'rejoin' };

export function initialGuestState(stored: EntryCredentials | null): GuestState {
  return stored ? { phase: 'resuming', entry: stored } : { phase: 'form', error: null };
}

/** The visit in progress, if any. */
export function activeEntry(state: GuestState): EntryCredentials | null {
  return state.phase === 'resuming' || state.phase === 'waiting' || state.phase === 'admitted' ? state.entry : null;
}

const BASE_POLL_MS = 2_000;
const MAX_POLL_MS = 15_000;

/** How long to wait before the next poll: every 2 seconds, backing off while the server is unreachable. */
export function pollDelay(state: GuestState): number {
  if (state.phase === 'resuming') return 0;
  if (state.phase !== 'waiting') return BASE_POLL_MS;
  if (state.polls === 0) return 0;
  return Math.min(BASE_POLL_MS * 2 ** state.failures, MAX_POLL_MS);
}

function afterPoll(state: GuestState & { entry: EntryCredentials }, result: EntryStatus): GuestState {
  switch (result.status) {
    case 'waiting':
      return { phase: 'waiting', entry: state.entry, polls: state.phase === 'waiting' ? state.polls + 1 : 1, failures: 0 };
    case 'admitted':
      if (result.livekit_url && result.token) {
        return { phase: 'admitted', entry: state.entry, access: { serverUrl: result.livekit_url, token: result.token } };
      }
      return { phase: 'waiting', entry: state.entry, polls: state.phase === 'waiting' ? state.polls + 1 : 1, failures: 0 };
    case 'declined':
    case 'left':
    case 'canceled':
    case 'ended':
      return { phase: 'finished', reason: result.status };
  }
}

export function guestReducer(state: GuestState, action: GuestAction): GuestState {
  switch (action.type) {
    case 'enter':
      return state.phase === 'form' ? { phase: 'entering' } : state;
    case 'enter_failed':
      return state.phase === 'entering' || state.phase === 'resuming' ? { phase: 'form', error: action.error } : state;
    case 'entered':
      return state.phase === 'entering' || state.phase === 'resuming' || state.phase === 'waiting'
        ? { phase: 'waiting', entry: action.entry, polls: 0, failures: 0 }
        : state;
    case 'poll_result':
      return state.phase === 'waiting' || state.phase === 'resuming' ? afterPoll(state, action.result) : state;
    case 'poll_failed':
      if (state.phase === 'resuming') return { phase: 'waiting', entry: state.entry, polls: 1, failures: 1 };
      if (state.phase === 'waiting') return { ...state, polls: state.polls + 1, failures: state.failures + 1 };
      return state;
    case 'entry_gone':
      return activeEntry(state) ? { phase: 'finished', reason: 'expired' } : state;
    case 'left':
      return activeEntry(state) ? { phase: 'finished', reason: 'left' } : state;
    case 'resume': {
      const entry = activeEntry(state);
      return entry ? { phase: 'resuming', entry } : state;
    }
    case 'rejoin':
      return state.phase === 'finished' ? { phase: 'form', error: null } : state;
  }
}
