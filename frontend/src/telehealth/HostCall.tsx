import { useState } from 'react';
import { CircleDot, LayoutGrid, Rows2, Users } from 'lucide-react';
import type { Appointment } from '../api/appointments';
import { telehealthApi, type RecordingConsent, type WaitingRoomEntry } from '../api/telehealth';
import { formatTime } from '../lib/format';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Spinner } from '../ui/Spinner';
import { useToast } from '../ui/Toast';
import { RecordingIndicator, RecordingPanel } from './recording/RecordingPanel';
import type { SessionRecorder } from './recording/useSessionRecorder';
import { CallControls, ControlBadge, ControlButton } from './video/CallControls';
import {
  CallLayout,
  ConnectionIndicator,
  DeviceIssueBanner,
  SessionTimer,
  SidePanel,
  type DeviceIssue,
} from './video/CallLayout';
import { ChatPanel, useCallChat } from './video/ChatPanel';
import type { MediaDeviceKindName } from './video/mediaErrors';
import type { CallStatus } from './video/useVideoCall';
import { VideoStage, type StageLayout } from './video/VideoStage';
import type { WaitingRoom } from './waiting/useWaitingRoom';
import { WaitingRoomPanel } from './waiting/WaitingRoomPanel';

type Panel = 'waiting' | 'chat' | 'recording';

const PANEL_TITLES: Record<Panel, string> = {
  waiting: 'Waiting room',
  chat: 'Chat',
  recording: 'Recording',
};

/** The host's in-call screen (the appointment's clinician). Must be rendered inside CallRoot. */
export function HostCall({
  appointment,
  timeZone,
  status,
  connectedAt,
  waitingRoom,
  consent,
  consentError,
  recorder,
  deviceIssue,
  onDismissIssue,
  onDeviceError,
  onAdmit,
  onAdmitAll,
  onLeave,
}: {
  appointment: Appointment;
  timeZone: string;
  status: CallStatus;
  connectedAt: number | null;
  waitingRoom: WaitingRoom;
  consent: RecordingConsent | undefined;
  consentError: unknown;
  recorder: SessionRecorder;
  deviceIssue: DeviceIssue | null;
  onDismissIssue: () => void;
  onDeviceError: (kind: MediaDeviceKindName, error: Error) => void;
  onAdmit: (entry: WaitingRoomEntry) => void;
  onAdmitAll: () => void;
  /** Called after leaving; `endedForEveryone` is true when the session was ended for all. */
  onLeave: (endedForEveryone?: boolean) => void;
}) {
  const [panel, setPanel] = useState<Panel | null>(() => (waitingRoom.waiting.length > 0 ? 'waiting' : null));
  const [layout, setLayout] = useState<StageLayout>('speaker');
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [ending, setEnding] = useState(false);
  const toast = useToast();
  const chat = useCallChat(panel === 'chat');
  const recordingEnabled = consent?.recording_enabled ?? false;
  const recording = recorder.state.phase === 'recording';
  const toggle = (name: Panel) => setPanel((current) => (current === name ? null : name));

  const firstWaiting = waitingRoom.waiting[0];
  const alone = firstWaiting ? (
    <span>
      {firstWaiting.display_name} is waiting.{' '}
      <button type="button" onClick={() => onAdmit(firstWaiting)} className="font-semibold text-primary-300 underline underline-offset-2">
        Admit
      </button>
    </span>
  ) : appointment.participants.length > 1 ? (
    'Your clients will appear here after they join and you admit them.'
  ) : (
    'Your client will appear here after they join and you admit them.'
  );

  return (
    <>
      <CallLayout
        header={
          <>
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-sm font-semibold sm:text-base">{appointment.title_label}</h1>
              {connectedAt !== null && <SessionTimer since={connectedAt} />}
              <span className="hidden text-xs text-white/50 md:inline">Scheduled until {formatTime(appointment.ends_at, timeZone)}</span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <RecordingIndicator state={recorder.state} />
              <ConnectionIndicator />
              <button
                type="button"
                onClick={() => setLayout((value) => (value === 'speaker' ? 'grid' : 'speaker'))}
                aria-label={layout === 'speaker' ? 'Switch to grid view' : 'Switch to speaker view'}
                title={layout === 'speaker' ? 'Grid view' : 'Speaker view'}
                className="rounded-lg p-2 text-white/80 hover:bg-white/10 hover:text-white"
              >
                {layout === 'speaker' ? <LayoutGrid className="h-4 w-4" /> : <Rows2 className="h-4 w-4" />}
              </button>
            </div>
          </>
        }
        notice={<DeviceIssueBanner issue={deviceIssue} onDismiss={onDismissIssue} />}
        stage={
          <>
            <VideoStage layout={layout} alone={alone} />
            {status === 'connecting' && (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-[#0b1312]/80 text-sm text-white/80">
                <Spinner className="h-8 w-8 text-primary-300" />
                Connecting to the session…
              </div>
            )}
          </>
        }
        panel={
          panel && (
            <SidePanel title={PANEL_TITLES[panel]} onClose={() => setPanel(null)}>
              {panel === 'waiting' && (
                <WaitingRoomPanel
                  appointment={appointment}
                  room={waitingRoom}
                  recordingEnabled={recordingEnabled}
                  timeZone={timeZone}
                  onAdmit={onAdmit}
                  onAdmitAll={onAdmitAll}
                />
              )}
              {panel === 'chat' && <ChatPanel chat={chat} />}
              {panel === 'recording' && (
                <RecordingPanel appointment={appointment} recorder={recorder} consent={consent} consentError={consentError} />
              )}
            </SidePanel>
          )
        }
        controls={
          <CallControls
            chatOpen={panel === 'chat'}
            unreadMessages={chat.unread}
            onToggleChat={() => toggle('chat')}
            onLeave={() => setConfirmLeave(true)}
            onDeviceError={onDeviceError}
            extra={
              <>
                <ControlButton
                  label="Waiting room"
                  icon={<Users className="h-5 w-5" />}
                  tone={panel === 'waiting' ? 'active' : 'neutral'}
                  pressed={panel === 'waiting'}
                  onClick={() => toggle('waiting')}
                  badge={<ControlBadge count={waitingRoom.waiting.length} tone="alert" />}
                />
                {recordingEnabled && (
                  <ControlButton
                    label={recording ? 'Recording' : 'Record'}
                    icon={<CircleDot className={`h-5 w-5 ${recording ? 'animate-pulse text-red-500' : ''}`} />}
                    tone={panel === 'recording' ? 'active' : 'neutral'}
                    pressed={panel === 'recording'}
                    onClick={() => toggle('recording')}
                  />
                )}
              </>
            }
          />
        }
      />
      <Modal
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        title="Leave the session?"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmLeave(false)}>
              Stay
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirmLeave(false);
                onLeave();
              }}
            >
              Leave
            </Button>
            <Button
              variant="danger"
              loading={ending}
              onClick={() => {
                setEnding(true);
                telehealthApi
                  .endSession(appointment.id)
                  .catch((error: unknown) => toast.error(error))
                  .finally(() => {
                    setEnding(false);
                    setConfirmLeave(false);
                    onLeave(true);
                  });
              }}
            >
              End for everyone
            </Button>
          </>
        }
      >
        <p className="text-sm text-sage-700">
          {recording ? 'The recording will stop and be uploaded. ' : ''}Leave keeps the session open so you can rejoin. End for everyone disconnects all participants and closes
          the waiting room.
        </p>
      </Modal>
    </>
  );
}
