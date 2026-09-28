import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, RefreshCw, Video } from 'lucide-react';
import { appointmentKeys, appointmentsApi, type Appointment } from '../api/appointments';
import { ApiError } from '../api/client';
import { telehealthApi, telehealthKeys, type RoomAccess, type WaitingRoomEntry } from '../api/telehealth';
import { useCan, useSession } from '../auth/StaffAuth';
import { RealtimeProvider } from '../lib/realtime';
import { buttonClasses } from '../ui/Button';
import { Card } from '../ui/Card';
import { Alert, ErrorState } from '../ui/Display';
import { ConfirmDialog } from '../ui/Modal';
import { FullPageSpinner } from '../ui/Spinner';
import { useToast } from '../ui/Toast';
import { playChime, primeChime } from './chime';
import { HostCall } from './HostCall';
import { ClientLinkButtons } from './JoinLinkActions';
import { RecordingStatus } from './recording/RecordingPanel';
import { isRecordingBusy } from './recording/recordingState';
import { useSessionRecorder } from './recording/useSessionRecorder';
import { hostJoinWindow, formatElapsed } from './sessionWindow';
import { isOpenVideoSession, SessionHeading, SessionLobby, SessionPageFrame } from './SessionLobby';
import { CallBackdrop, CallRoot, type DeviceIssue } from './video/CallLayout';
import { DEFAULT_DEVICE_CHOICES, type DeviceChoices } from './video/deviceChoices';
import { classifyMediaError, type MediaDeviceKindName } from './video/mediaErrors';
import { disconnectMessage, useVideoCall } from './video/useVideoCall';
import { useWaitingRoom } from './waiting/useWaitingRoom';
import { arrivalMessage } from './waiting/waitingRoom';

type Stage =
  | { name: 'lobby' }
  | { name: 'call'; access: RoomAccess; choices: DeviceChoices }
  | { name: 'ended'; message: string | null; duration: number | null; endedForEveryone?: boolean };

interface PendingAdmit {
  entries: WaitingRoomEntry[];
  all: boolean;
}

function hostTokenError(error: unknown): string {
  if (error instanceof ApiError && error.status === 503) {
    return "Video isn't set up on this server yet. Add the LiveKit settings described on the Telehealth page, then try again.";
  }
  return error instanceof Error ? error.message : "Couldn't start the session.";
}

/**
 * Full-screen video session. The appointment's clinician hosts it (device check, the call, the
 * waiting room and recording); anyone else sees who hosts it and, if they manage that calendar,
 * the clients' join links.
 */
export default function SessionRoomPage() {
  return (
    <RealtimeProvider realm="staff">
      <SessionRoom />
    </RealtimeProvider>
  );
}

function SessionRoom() {
  const params = useParams();
  const appointmentId = Number(params.appointmentId);
  const validId = Number.isInteger(appointmentId) && appointmentId > 0;
  const { staff } = useSession();

  const appointmentQuery = useQuery({
    queryKey: appointmentKeys.detail(appointmentId),
    queryFn: () => appointmentsApi.get(appointmentId),
    enabled: validId,
  });

  if (!validId) return <PageProblem title="Session not found" message="This link doesn't point to an appointment." />;
  if (appointmentQuery.isLoading) return <FullPageSpinner />;
  if (appointmentQuery.error || !appointmentQuery.data) {
    const notFound = appointmentQuery.error instanceof ApiError && appointmentQuery.error.status === 404;
    return notFound ? (
      <PageProblem title="Session not found" message="This appointment doesn't exist or isn't on a calendar you can see." />
    ) : (
      <div className="min-h-dvh bg-sage-50 pt-16">
        <ErrorState error={appointmentQuery.error} onRetry={() => void appointmentQuery.refetch()} />
      </div>
    );
  }
  const appointment = appointmentQuery.data;
  if (appointment.restricted) {
    return (
      <PageProblem
        title="You can't open this session"
        message={`It's on ${appointment.clinician.name}'s calendar with clients you don't have access to.`}
      />
    );
  }
  if (appointment.clinician.id !== staff.id) return <NonHostSession appointment={appointment} timeZone={staff.time_zone} />;
  return <HostSession appointment={appointment} timeZone={staff.time_zone} />;
}

/** For staff who aren't the session's clinician: who hosts it, and the join links if they manage that calendar. */
function NonHostSession({ appointment, timeZone }: { appointment: Appointment; timeZone: string }) {
  const managesCalendars = useCan('schedule_all');
  const showLinks = managesCalendars && isOpenVideoSession(appointment) && appointment.participants.length > 0;
  return (
    <SessionPageFrame>
      <main className="mx-auto max-w-lg px-4 py-6 sm:px-6 lg:py-10">
        <Card className="p-5">
          <SessionHeading appointment={appointment} timeZone={timeZone} />
          <div className="mt-5">
            <Alert tone="info" title={`Only ${appointment.clinician.name} can host this session.`}>
              {showLinks && 'You can copy or send each client their own join link.'}
            </Alert>
          </div>
          {showLinks && (
            <section aria-labelledby="join-links-heading" className="mt-5">
              <h2 id="join-links-heading" className="text-sm font-medium text-sage-800">
                Join links
              </h2>
              <ul className="mt-2 divide-y divide-sage-100 rounded-lg border border-sage-100">
                {appointment.participants.map((participant) => (
                  <li key={participant.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-sage-900">{participant.client.name}</span>
                    <ClientLinkButtons appointmentId={appointment.id} client={participant.client} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </Card>
      </main>
    </SessionPageFrame>
  );
}

/** The host's session: lobby, call, and what happens after leaving. */
function HostSession({ appointment, timeZone }: { appointment: Appointment; timeZone: string }) {
  const appointmentId = appointment.id;
  const toast = useToast();
  const [stage, setStage] = useState<Stage>({ name: 'lobby' });
  const [deviceIssue, setDeviceIssue] = useState<DeviceIssue | null>(null);
  const [pendingAdmit, setPendingAdmit] = useState<PendingAdmit | null>(null);
  const [confirmExit, setConfirmExit] = useState(false);
  const navigate = useNavigate();

  const consentQuery = useQuery({
    queryKey: telehealthKeys.consent(appointmentId),
    queryFn: () => telehealthApi.recordingConsent(appointmentId),
  });

  const waitingRoom = useWaitingRoom(appointmentId, (arrivals) => {
    playChime();
    toast.success(arrivalMessage(arrivals));
  });

  const access = useMemo(
    () => (stage.name === 'call' ? { serverUrl: stage.access.livekit_url, token: stage.access.token } : null),
    [stage],
  );
  const choices = stage.name === 'call' ? stage.choices : null;
  const onDeviceError = useCallback((kind: MediaDeviceKindName, error: Error) => {
    setDeviceIssue({ kind, problem: classifyMediaError(error) });
  }, []);

  const connectedAtRef = useRef<number | null>(null);
  const timeInCall = () => (connectedAtRef.current === null ? null : Date.now() - connectedAtRef.current);
  const call = useVideoCall(access, choices ?? DEFAULT_DEVICE_CHOICES, {
    onDisconnected: (reason) => setStage({ name: 'ended', message: disconnectMessage(reason), duration: timeInCall() }),
    onDeviceError,
  });
  connectedAtRef.current = call.connectedAt;
  const recorder = useSessionRecorder(appointmentId, call.status === 'connected' ? call.room : null);

  // Someone who didn't agree to recording got into the session (for example, admitted from
  // another tab): the audio can no longer be saved, so stop now.
  const consent = consentQuery.data;
  useEffect(() => {
    if (recorder.state.phase !== 'recording' || !consent || consent.all_consented) return;
    void recorder.discard("Recording stopped because someone in the session didn't agree to it, so the audio can't be saved.");
  }, [consent, recorder]);

  const join = useMutation({
    mutationFn: (joinChoices: DeviceChoices) =>
      telehealthApi.hostToken(appointmentId).then((roomAccess) => ({ roomAccess, joinChoices })),
    onSuccess: ({ roomAccess, joinChoices }) => {
      setDeviceIssue(null);
      setStage({ name: 'call', access: roomAccess, choices: joinChoices });
    },
  });

  const leave = async (endedForEveryone = false) => {
    const duration = timeInCall();
    await recorder.stop();
    setStage({ name: 'ended', message: null, duration, endedForEveryone });
  };

  const admitNow = (target: PendingAdmit) => {
    if (target.all) waitingRoom.admitAll();
    else target.entries.forEach((entry) => waitingRoom.admit(entry.id));
  };

  /** While recording, admitting someone who didn't consent first saves the recording made so far. */
  const requestAdmit = (target: PendingAdmit) => {
    const withoutConsent = target.entries.filter((entry) => !entry.recording_consent);
    if (recorder.state.phase === 'recording' && withoutConsent.length > 0) setPendingAdmit({ ...target, entries: withoutConsent });
    else admitNow(target);
  };

  const confirmPendingAdmit = async () => {
    const target = pendingAdmit;
    setPendingAdmit(null);
    if (!target) return;
    const saved = await recorder.stopAndUpload();
    if (!saved) {
      toast.error("The recording couldn't be saved, so no one was admitted yet. Retry or discard it in the Recording panel.");
      return;
    }
    admitNow(target);
  };

  const pendingNames = pendingAdmit?.entries.map((entry) => entry.display_name).join(', ') ?? '';
  const admitDialog = (
    <ConfirmDialog
      open={pendingAdmit !== null}
      title="Stop recording to admit?"
      message={`${pendingNames} didn't agree to recording. The recording will stop and be saved before they join, and you won't be able to record again while they're in the session.`}
      confirmLabel="Save recording and admit"
      onCancel={() => setPendingAdmit(null)}
      onConfirm={() => void confirmPendingAdmit()}
    />
  );

  if (stage.name === 'lobby') {
    return (
      <SessionLobby
        appointment={appointment}
        timeZone={timeZone}
        waitingRoom={waitingRoom}
        consent={consent}
        joining={join.isPending}
        joinError={join.error ? hostTokenError(join.error) : null}
        onJoin={(joinChoices) => {
          primeChime();
          join.mutate(joinChoices);
        }}
      />
    );
  }

  if (stage.name === 'ended') {
    const canRejoin = hostJoinWindow(appointment.starts_at, appointment.ends_at).state === 'open';
    const { duration } = stage;
    const staying =
      appointment.participants.length > 1
        ? 'Your clients stay connected until they leave.'
        : 'Your client stays connected until they leave.';
    return (
      <CallBackdrop>
        <div className="w-full max-w-md space-y-6 text-center">
          <div>
            <h1 className="text-2xl font-semibold">
              {stage.endedForEveryone ? 'Session ended' : stage.message ? 'Disconnected' : 'You left the session'}
            </h1>
            <p className="mt-2 text-sm text-white/70">
              {stage.endedForEveryone ? 'Everyone was disconnected and the waiting room is closed.' : (stage.message ?? staying)}
              {duration !== null && ` Time in session: ${formatElapsed(duration)}.`}
            </p>
          </div>
          {recorder.state.phase !== 'idle' && (
            <div className="rounded-xl bg-white/5 p-4 text-left">
              <RecordingStatus recorder={recorder} appointment={appointment} inCall={false} />
            </div>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
            {canRejoin && (
              <button type="button" onClick={() => setStage({ name: 'lobby' })} className={buttonClasses('primary', 'md', 'h-11')}>
                <Video className="h-4 w-4" /> Rejoin session
              </button>
            )}
            <button
              type="button"
              onClick={() => (isRecordingBusy(recorder.state) ? setConfirmExit(true) : navigate('/portal/telehealth'))}
              className={buttonClasses('secondary', 'md', 'h-11')}
            >
              <ArrowLeft className="h-4 w-4" /> Back to Telehealth
            </button>
          </div>
        </div>
        <ConfirmDialog
          open={confirmExit}
          title="Recording not saved yet"
          message={
            recorder.state.phase === 'upload_failed'
              ? "The recording couldn't be uploaded and exists only in this browser. If you leave now, it's lost."
              : "The recording is still uploading. Stay on this page until it's saved, or it may be lost."
          }
          confirmLabel="Leave anyway"
          danger
          onCancel={() => setConfirmExit(false)}
          onConfirm={() => navigate('/portal/telehealth')}
        />
      </CallBackdrop>
    );
  }

  if (call.status === 'failed' || !call.room) {
    return (
      <CallBackdrop>
        <div className="w-full max-w-md space-y-5 text-center">
          <h1 className="text-xl font-semibold">{call.status === 'failed' ? "Couldn't connect" : 'Connecting…'}</h1>
          {call.error && <p className="text-sm text-white/70">{call.error}</p>}
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
            {call.status === 'failed' && (
              <button type="button" onClick={call.retry} className={buttonClasses('primary', 'md', 'h-11')}>
                <RefreshCw className="h-4 w-4" /> Try again
              </button>
            )}
            <button type="button" onClick={() => setStage({ name: 'lobby' })} className={buttonClasses('secondary', 'md', 'h-11')}>
              Back
            </button>
          </div>
        </div>
      </CallBackdrop>
    );
  }

  return (
    <CallRoot room={call.room}>
      <HostCall
        appointment={appointment}
        timeZone={timeZone}
        status={call.status}
        connectedAt={call.connectedAt}
        waitingRoom={waitingRoom}
        consent={consent}
        consentError={consentQuery.error}
        recorder={recorder}
        deviceIssue={deviceIssue}
        onDismissIssue={() => setDeviceIssue(null)}
        onDeviceError={onDeviceError}
        onAdmit={(entry) => requestAdmit({ entries: [entry], all: false })}
        onAdmitAll={() => requestAdmit({ entries: waitingRoom.waiting, all: true })}
        onLeave={(endedForEveryone) => void leave(endedForEveryone)}
      />
      {admitDialog}
    </CallRoot>
  );
}

function PageProblem({ title, message }: { title: string; message: string }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-sage-50 px-4 text-center">
      <h1 className="text-xl font-semibold text-sage-900">{title}</h1>
      <p className="max-w-sm text-sm text-sage-600">{message}</p>
      <Link to="/portal/telehealth" className={buttonClasses('secondary', 'md')}>
        <ArrowLeft className="h-4 w-4" /> Back to Telehealth
      </Link>
    </div>
  );
}
