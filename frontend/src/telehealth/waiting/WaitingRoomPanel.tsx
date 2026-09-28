import { useState, type ReactNode } from 'react';
import { CheckCircle2, ChevronDown, LifeBuoy, MicOff, UserCheck, UserX, Users } from 'lucide-react';
import type { Appointment } from '../../api/appointments';
import type { WaitingRoomEntry } from '../../api/telehealth';
import { formatTime } from '../../lib/format';
import { ConfirmDialog } from '../../ui/Modal';
import { Spinner } from '../../ui/Spinner';
import { JoinLinkActions } from '../JoinLinkActions';
import { waitingLabel } from '../sessionWindow';
import { useNow } from '../useNow';
import type { WaitingRoom } from './useWaitingRoom';
import { linkClientName } from './waitingRoom';

function ConsentBadge({ consented }: { consented: boolean }) {
  return consented ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-primary-400/15 px-2 py-0.5 text-[11px] font-medium text-primary-200">
      <CheckCircle2 className="h-3 w-3" /> Agreed to recording
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium text-white/70">
      <MicOff className="h-3 w-3" /> No recording consent
    </span>
  );
}

function EmergencyLocation({ location }: { location: string }) {
  return (
    <p className="mt-1.5 flex items-start gap-1.5 text-xs text-white/70">
      <LifeBuoy className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
      <span>
        <span className="font-medium text-white/85">Emergency location: </span>
        {location || 'Not shared'}
      </span>
    </p>
  );
}

function EntryCard({
  entry,
  clientName,
  now,
  recordingEnabled,
  timeZone,
  children,
}: {
  entry: WaitingRoomEntry;
  /** The client whose join link they used. */
  clientName: string | null;
  now: number;
  recordingEnabled: boolean;
  timeZone: string;
  children?: ReactNode;
}) {
  const detail =
    entry.status === 'waiting'
      ? waitingLabel(entry.created_at, now)
      : entry.status === 'admitted' && entry.admitted_at
        ? `Admitted ${formatTime(entry.admitted_at, timeZone)}`
        : entry.status === 'declined'
          ? 'Declined'
          : 'Left';
  return (
    <li className="rounded-xl bg-white/5 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium text-white">{entry.display_name}</p>
          {clientName && <p className="truncate text-xs text-primary-200">{clientName}&apos;s link</p>}
          <p className="text-xs text-white/60">{detail}</p>
        </div>
        {recordingEnabled && <ConsentBadge consented={entry.recording_consent} />}
      </div>
      {entry.status !== 'left' && entry.status !== 'declined' && <EmergencyLocation location={entry.current_location} />}
      {children}
    </li>
  );
}

/**
 * Who is waiting, who is in the session, and who came and went. Admitting someone who didn't agree
 * to recording while recording is on is confirmed by the page (`onAdmit`/`onAdmitAll`).
 */
export function WaitingRoomPanel({
  appointment,
  room,
  recordingEnabled,
  timeZone,
  onAdmit,
  onAdmitAll,
}: {
  appointment: Appointment;
  room: WaitingRoom;
  recordingEnabled: boolean;
  timeZone: string;
  onAdmit: (entry: WaitingRoomEntry) => void;
  onAdmitAll: () => void;
}) {
  const now = useNow(15_000);
  const [showPast, setShowPast] = useState(false);
  const [removing, setRemoving] = useState<WaitingRoomEntry | null>(null);
  const cardProps = (entry: WaitingRoomEntry) => ({
    entry,
    clientName: linkClientName(appointment, entry.client_id),
    now,
    recordingEnabled,
    timeZone,
  });

  return (
    <div className="h-full space-y-5 overflow-y-auto p-4 text-sm">
      {room.loading ? (
        <div className="flex justify-center py-10 text-primary-300">
          <Spinner className="h-6 w-6" />
        </div>
      ) : room.error && room.entries.length === 0 ? (
        <div className="rounded-lg bg-amber-400/10 px-3 py-2 text-amber-100">
          Couldn&apos;t load the waiting room.{' '}
          <button type="button" onClick={room.refetch} className="font-medium underline">
            Try again
          </button>
        </div>
      ) : (
        <>
          <section aria-labelledby="waiting-heading">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 id="waiting-heading" className="text-xs font-semibold uppercase tracking-wide text-white/50">
                Waiting ({room.waiting.length})
              </h3>
              {room.waiting.length > 1 && (
                <button
                  type="button"
                  onClick={onAdmitAll}
                  disabled={room.admittingAll}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary-500 px-3 py-1.5 text-xs font-semibold text-[#042f2e] hover:bg-primary-400 disabled:opacity-50"
                >
                  <Users className="h-3.5 w-3.5" /> Admit all
                </button>
              )}
            </div>
            {room.waiting.length === 0 ? (
              <p className="rounded-xl border border-dashed border-white/10 px-3 py-4 text-center text-white/60">
                No one is waiting. People appear here when they open their join link.
              </p>
            ) : (
              <ul className="space-y-2">
                {room.waiting.map((entry) => {
                  const busy = room.busyIds.has(entry.id) || room.admittingAll;
                  return (
                    <EntryCard key={entry.id} {...cardProps(entry)}>
                      <div className="mt-3 flex gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => onAdmit(entry)}
                          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary-500 px-3 py-2 text-sm font-semibold text-[#042f2e] hover:bg-primary-400 disabled:opacity-50"
                        >
                          <UserCheck className="h-4 w-4" /> Admit
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => room.decline(entry.id)}
                          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-white/10 px-3 py-2 text-sm font-medium text-white hover:bg-white/20 disabled:opacity-50"
                        >
                          <UserX className="h-4 w-4" /> Decline
                        </button>
                      </div>
                    </EntryCard>
                  );
                })}
              </ul>
            )}
          </section>

          {room.admitted.length > 0 && (
            <section aria-labelledby="admitted-heading">
              <h3 id="admitted-heading" className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">
                In this session ({room.admitted.length})
              </h3>
              <ul className="space-y-2">
                {room.admitted.map((entry) => (
                  <EntryCard key={entry.id} {...cardProps(entry)}>
                    <button
                      type="button"
                      onClick={() => setRemoving(entry)}
                      disabled={room.busyIds.has(entry.id)}
                      className="mt-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-50"
                    >
                      <UserX className="h-3.5 w-3.5" /> Remove from session
                    </button>
                  </EntryCard>
                ))}
              </ul>
            </section>
          )}

          {room.past.length > 0 && (
            <section>
              <button
                type="button"
                aria-expanded={showPast}
                onClick={() => setShowPast((value) => !value)}
                className="flex w-full items-center justify-between text-xs font-semibold uppercase tracking-wide text-white/50 hover:text-white/70"
              >
                Earlier ({room.past.length})
                <ChevronDown className={`h-4 w-4 transition-transform ${showPast ? 'rotate-180' : ''}`} />
              </button>
              {showPast && (
                <ul className="mt-2 space-y-2">
                  {room.past.map((entry) => (
                    <EntryCard key={entry.id} {...cardProps(entry)} />
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}

      <section className="border-t border-white/5 pt-4">
        <p className="mb-2 text-xs text-white/60">Someone can&apos;t find their link?</p>
        <div className="flex flex-wrap gap-2">
          <JoinLinkActions appointment={appointment} tone="dark" />
        </div>
      </section>
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.display_name ?? 'this person'} from the session?`}
        message="They'll be disconnected right away. To come back they'd need to rejoin and be admitted again."
        confirmLabel="Remove"
        danger
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) room.remove(removing.id);
          setRemoving(null);
        }}
      />
    </div>
  );
}
