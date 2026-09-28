import type { ReactNode } from 'react';
import { ArrowLeft, Clock, LifeBuoy, Mic, Video } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Appointment } from '../api/appointments';
import type { RecordingConsent } from '../api/telehealth';
import { Brand } from '../components/BrandMark';
import '../components/brand-mark.css';
import { formatDateTime, formatTime } from '../lib/format';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Alert, Badge } from '../ui/Display';
import { ClientLinkButtons } from './JoinLinkActions';
import { hostJoinWindow, waitingLabel } from './sessionWindow';
import { useNow } from './useNow';
import type { DeviceChoices } from './video/deviceChoices';
import { DevicePreview } from './video/DevicePreview';
import { useLocalPreview } from './video/useLocalPreview';
import type { WaitingRoom } from './waiting/useWaitingRoom';
import { clientPresence, linkClientName, type ClientPresence } from './waiting/waitingRoom';

const CANCELED = new Set(['canceled', 'late_canceled', 'declined']);

const PRESENCE: Record<ClientPresence, { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  admitted: { label: 'In session', tone: 'success' },
  waiting: { label: 'Waiting', tone: 'warning' },
  absent: { label: 'Not here yet', tone: 'neutral' },
};

/** Whether the appointment is a video appointment that hasn't been canceled. */
export function isOpenVideoSession(appointment: Appointment): boolean {
  return appointment.has_video && !CANCELED.has(appointment.status);
}

/** Why the session can't be started right now, or null when it can. */
function blockedReason(appointment: Appointment, timeZone: string, now: number): string | null {
  if (!appointment.has_video) return "This appointment isn't a video appointment. Change its location to Video in the calendar to start a session.";
  if (CANCELED.has(appointment.status)) return 'This appointment was canceled.';
  const window = hostJoinWindow(appointment.starts_at, appointment.ends_at, now);
  if (window.state === 'too_early') {
    return `You can start this session from ${formatDateTime(window.opensAt.toISOString(), timeZone)}, 60 minutes before it begins.`;
  }
  if (window.state === 'closed') return 'This session closed 60 minutes after the appointment ended.';
  return null;
}

/** The light page frame shared by the lobby and the screens for people who can't host. */
export function SessionPageFrame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-sage-50">
      <header className="flex items-center justify-between gap-4 border-b border-sage-100 bg-white px-4 py-3 sm:px-6">
        <Link to="/portal/telehealth" className="inline-flex items-center gap-1.5 text-sm font-medium text-sage-700 hover:text-sage-900">
          <ArrowLeft className="h-4 w-4" /> Telehealth
        </Link>
        <span className="[&_.stack-mark]:w-6">
          <Brand wordClassName="text-base font-semibold text-sage-900" />
        </span>
      </header>
      {children}
    </div>
  );
}

/** "Video session", the session's name and when it is. */
export function SessionHeading({ appointment, timeZone }: { appointment: Appointment; timeZone: string }) {
  return (
    <>
      <p className="text-xs font-semibold uppercase tracking-wide text-primary-700">Video session</p>
      <h1 className="mt-1 text-xl font-semibold text-sage-900">{appointment.title_label}</h1>
      <p className="mt-1 flex items-center gap-1.5 text-sm text-sage-600">
        <Clock className="h-4 w-4" />
        {formatDateTime(appointment.starts_at, timeZone)} – {formatTime(appointment.ends_at, timeZone)}
      </p>
    </>
  );
}

/** Each client in the session, whether they're here yet, and their own join link. */
function SessionClients({ appointment, waitingRoom }: { appointment: Appointment; waitingRoom: WaitingRoom }) {
  const linksAvailable = isOpenVideoSession(appointment);
  return (
    <section aria-labelledby="session-clients" className="mt-5">
      <h2 id="session-clients" className="text-sm font-medium text-sage-800">
        {appointment.participants.length === 1 ? 'Client' : `Clients (${appointment.participants.length})`}
      </h2>
      <ul className="mt-2 divide-y divide-sage-100 rounded-lg border border-sage-100">
        {appointment.participants.map((participant) => {
          const presence = PRESENCE[clientPresence(waitingRoom.entries, participant.client.id)];
          return (
            <li key={participant.id} className="px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-medium text-sage-900">{participant.client.name}</span>
                <Badge tone={presence.tone}>{presence.label}</Badge>
              </div>
              {linksAvailable && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <ClientLinkButtons appointmentId={appointment.id} client={participant.client} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The host's pre-call screen: camera and microphone check, each client's status and join link,
 * who is waiting, and the join button. Devices are released as soon as this screen unmounts so
 * the call can open them.
 */
export function SessionLobby({
  appointment,
  timeZone,
  waitingRoom,
  consent,
  joining,
  joinError,
  onJoin,
}: {
  appointment: Appointment;
  timeZone: string;
  waitingRoom: WaitingRoom;
  consent: RecordingConsent | undefined;
  joining: boolean;
  joinError: string | null;
  onJoin: (choices: DeviceChoices) => void;
}) {
  const preview = useLocalPreview(true);
  const now = useNow(30_000);
  const blocked = blockedReason(appointment, timeZone, now);

  return (
    <SessionPageFrame>
      <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:py-10">
        <section aria-label="Camera and microphone check">
          <DevicePreview preview={preview} />
        </section>

        <Card className="h-fit p-5">
          <SessionHeading appointment={appointment} timeZone={timeZone} />

          {appointment.participants.length > 0 && <SessionClients appointment={appointment} waitingRoom={waitingRoom} />}

          <div className="mt-5 rounded-lg bg-sage-50 px-4 py-3">
            <p className="text-sm font-medium text-sage-800">Waiting room</p>
            {waitingRoom.waiting.length === 0 ? (
              <p className="mt-0.5 text-sm text-sage-600">No one is waiting yet. You&apos;ll hear a chime when someone arrives.</p>
            ) : (
              <ul className="mt-1 space-y-1.5">
                {waitingRoom.waiting.map((entry) => {
                  const clientName = linkClientName(appointment, entry.client_id);
                  return (
                    <li key={entry.id} className="text-sm text-sage-800">
                      <span className="font-medium">{entry.display_name}</span>{' '}
                      <span className="text-sage-500">· {waitingLabel(entry.created_at, now)}</span>
                      {clientName && <span className="block text-xs text-sage-600">{clientName}&apos;s link</span>}
                      {entry.current_location && (
                        <span className="mt-0.5 flex items-start gap-1 text-xs text-sage-600">
                          <LifeBuoy className="mt-0.5 h-3 w-3 shrink-0 text-amber-600" /> Emergency location: {entry.current_location}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {consent && (
            <p className="mt-3 text-sm text-sage-600">
              {consent.recording_enabled
                ? 'Recording is available once everyone in the session has agreed to it.'
                : 'Recording is turned off in your practice settings.'}
            </p>
          )}

          <div className="mt-5 space-y-3">
            {blocked && <Alert tone="warning">{blocked}</Alert>}
            {joinError && <Alert tone="danger">{joinError}</Alert>}
            <Button
              className="h-12 w-full text-base"
              loading={joining}
              disabled={!!blocked}
              icon={preview.choices.videoEnabled ? <Video className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
              onClick={() => onJoin(preview.choices)}
            >
              {preview.choices.videoEnabled ? 'Join session' : 'Join with audio only'}
            </Button>
          </div>
        </Card>
      </main>
    </SessionPageFrame>
  );
}
