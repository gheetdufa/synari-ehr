import { useCallback, useState } from 'react';
import { PhoneOff, RefreshCw } from 'lucide-react';
import type { JoinInfo } from '../../api/telehealth';
import { CallControls } from '../../telehealth/video/CallControls';
import {
  CallBackdrop,
  CallLayout,
  CallRoot,
  ConnectionIndicator,
  DeviceIssueBanner,
  SessionTimer,
  SidePanel,
  type DeviceIssue,
} from '../../telehealth/video/CallLayout';
import { ChatPanel, useCallChat } from '../../telehealth/video/ChatPanel';
import type { DeviceChoices } from '../../telehealth/video/deviceChoices';
import { classifyMediaError, type MediaDeviceKindName } from '../../telehealth/video/mediaErrors';
import { disconnectMessage, useVideoCall, type CallStatus } from '../../telehealth/video/useVideoCall';
import { VideoStage } from '../../telehealth/video/VideoStage';
import { buttonClasses } from '../../ui/Button';
import { ConfirmDialog } from '../../ui/Modal';
import { Spinner } from '../../ui/Spinner';
import type { GuestAccess } from './guestState';

/** The guest's call: connects with the token from the waiting room and handles dropped connections. */
export function GuestCall({
  info,
  access,
  choices,
  onLeave,
  onReconnect,
}: {
  info: JoinInfo;
  access: GuestAccess;
  choices: DeviceChoices;
  onLeave: () => void;
  onReconnect: () => void;
}) {
  const [deviceIssue, setDeviceIssue] = useState<DeviceIssue | null>(null);
  const [dropped, setDropped] = useState<string | null>(null);
  const onDeviceError = useCallback((kind: MediaDeviceKindName, error: Error) => {
    setDeviceIssue({ kind, problem: classifyMediaError(error) });
  }, []);
  const call = useVideoCall(dropped ? null : access, choices, {
    onDisconnected: (reason) => setDropped(disconnectMessage(reason)),
    onDeviceError,
  });

  if (dropped || call.status === 'failed' || !call.room) {
    const failed = dropped !== null || call.status === 'failed';
    return (
      <CallBackdrop>
        <div className="w-full max-w-md space-y-5 text-center">
          {!failed && <Spinner className="mx-auto h-8 w-8 text-primary-300" />}
          <h1 className="text-xl font-semibold">{failed ? 'You were disconnected' : 'Joining your session…'}</h1>
          {failed && <p className="text-sm text-white/70">{dropped ?? call.error}</p>}
          {failed && (
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
              <button
                type="button"
                onClick={dropped ? onReconnect : call.retry}
                className={buttonClasses('primary', 'md', 'h-11')}
              >
                <RefreshCw className="h-4 w-4" /> Reconnect
              </button>
              <button type="button" onClick={onLeave} className={buttonClasses('secondary', 'md', 'h-11')}>
                <PhoneOff className="h-4 w-4" /> Leave
              </button>
            </div>
          )}
        </div>
      </CallBackdrop>
    );
  }

  return (
    <CallRoot room={call.room}>
      <GuestCallView
        info={info}
        status={call.status}
        connectedAt={call.connectedAt}
        deviceIssue={deviceIssue}
        onDismissIssue={() => setDeviceIssue(null)}
        onDeviceError={onDeviceError}
        onLeave={onLeave}
      />
    </CallRoot>
  );
}

function GuestCallView({
  info,
  status,
  connectedAt,
  deviceIssue,
  onDismissIssue,
  onDeviceError,
  onLeave,
}: {
  info: JoinInfo;
  status: CallStatus;
  connectedAt: number | null;
  deviceIssue: DeviceIssue | null;
  onDismissIssue: () => void;
  onDeviceError: (kind: MediaDeviceKindName, error: Error) => void;
  onLeave: () => void;
}) {
  const [chatOpen, setChatOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const chat = useCallChat(chatOpen);

  return (
    <>
      <CallLayout
        header={
          <>
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-sm font-semibold sm:text-base">Session with {info.clinician_name}</h1>
              {connectedAt !== null && <SessionTimer since={connectedAt} />}
            </div>
            <ConnectionIndicator />
          </>
        }
        notice={<DeviceIssueBanner issue={deviceIssue} onDismiss={onDismissIssue} />}
        stage={
          <>
            <VideoStage layout="speaker" alone={`Waiting for ${info.clinician_name} to join the video…`} />
            {status === 'connecting' && (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-[#0b1312]/80 text-sm text-white/80">
                <Spinner className="h-8 w-8 text-primary-300" />
                Joining your session…
              </div>
            )}
          </>
        }
        panel={
          chatOpen && (
            <SidePanel title="Chat" onClose={() => setChatOpen(false)}>
              <ChatPanel chat={chat} />
            </SidePanel>
          )
        }
        controls={
          <CallControls
            chatOpen={chatOpen}
            unreadMessages={chat.unread}
            onToggleChat={() => setChatOpen((open) => !open)}
            onLeave={() => setConfirmLeave(true)}
            onDeviceError={onDeviceError}
          />
        }
      />
      <ConfirmDialog
        open={confirmLeave}
        title="Leave the session?"
        message="You can rejoin from your link while the appointment is open."
        confirmLabel="Leave"
        danger
        onCancel={() => setConfirmLeave(false)}
        onConfirm={() => {
          setConfirmLeave(false);
          onLeave();
        }}
      />
    </>
  );
}
