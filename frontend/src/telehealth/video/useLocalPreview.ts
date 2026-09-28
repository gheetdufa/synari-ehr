import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createAudioAnalyser,
  createLocalAudioTrack,
  createLocalTracks,
  createLocalVideoTrack,
  LocalAudioTrack,
  LocalVideoTrack,
  type AudioCaptureOptions,
  type VideoCaptureOptions,
} from 'livekit-client';
import { loadDeviceChoices, saveDeviceChoices, type DeviceChoices } from './deviceChoices';
import { classifyMediaError, environmentProblem, type MediaProblem } from './mediaErrors';
import { audioCaptureOptions, videoCaptureOptions } from './room';

export interface PreviewProblems {
  microphone: MediaProblem | null;
  camera: MediaProblem | null;
}

export interface LocalPreview {
  choices: DeviceChoices;
  audioTrack: LocalAudioTrack | null;
  videoTrack: LocalVideoTrack | null;
  problems: PreviewProblems;
  /** Waiting for the browser (or the person) to grant a camera or microphone. */
  pending: boolean;
  setAudioEnabled: (enabled: boolean) => void;
  setVideoEnabled: (enabled: boolean) => void;
  selectDevice: (kind: 'audioinput' | 'videoinput', deviceId: string) => void;
  retry: () => void;
}

interface Acquired {
  audio?: LocalAudioTrack;
  video?: LocalVideoTrack;
  audioProblem?: MediaProblem;
  videoProblem?: MediaProblem;
}

async function createOne<T>(create: (deviceId: string | undefined) => Promise<T>, deviceId: string): Promise<T> {
  try {
    return await create(deviceId || undefined);
  } catch (error) {
    // A remembered device may be gone (another computer, unplugged); fall back to the default one.
    if (deviceId && classifyMediaError(error) === 'not_found') return create(undefined);
    throw error;
  }
}

/**
 * Ask for the camera and microphone together first so people see a single permission prompt;
 * if that fails, ask for each separately to learn which one is unavailable.
 */
async function acquireTracks(choices: DeviceChoices, wantAudio: boolean, wantVideo: boolean): Promise<Acquired> {
  if (wantAudio && wantVideo) {
    try {
      const tracks = await createLocalTracks({
        audio: audioCaptureOptions(choices.audioDeviceId),
        video: videoCaptureOptions(choices.videoDeviceId),
      });
      const result: Acquired = {};
      for (const track of tracks) {
        if (track instanceof LocalAudioTrack) result.audio = track;
        else if (track instanceof LocalVideoTrack) result.video = track;
      }
      if (result.audio && result.video) return result;
      result.audio?.stop();
      result.video?.stop();
    } catch {
      // Fall through to per-device requests below.
    }
  }
  const result: Acquired = {};
  if (wantVideo) {
    try {
      result.video = await createOne(
        (deviceId) => createLocalVideoTrack(videoCaptureOptions(deviceId) satisfies VideoCaptureOptions),
        choices.videoDeviceId,
      );
    } catch (error) {
      result.videoProblem = classifyMediaError(error);
    }
  }
  if (wantAudio) {
    try {
      result.audio = await createOne(
        (deviceId) => createLocalAudioTrack(audioCaptureOptions(deviceId) satisfies AudioCaptureOptions),
        choices.audioDeviceId,
      );
    } catch (error) {
      result.audioProblem = classifyMediaError(error);
    }
  }
  return result;
}

function initialProblems(): PreviewProblems {
  const problem = environmentProblem();
  return { microphone: problem, camera: problem };
}

/**
 * Camera and microphone preview before joining a call, with device choice and permission errors.
 * Tracks are released when `active` turns false and on unmount, so the call can open the devices.
 */
export function useLocalPreview(active: boolean): LocalPreview {
  const [choices, setChoices] = useState<DeviceChoices>(loadDeviceChoices);
  const [audioTrack, setAudioTrack] = useState<LocalAudioTrack | null>(null);
  const [videoTrack, setVideoTrack] = useState<LocalVideoTrack | null>(null);
  const [problems, setProblems] = useState<PreviewProblems>(initialProblems);
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const choicesRef = useRef(choices);
  choicesRef.current = choices;
  const tracksRef = useRef<{ audio: LocalAudioTrack | null; video: LocalVideoTrack | null }>({ audio: null, video: null });

  const replaceAudio = useCallback((track: LocalAudioTrack | null) => {
    if (tracksRef.current.audio !== track) tracksRef.current.audio?.stop();
    tracksRef.current.audio = track;
    setAudioTrack(track);
  }, []);
  const replaceVideo = useCallback((track: LocalVideoTrack | null) => {
    if (tracksRef.current.video !== track) tracksRef.current.video?.stop();
    tracksRef.current.video = track;
    setVideoTrack(track);
  }, []);

  useEffect(() => saveDeviceChoices(choices), [choices]);

  const wantAudio = active && choices.audioEnabled && !audioTrack && !problems.microphone;
  const wantVideo = active && choices.videoEnabled && !videoTrack && !problems.camera;

  useEffect(() => {
    if (!wantAudio && !wantVideo) {
      setPending(false);
      return;
    }
    let canceled = false;
    setPending(true);
    void acquireTracks(choicesRef.current, wantAudio, wantVideo).then((result) => {
      if (canceled) {
        result.audio?.stop();
        result.video?.stop();
        return;
      }
      if (wantAudio) replaceAudio(result.audio ?? null);
      if (wantVideo) replaceVideo(result.video ?? null);
      setProblems((current) => ({
        microphone: wantAudio ? result.audioProblem ?? null : current.microphone,
        camera: wantVideo ? result.videoProblem ?? null : current.camera,
      }));
      setPending(false);
    });
    return () => {
      canceled = true;
    };
  }, [wantAudio, wantVideo, attempt, replaceAudio, replaceVideo]);

  useEffect(() => {
    if (active) return;
    replaceAudio(null);
    replaceVideo(null);
  }, [active, replaceAudio, replaceVideo]);

  useEffect(
    () => () => {
      tracksRef.current.audio?.stop();
      tracksRef.current.video?.stop();
      tracksRef.current = { audio: null, video: null };
    },
    [],
  );

  const setAudioEnabled = useCallback(
    (enabled: boolean) => {
      setChoices((current) => ({ ...current, audioEnabled: enabled }));
      if (!enabled) {
        replaceAudio(null);
        setProblems((current) => ({ ...current, microphone: environmentProblem() }));
      }
    },
    [replaceAudio],
  );

  const setVideoEnabled = useCallback(
    (enabled: boolean) => {
      setChoices((current) => ({ ...current, videoEnabled: enabled }));
      if (!enabled) {
        replaceVideo(null);
        setProblems((current) => ({ ...current, camera: environmentProblem() }));
      }
    },
    [replaceVideo],
  );

  const selectDevice = useCallback((kind: 'audioinput' | 'videoinput', deviceId: string) => {
    const isAudio = kind === 'audioinput';
    setChoices((current) => (isAudio ? { ...current, audioDeviceId: deviceId } : { ...current, videoDeviceId: deviceId }));
    const track = isAudio ? tracksRef.current.audio : tracksRef.current.video;
    const problemKey: keyof PreviewProblems = isAudio ? 'microphone' : 'camera';
    if (!track) {
      setProblems((current) => ({ ...current, [problemKey]: null }));
      return;
    }
    track.setDeviceId(deviceId).catch((error: unknown) => {
      setProblems((current) => ({ ...current, [problemKey]: classifyMediaError(error) }));
    });
  }, []);

  const retry = useCallback(() => {
    const problem = environmentProblem();
    setProblems({ microphone: problem, camera: problem });
    setAttempt((value) => value + 1);
  }, []);

  return { choices, audioTrack, videoTrack, problems, pending, setAudioEnabled, setVideoEnabled, selectDevice, retry };
}

/** Input level of a local microphone track, 0..1, sampled a few times a second. */
export function useAudioLevel(track: LocalAudioTrack | null): number {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!track || typeof window.AudioContext !== 'function') {
      setLevel(0);
      return;
    }
    const { calculateVolume, cleanup } = createAudioAnalyser(track, { cloneTrack: true });
    const timer = window.setInterval(() => setLevel(Math.min(1, calculateVolume() * 2.5)), 120);
    return () => {
      window.clearInterval(timer);
      void cleanup();
    };
  }, [track]);
  return level;
}

/** Cameras or microphones on this device; re-read when devices change or permission is granted. */
export function useDeviceList(kind: 'audioinput' | 'videoinput', refreshKey: unknown): MediaDeviceInfo[] {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const mediaDevices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
    if (typeof mediaDevices?.enumerateDevices !== 'function') return;
    let current = true;
    const load = () => {
      mediaDevices
        .enumerateDevices()
        .then((all) => {
          if (current) setDevices(all.filter((device) => device.kind === kind && device.deviceId !== ''));
        })
        .catch(() => undefined);
    };
    load();
    mediaDevices.addEventListener('devicechange', load);
    return () => {
      current = false;
      mediaDevices.removeEventListener('devicechange', load);
    };
  }, [kind, refreshKey]);
  return devices;
}
