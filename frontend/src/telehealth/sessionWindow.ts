/** Time rules for video sessions. These mirror the API (backend/synari/api/telehealth.py). */

const MINUTE_MS = 60_000;

/** The host can start a session from 60 minutes before it begins... */
export const HOST_OPENS_BEFORE_MS = 60 * MINUTE_MS;
/** ...until 60 minutes after it ends. */
export const HOST_CLOSES_AFTER_MS = 60 * MINUTE_MS;

export type HostWindowState = 'too_early' | 'open' | 'closed';

export interface HostWindow {
  state: HostWindowState;
  opensAt: Date;
  closesAt: Date;
}

/** Whether the host can start the session for an appointment at `now`. */
export function hostJoinWindow(startsAt: string, endsAt: string, now: number = Date.now()): HostWindow {
  const opensAt = new Date(new Date(startsAt).getTime() - HOST_OPENS_BEFORE_MS);
  const closesAt = new Date(new Date(endsAt).getTime() + HOST_CLOSES_AFTER_MS);
  let state: HostWindowState = 'open';
  if (now < opensAt.getTime()) state = 'too_early';
  else if (now > closesAt.getTime()) state = 'closed';
  return { state, opensAt, closesAt };
}

/** A running clock: "0:07", "12:03", "1:02:03". */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  return `${minutes}:${ss}`;
}

/** How long someone has been waiting: "Just arrived", "Waiting 4 min", "Waiting 1 hr 5 min". */
export function waitingLabel(sinceIso: string, now: number = Date.now()): string {
  const minutes = Math.floor((now - new Date(sinceIso).getTime()) / MINUTE_MS);
  if (minutes < 1) return 'Just arrived';
  if (minutes < 60) return `Waiting ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `Waiting ${hours} hr` : `Waiting ${hours} hr ${rest} min`;
}
