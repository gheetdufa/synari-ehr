import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RoomEvent, Track, type Room } from 'livekit-client';
import { telehealthApi, telehealthKeys } from '../../api/telehealth';
import { useRealtimeEvent } from '../../lib/realtime';
import {
  browserRecordingFormat,
  createSessionMixer,
  RECORDING_BITS_PER_SECOND,
  type RecordingFormat,
  type SessionAudioMixer,
} from './audioMixer';
import { initialRecordingState, isRecordingBusy, recordingReducer, type RecordingState } from './recordingState';

export interface SessionRecorder {
  state: RecordingState;
  /** The format this browser records in; null when it can't record. */
  format: RecordingFormat | null;
  start: () => Promise<void>;
  /** Stop capturing and upload in the background. Resolves once the audio is captured. */
  stop: () => Promise<void>;
  /** Stop capturing and wait for the upload; resolves false if the upload failed. */
  stopAndUpload: () => Promise<boolean>;
  /** Stop capturing and throw the audio away. */
  discard: (reason: string) => Promise<void>;
  retryUpload: () => void;
}

/** Every audio track in the call: this browser's microphone plus each remote participant's audio. */
function sessionAudioTracks(room: Room): MediaStreamTrack[] {
  const tracks: MediaStreamTrack[] = [];
  const microphone = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
  if (microphone) tracks.push(microphone.mediaStreamTrack);
  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.audioTrackPublications.values()) {
      if (publication.track) tracks.push(publication.track.mediaStreamTrack);
    }
  }
  return tracks;
}

const RESYNC_EVENTS = [
  RoomEvent.TrackSubscribed,
  RoomEvent.TrackUnsubscribed,
  RoomEvent.LocalTrackPublished,
  RoomEvent.LocalTrackUnpublished,
  RoomEvent.ParticipantDisconnected,
  RoomEvent.ActiveDeviceChanged,
  RoomEvent.Reconnected,
] as const;

const SAFETY_RESYNC_MS = 5_000;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Records the whole session's audio in the host's browser and uploads it for transcription.
 * The local microphone and every remote participant's audio are mixed with WebAudio; people who
 * join later are added as they arrive. Warns before the page is closed while audio exists only here.
 */
export function useSessionRecorder(appointmentId: number, room: Room | null): SessionRecorder {
  const [state, dispatch] = useReducer(recordingReducer, initialRecordingState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const format = useMemo(() => browserRecordingFormat(), []);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const mixerRef = useRef<SessionAudioMixer | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const pendingFileRef = useRef<File | null>(null);
  const roomRef = useRef(room);
  roomRef.current = room;

  // Keep the mix in step with who is in the call.
  const recording = state.phase === 'recording';
  useEffect(() => {
    if (!recording || !room) return;
    const sync = () => mixerRef.current?.sync(sessionAudioTracks(room));
    RESYNC_EVENTS.forEach((event) => room.on(event, sync));
    const timer = window.setInterval(sync, SAFETY_RESYNC_MS);
    sync();
    return () => {
      RESYNC_EVENTS.forEach((event) => room.off(event, sync));
      window.clearInterval(timer);
    };
  }, [recording, room]);

  /** Stop the recorder and mixer; returns the captured audio as a file (null if nothing was captured). */
  const finishCapture = useCallback(async (): Promise<File | null> => {
    const recorder = recorderRef.current;
    const mixer = mixerRef.current;
    recorderRef.current = null;
    mixerRef.current = null;
    if (recorder && recorder.state !== 'inactive') {
      const stopped = new Promise<void>((resolve) => recorder.addEventListener('stop', () => resolve(), { once: true }));
      recorder.stop();
      await stopped;
    }
    await mixer?.close();
    const chunks = chunksRef.current;
    chunksRef.current = [];
    if (!recorder || !format || chunks.length === 0) return null;
    const type = recorder.mimeType || format.mimeType;
    const blob = new Blob(chunks, { type });
    return blob.size > 0 ? new File([blob], `recording.${format.extension}`, { type }) : null;
  }, [format]);

  /** Upload captured audio; resolves true once it's saved on the server. */
  const upload = useCallback(
    async (file: File): Promise<boolean> => {
      pendingFileRef.current = file;
      dispatch({ type: 'upload_started' });
      try {
        const created = await telehealthApi.uploadRecording(appointmentId, file, (progress) =>
          dispatch({ type: 'upload_progress', progress }),
        );
        pendingFileRef.current = null;
        dispatch({ type: 'uploaded', recordingId: created.id });
        return true;
      } catch (error) {
        dispatch({ type: 'upload_failed', error: errorMessage(error, "The recording couldn't be uploaded.") });
        return false;
      }
    },
    [appointmentId],
  );

  /** End an active recording and return its audio (null when there's nothing to upload). */
  const captureForUpload = useCallback(async (): Promise<File | null> => {
    // finishCapture clears recorderRef synchronously, so a second concurrent stop returns here.
    if (stateRef.current.phase !== 'recording' || !recorderRef.current) return null;
    dispatch({ type: 'finish' });
    const file = await finishCapture();
    if (!file) dispatch({ type: 'discard', reason: 'No audio was captured, so there was nothing to save.' });
    return file;
  }, [finishCapture]);

  const stop = useCallback(async () => {
    const file = await captureForUpload();
    if (file) void upload(file);
  }, [captureForUpload, upload]);

  const stopAndUpload = useCallback(async (): Promise<boolean> => {
    const file = await captureForUpload();
    return file ? upload(file) : true;
  }, [captureForUpload, upload]);

  const start = useCallback(async () => {
    const currentRoom = roomRef.current;
    if (!format || !currentRoom) return;
    dispatch({ type: 'start' });
    const mixer = createSessionMixer();
    if (!mixer) {
      dispatch({ type: 'start_failed', error: "This browser can't record audio." });
      return;
    }
    try {
      await mixer.resume();
      mixer.sync(sessionAudioTracks(currentRoom));
      const recorder = new MediaRecorder(mixer.stream, {
        mimeType: format.mimeType,
        audioBitsPerSecond: RECORDING_BITS_PER_SECOND,
      });
      chunksRef.current = [];
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      });
      // If the browser stops the recorder on its own, save what was captured.
      recorder.addEventListener('error', () => void stop());
      recorder.start(1000);
      recorderRef.current = recorder;
      mixerRef.current = mixer;
      dispatch({ type: 'started', at: Date.now() });
    } catch (error) {
      await mixer.close();
      dispatch({ type: 'start_failed', error: errorMessage(error, "Recording couldn't start.") });
    }
  }, [format, stop]);

  const discard = useCallback(
    async (reason: string) => {
      await finishCapture();
      pendingFileRef.current = null;
      dispatch({ type: 'discard', reason });
    },
    [finishCapture],
  );

  const retryUpload = useCallback(() => {
    if (pendingFileRef.current) void upload(pendingFileRef.current);
  }, [upload]);

  // Leaving the call ends the recording: save what was captured.
  useEffect(() => {
    if (!room && stateRef.current.phase === 'recording') void stop();
  }, [room, stop]);

  // Unmounting mid-recording (navigating away) releases the microphone mix.
  useEffect(
    () => () => {
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      void mixerRef.current?.close();
    },
    [],
  );

  const busy = isRecordingBusy(state);
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  // Transcription: realtime events first, with a slow poll in case the socket is down.
  const transcribingId = state.phase === 'transcribing' ? state.recordingId : null;
  const failTranscription = useCallback((recordingId: number, error: string) => {
    dispatch({
      type: 'transcription_failed',
      recordingId,
      error: error || "The recording couldn't be transcribed. You can still write the note yourself.",
    });
  }, []);

  useRealtimeEvent(['recording.processed', 'recording.failed'], (event) => {
    const current = stateRef.current;
    if (current.phase !== 'transcribing' || event.data.recording_id !== current.recordingId) return;
    if (event.type === 'recording.processed' && typeof event.data.note_id === 'number') {
      dispatch({ type: 'processed', recordingId: current.recordingId, noteId: event.data.note_id });
      return;
    }
    telehealthApi
      .recording(current.recordingId)
      .then((recordingInfo) => failTranscription(current.recordingId, recordingInfo.error))
      .catch(() => failTranscription(current.recordingId, ''));
  });

  const statusQuery = useQuery({
    queryKey: telehealthKeys.recording(transcribingId ?? 0),
    queryFn: () => telehealthApi.recording(transcribingId ?? 0),
    enabled: transcribingId !== null,
    refetchInterval: 10_000,
  });
  useEffect(() => {
    const info = statusQuery.data;
    if (!info || info.id !== transcribingId) return;
    if (info.status === 'transcribed' && info.note_id !== null) {
      dispatch({ type: 'processed', recordingId: info.id, noteId: info.note_id });
    } else if (info.status === 'failed') {
      failTranscription(info.id, info.error);
    }
  }, [statusQuery.data, transcribingId, failTranscription]);

  return { state, format, start, stop, stopAndUpload, discard, retryUpload };
}
