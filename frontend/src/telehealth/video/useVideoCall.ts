import { useCallback, useEffect, useRef, useState } from 'react';
import { DisconnectReason, RoomEvent, type Room } from 'livekit-client';
import type { DeviceChoices } from './deviceChoices';
import type { MediaDeviceKindName } from './mediaErrors';
import { createVideoRoom } from './room';

export interface CallAccess {
  serverUrl: string;
  token: string;
}

export type CallStatus = 'connecting' | 'connected' | 'failed';

export interface VideoCall {
  room: Room | null;
  status: CallStatus;
  error: string | null;
  /** When this device joined the call (ms since epoch), for the session timer. */
  connectedAt: number | null;
  retry: () => void;
}

export interface VideoCallHandlers {
  /** The call ended without this page asking it to (network loss, removed, joined elsewhere...). */
  onDisconnected?: (reason: DisconnectReason | undefined) => void;
  onDeviceError?: (kind: MediaDeviceKindName, error: Error) => void;
}

function connectErrorMessage(serverUrl: string): string {
  if (window.location.protocol === 'https:' && serverUrl.startsWith('ws://')) {
    return "The video server isn't using a secure address (wss://), so this browser won't connect to it. Ask your practice administrator to fix the LiveKit URL.";
  }
  return "We couldn't connect to the video session. Check your internet connection and try again.";
}

/**
 * Connects to a LiveKit room while `access` is set and publishes the chosen camera and microphone.
 * Each connection gets its own Room, so a leftover disconnect from an earlier attempt (for example
 * React's development double-mount) can never end the current call. Clearing `access` or unmounting
 * disconnects.
 */
export function useVideoCall(access: CallAccess | null, choices: DeviceChoices, handlers: VideoCallHandlers): VideoCall {
  const [room, setRoom] = useState<Room | null>(null);
  const [status, setStatus] = useState<CallStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const choicesRef = useRef(choices);
  choicesRef.current = choices;

  const serverUrl = access?.serverUrl;
  const token = access?.token;

  useEffect(() => {
    if (!serverUrl || !token) {
      setRoom(null);
      setConnectedAt(null);
      return;
    }
    const current = createVideoRoom(choicesRef.current);
    let disposed = false;
    setRoom(current);
    setStatus('connecting');
    setError(null);
    setConnectedAt(null);

    const deviceError = (kind: MediaDeviceKindName) => (err: unknown) => {
      if (!disposed && err instanceof Error) handlersRef.current.onDeviceError?.(kind, err);
    };
    const onMediaError = (err: Error, kind?: MediaDeviceKind) => {
      deviceError(kind === 'videoinput' ? 'camera' : 'microphone')(err);
    };
    const onDisconnected = (reason?: DisconnectReason) => {
      if (!disposed) handlersRef.current.onDisconnected?.(reason);
    };
    current.on(RoomEvent.MediaDevicesError, onMediaError).on(RoomEvent.Disconnected, onDisconnected);

    current
      .connect(serverUrl, token)
      .then(async () => {
        if (disposed) return;
        setStatus('connected');
        setConnectedAt(Date.now());
        const { audioEnabled, videoEnabled } = choicesRef.current;
        if (audioEnabled) await current.localParticipant.setMicrophoneEnabled(true).catch(deviceError('microphone'));
        if (videoEnabled && !disposed) await current.localParticipant.setCameraEnabled(true).catch(deviceError('camera'));
      })
      .catch(() => {
        if (disposed) return;
        setStatus('failed');
        setError(connectErrorMessage(serverUrl));
      });

    return () => {
      disposed = true;
      current.off(RoomEvent.MediaDevicesError, onMediaError).off(RoomEvent.Disconnected, onDisconnected);
      void current.disconnect();
    };
  }, [serverUrl, token, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { room, status, error, connectedAt, retry };
}

/** Why a call ended, in words for the person who was in it. */
export function disconnectMessage(reason: DisconnectReason | undefined): string {
  switch (reason) {
    case DisconnectReason.DUPLICATE_IDENTITY:
      return 'You joined this session from another tab or device, so this window was disconnected.';
    case DisconnectReason.PARTICIPANT_REMOVED:
      return 'You were removed from the session.';
    case DisconnectReason.ROOM_DELETED:
      return 'The session was closed.';
    default:
      return 'The connection to the session was lost.';
  }
}
