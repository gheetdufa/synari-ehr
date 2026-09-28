/** Camera/microphone choices made on the preview screen, remembered on this device. */
export interface DeviceChoices {
  audioEnabled: boolean;
  videoEnabled: boolean;
  /** Empty means the browser default. */
  audioDeviceId: string;
  videoDeviceId: string;
}

const STORAGE_KEY = 'synari.video.devices';

export const DEFAULT_DEVICE_CHOICES: DeviceChoices = {
  audioEnabled: true,
  videoEnabled: true,
  audioDeviceId: '',
  videoDeviceId: '',
};

/** Only device ids and on/off switches are stored, never names or anything about the session. */
export function loadDeviceChoices(): DeviceChoices {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_DEVICE_CHOICES;
    const parsed = JSON.parse(raw) as Partial<DeviceChoices>;
    return {
      audioEnabled: parsed.audioEnabled !== false,
      videoEnabled: parsed.videoEnabled !== false,
      audioDeviceId: typeof parsed.audioDeviceId === 'string' ? parsed.audioDeviceId : '',
      videoDeviceId: typeof parsed.videoDeviceId === 'string' ? parsed.videoDeviceId : '',
    };
  } catch {
    return DEFAULT_DEVICE_CHOICES;
  }
}

export function saveDeviceChoices(choices: DeviceChoices): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choices));
  } catch {
    // Storage can be unavailable (private mode); choices then last for this visit only.
  }
}
