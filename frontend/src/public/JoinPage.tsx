import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, CalendarX2, Clock, DoorOpen, LinkIcon, UserX, Video } from 'lucide-react';
import { ApiError } from '../api/client';
import { guestApi, telehealthKeys, type JoinInfo } from '../api/telehealth';
import { playChime, primeChime } from '../telehealth/chime';
import { DevicePreview } from '../telehealth/video/DevicePreview';
import { useLocalPreview } from '../telehealth/video/useLocalPreview';
import { Button } from '../ui/Button';
import { ErrorState } from '../ui/Display';
import { FullPageSpinner } from '../ui/Spinner';
import { GuestCall } from './join/GuestCall';
import type { FinishReason } from './join/guestState';
import { JoinForm } from './join/JoinForm';
import { formatAppointmentTime, JoinLayout, JoinMessage } from './join/JoinLayout';
import { hasStoredVisit, useGuestSession } from './join/useGuestSession';
import { WaitingScreen } from './join/WaitingScreen';

const TOO_EARLY_REFRESH_MS = 60_000;

/**
 * Public page behind a telehealth join link (no account needed): check in, wait to be admitted,
 * then join the call. Also used by signed-in clients from the portal's "Join video" button.
 */
export default function JoinPage() {
  const { token = '' } = useParams();
  const [resuming] = useState(() => hasStoredVisit(token));
  const info = useQuery({
    queryKey: telehealthKeys.joinInfo(token),
    queryFn: () => guestApi.joinInfo(token),
    refetchInterval: (query) => (query.state.data?.status === 'too_early' ? TOO_EARLY_REFRESH_MS : false),
    refetchOnWindowFocus: false,
    retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
  });

  if (info.isLoading) return <FullPageSpinner />;
  if (info.error || !info.data) {
    const invalid = info.error instanceof ApiError && info.error.status === 404;
    return (
      <JoinLayout>
        {invalid ? (
          <JoinMessage icon={<LinkIcon />} title="This link isn't valid">
            <p>It may have expired or been copied incompletely. Open the link from your most recent email or text, or ask your clinician&apos;s office for a new one.</p>
          </JoinMessage>
        ) : (
          <div className="pt-10">
            <ErrorState error={info.error} onRetry={() => void info.refetch()} />
          </div>
        )}
      </JoinLayout>
    );
  }

  const data = info.data;
  if (data.status === 'open' || resuming) return <GuestFlow token={token} info={data} />;
  return (
    <JoinLayout info={data}>
      {data.status === 'too_early' ? (
        <TooEarly info={data} />
      ) : data.status === 'canceled' ? (
        <JoinMessage icon={<CalendarX2 />} title="This appointment was canceled">
          <p>Please contact {data.practice_name || data.clinician_name} if you have questions or want to reschedule.</p>
        </JoinMessage>
      ) : (
        <JoinMessage icon={<CalendarClock />} title="This appointment has ended">
          <p>The video link for {formatAppointmentTime(data.starts_at, data.time_zone)} is no longer active.</p>
        </JoinMessage>
      )}
    </JoinLayout>
  );
}

function TooEarly({ info }: { info: JoinInfo }) {
  const [checking, setChecking] = useState(false);
  const opensAt = new Date(new Date(info.starts_at).getTime() - 60 * 60_000).toISOString();
  return (
    <>
      <JoinMessage
        icon={<Clock />}
        title="It's a little early"
        action={
          !checking && (
            <Button variant="secondary" icon={<Video className="h-4 w-4" />} onClick={() => setChecking(true)}>
              Test my camera and microphone
            </Button>
          )
        }
      >
        <p>
          Your video appointment with {info.clinician_name} is on{' '}
          <strong>{formatAppointmentTime(info.starts_at, info.time_zone)}</strong>.
        </p>
        <p>
          Come back 60 minutes before it starts (from {formatAppointmentTime(opensAt, info.time_zone)}). This page refreshes on its own,
          so you can leave it open.
        </p>
      </JoinMessage>
      {checking && <DeviceCheck />}
    </>
  );
}

function DeviceCheck() {
  const preview = useLocalPreview(true);
  return (
    <div className="mx-auto mt-6 max-w-lg">
      <DevicePreview preview={preview} />
    </div>
  );
}

const FINISHED: Record<FinishReason, { title: string; body: (info: JoinInfo) => string; again: string | null }> = {
  left: {
    title: "You've left the session",
    body: () => 'You can rejoin while the appointment is open.',
    again: 'Rejoin',
  },
  declined: {
    title: "You weren't admitted",
    body: (info) =>
      `${info.clinician_name} wasn't able to let you in from the waiting room. If you think this is a mistake, contact ${info.practice_name || 'the practice'}.`,
    again: 'Check in again',
  },
  expired: {
    title: 'Your waiting room visit ended',
    body: (info) => `Visits end after a few hours. Check in again to let ${info.clinician_name} know you are here.`,
    again: 'Check in again',
  },
  canceled: {
    title: 'This appointment was canceled',
    body: (info) => `Please contact ${info.practice_name || info.clinician_name} if you have questions.`,
    again: null,
  },
  ended: {
    title: 'This appointment has ended',
    body: () => 'Thank you. You can close this page.',
    again: null,
  },
};

function GuestFlow({ token, info }: { token: string; info: JoinInfo }) {
  const session = useGuestSession(token);
  const { state } = session;
  const previewActive = state.phase === 'form' || state.phase === 'entering' || state.phase === 'waiting';
  const preview = useLocalPreview(previewActive);

  useEffect(() => {
    if (state.phase === 'admitted') playChime();
  }, [state.phase]);

  if (state.phase === 'admitted') {
    return (
      <GuestCall
        info={info}
        access={state.access}
        choices={preview.choices}
        onLeave={() => void session.leave()}
        onReconnect={session.resume}
      />
    );
  }

  return (
    <JoinLayout info={info}>
      {state.phase === 'resuming' ? (
        <JoinMessage icon={<DoorOpen />} title="Getting you back in…">
          <p>One moment while we reconnect you to the waiting room.</p>
        </JoinMessage>
      ) : state.phase === 'waiting' ? (
        <WaitingScreen
          info={info}
          preview={preview}
          connectionTrouble={state.failures >= 2}
          onLeave={() => void session.leave()}
        />
      ) : state.phase === 'finished' ? (
        <JoinMessage
          icon={state.reason === 'declined' ? <UserX /> : <DoorOpen />}
          title={FINISHED[state.reason].title}
          action={
            FINISHED[state.reason].again && (
              <Button onClick={session.rejoin} icon={<Video className="h-4 w-4" />}>
                {FINISHED[state.reason].again}
              </Button>
            )
          }
        >
          <p>{FINISHED[state.reason].body(info)}</p>
        </JoinMessage>
      ) : (
        <JoinForm
          info={info}
          preview={preview}
          defaults={session.lastInput}
          submitting={state.phase === 'entering'}
          error={state.phase === 'form' ? state.error : null}
          onSubmit={(input) => {
            primeChime();
            session.enter(input);
          }}
        />
      )}
    </JoinLayout>
  );
}
