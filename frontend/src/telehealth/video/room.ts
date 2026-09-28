import { setLogLevel as setComponentsLogLevel } from '@livekit/components-react';
import {
  LogLevel,
  Room,
  setLogLevel,
  VideoPresets,
  type AudioCaptureOptions,
  type VideoCaptureOptions,
} from 'livekit-client';
import type { DeviceChoices } from './deviceChoices';

// LiveKit logs participant names and room details at info level; keep session details out of the console.
setLogLevel(LogLevel.warn);
setComponentsLogLevel('warn');

export function audioCaptureOptions(deviceId: string | undefined): AudioCaptureOptions {
  return {
    deviceId: deviceId || undefined,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
}

export function videoCaptureOptions(deviceId: string | undefined): VideoCaptureOptions {
  return {
    deviceId: deviceId || undefined,
    facingMode: deviceId ? undefined : 'user',
    resolution: VideoPresets.h720.resolution,
  };
}

/**
 * A room tuned for 1:1 and small-group therapy: adaptive stream and dynacast save bandwidth on
 * phones, and captures use the devices chosen on the preview screen.
 */
export function createVideoRoom(choices: DeviceChoices): Room {
  return new Room({
    adaptiveStream: true,
    dynacast: true,
    audioCaptureDefaults: audioCaptureOptions(choices.audioDeviceId),
    videoCaptureDefaults: videoCaptureOptions(choices.videoDeviceId),
    publishDefaults: { simulcast: true },
  });
}
