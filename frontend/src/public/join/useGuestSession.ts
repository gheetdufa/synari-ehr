import { useCallback, useEffect, useReducer, useRef } from 'react';
import { ApiError } from '../../api/client';
import { guestApi, type EnterInput } from '../../api/telehealth';
import { activeEntry, guestReducer, initialGuestState, pollDelay, type GuestState } from './guestState';

/**
 * A visit kept in sessionStorage (this tab only, gone when it closes) so a reload keeps the guest's
 * place. `leftOnUnload` marks a visit the page ended while unloading; it is checked in again with the
 * same details when the page comes back.
 */
interface StoredVisit {
  entryId: number;
  secret: string;
  input: EnterInput;
  leftOnUnload: boolean;
}

const storageKey = (token: string) => `synari.join.${token}`;

function loadVisit(token: string): StoredVisit | null {
  try {
    const raw = sessionStorage.getItem(storageKey(token));
    return raw ? (JSON.parse(raw) as StoredVisit) : null;
  } catch {
    return null;
  }
}

/** Whether this tab has a visit in progress for the link (so a reload goes straight back to it). */
export function hasStoredVisit(token: string): boolean {
  return loadVisit(token) !== null;
}

function saveVisit(token: string, visit: StoredVisit | null): void {
  try {
    if (visit) sessionStorage.setItem(storageKey(token), JSON.stringify(visit));
    else sessionStorage.removeItem(storageKey(token));
  } catch {
    // Without storage a reload starts over at the form; the visit itself still works.
  }
}

function enterErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 503) return "Video visits aren't available right now. Please contact your clinician's office.";
    if (error.status === 429) return 'Too many attempts from this network. Please wait a minute and try again.';
  }
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

export interface GuestSession {
  state: GuestState;
  /** The details given when checking in, to prefill the form after leaving. */
  lastInput: EnterInput | null;
  enter: (input: EnterInput) => void;
  leave: () => Promise<void>;
  /** Re-check the visit (for example after the call dropped) to get a fresh connection. */
  resume: () => void;
  rejoin: () => void;
}

/** The guest's side of the waiting room: check in, poll until admitted, and leave. */
export function useGuestSession(token: string): GuestSession {
  const visitRef = useRef<StoredVisit | null>(null);
  const lastInputRef = useRef<EnterInput | null>(null);
  const [state, dispatch] = useReducer(guestReducer, token, (initialToken) => {
    const visit = loadVisit(initialToken);
    visitRef.current = visit;
    lastInputRef.current = visit?.input ?? null;
    return initialGuestState(visit ? { entryId: visit.entryId, secret: visit.secret } : null);
  });
  const stateRef = useRef(state);
  stateRef.current = state;

  const checkIn = useCallback(
    async (input: EnterInput) => {
      lastInputRef.current = input;
      try {
        const result = await guestApi.enter(token, input);
        const visit: StoredVisit = { entryId: result.entry_id, secret: result.secret, input, leftOnUnload: false };
        visitRef.current = visit;
        saveVisit(token, visit);
        dispatch({ type: 'entered', entry: { entryId: visit.entryId, secret: visit.secret } });
      } catch (error) {
        dispatch({ type: 'enter_failed', error: enterErrorMessage(error) });
      }
    },
    [token],
  );

  const enter = useCallback(
    (input: EnterInput) => {
      dispatch({ type: 'enter' });
      void checkIn(input);
    },
    [checkIn],
  );

  // Poll the visit while waiting (or re-checking it). Each result schedules the next poll.
  const pollingEntry = state.phase === 'waiting' || state.phase === 'resuming' ? state.entry : null;
  const pollCount = state.phase === 'waiting' ? state.polls : -1;
  const entryId = pollingEntry?.entryId;
  const secret = pollingEntry?.secret;
  useEffect(() => {
    if (entryId === undefined || secret === undefined) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      guestApi
        .poll(entryId, secret, controller.signal)
        .then((result) => {
          const visit = visitRef.current;
          if (result.status === 'left' && visit?.leftOnUnload && visit.entryId === entryId) {
            // The page was reloaded (or restored); the unload ended the old visit. Check in again.
            visitRef.current = { ...visit, leftOnUnload: false };
            void checkIn(visit.input);
            return;
          }
          if (result.status !== 'waiting' && result.status !== 'admitted') saveVisit(token, null);
          dispatch({ type: 'poll_result', result });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          if (error instanceof ApiError && error.status === 404) {
            saveVisit(token, null);
            dispatch({ type: 'entry_gone' });
            return;
          }
          dispatch({ type: 'poll_failed' });
        });
    }, pollDelay(stateRef.current));
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [entryId, secret, pollCount, token, checkIn]);

  // Closing or leaving the page ends the visit so the clinician doesn't wait on someone who's gone.
  useEffect(() => {
    const onPageHide = () => {
      const entry = activeEntry(stateRef.current);
      if (!entry) return;
      guestApi.leaveOnUnload(entry.entryId, entry.secret);
      if (visitRef.current) {
        visitRef.current = { ...visitRef.current, leftOnUnload: true };
        saveVisit(token, visitRef.current);
      }
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted && activeEntry(stateRef.current)) dispatch({ type: 'resume' });
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [token]);

  const leave = useCallback(async () => {
    const entry = activeEntry(stateRef.current);
    dispatch({ type: 'left' });
    visitRef.current = null;
    saveVisit(token, null);
    if (entry) await guestApi.leave(entry.entryId, entry.secret).catch(() => undefined);
  }, [token]);

  const resume = useCallback(() => dispatch({ type: 'resume' }), []);
  const rejoin = useCallback(() => dispatch({ type: 'rejoin' }), []);

  return { state, lastInput: lastInputRef.current, enter, leave, resume, rejoin };
}
