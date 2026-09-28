import { describe, expect, it, vi } from 'vitest';
import {
  browserRecordingFormat,
  createSessionMixer,
  pickRecordingFormat,
  SessionAudioMixer,
  type MixerContext,
} from './audioMixer';
import {
  canStartRecording,
  initialRecordingState,
  isRecordingBusy,
  recordingReducer,
  type RecordingAction,
  type RecordingState,
} from './recordingState';

function fakeTrack(id: string, kind = 'audio', readyState: MediaStreamTrackState = 'live'): MediaStreamTrack {
  return { id, kind, readyState } as unknown as MediaStreamTrack;
}

interface FakeNode {
  track: string;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function fakeContext() {
  const nodes: FakeNode[] = [];
  const destination = { stream: { id: 'mixed' } } as unknown as MediaStreamAudioDestinationNode;
  const context: MixerContext = {
    createMediaStreamSource: (stream) => {
      const node: FakeNode = { track: (stream as unknown as { track: string }).track, connect: vi.fn(), disconnect: vi.fn() };
      nodes.push(node);
      return node as unknown as AudioNode;
    },
    createMediaStreamDestination: () => destination,
    resume: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  const streamFor = (track: MediaStreamTrack) => ({ track: track.id }) as unknown as MediaStream;
  return { context, nodes, destination, streamFor };
}

describe('SessionAudioMixer', () => {
  it('connects each audio track once and drops tracks that leave or end', () => {
    const { context, nodes, destination, streamFor } = fakeContext();
    const mixer = new SessionAudioMixer(context, streamFor);
    expect(mixer.stream).toBe(destination.stream);

    mixer.sync([fakeTrack('mic'), fakeTrack('client'), fakeTrack('camera', 'video')]);
    expect(mixer.trackCount).toBe(2);
    expect(nodes.map((node) => node.track)).toEqual(['mic', 'client']);
    nodes.forEach((node) => expect(node.connect).toHaveBeenCalledWith(destination));

    // A participant joins later, the client leaves; the mic is untouched.
    mixer.sync([fakeTrack('mic'), fakeTrack('guest')]);
    expect(mixer.trackCount).toBe(2);
    expect(nodes[0].disconnect).not.toHaveBeenCalled();
    expect(nodes[1].disconnect).toHaveBeenCalledTimes(1);
    expect(nodes[2].track).toBe('guest');

    // A restarted microphone has ended; its node is dropped.
    mixer.sync([fakeTrack('mic', 'audio', 'ended'), fakeTrack('guest')]);
    expect(mixer.trackCount).toBe(1);
    expect(nodes[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it('disconnects everything and closes the context', async () => {
    const { context, nodes, streamFor } = fakeContext();
    const mixer = new SessionAudioMixer(context, streamFor);
    mixer.sync([fakeTrack('a'), fakeTrack('b')]);
    await mixer.close();
    expect(mixer.trackCount).toBe(0);
    nodes.forEach((node) => expect(node.disconnect).toHaveBeenCalled());
    expect(context.close).toHaveBeenCalled();
  });

  it('is unavailable without WebAudio (jsdom)', () => {
    expect(createSessionMixer()).toBeNull();
    expect(browserRecordingFormat()).toBeNull();
  });
});

describe('pickRecordingFormat', () => {
  it('prefers Opus in WebM', () => {
    expect(pickRecordingFormat(() => true)).toEqual({ mimeType: 'audio/webm;codecs=opus', extension: 'webm' });
  });

  it('falls back to MP4 audio on Safari', () => {
    const safari = (mime: string) => mime.startsWith('audio/mp4');
    expect(pickRecordingFormat(safari)?.extension).toBe('m4a');
  });

  it('returns null when nothing is supported', () => {
    expect(pickRecordingFormat(() => false)).toBeNull();
  });
});

function run(actions: RecordingAction[], from: RecordingState = initialRecordingState): RecordingState {
  return actions.reduce(recordingReducer, from);
}

describe('recordingReducer', () => {
  it('walks the happy path from start to a ready note', () => {
    const recording = run([{ type: 'start' }, { type: 'started', at: 1000 }]);
    expect(recording).toEqual({ phase: 'recording', startedAt: 1000 });
    expect(isRecordingBusy(recording)).toBe(true);

    const uploading = run([{ type: 'finish' }, { type: 'upload_started' }, { type: 'upload_progress', progress: 0.4 }], recording);
    expect(uploading).toEqual({ phase: 'uploading', progress: 0.4 });

    const transcribing = run([{ type: 'uploaded', recordingId: 7 }], uploading);
    expect(transcribing).toEqual({ phase: 'transcribing', recordingId: 7 });
    expect(isRecordingBusy(transcribing)).toBe(false);

    expect(run([{ type: 'processed', recordingId: 99, noteId: 1 }], transcribing)).toBe(transcribing);
    const ready = run([{ type: 'processed', recordingId: 7, noteId: 12 }], transcribing);
    expect(ready).toEqual({ phase: 'ready', recordingId: 7, noteId: 12 });
    expect(canStartRecording(ready)).toBe(true);
  });

  it('keeps progress monotonic', () => {
    const state = run([{ type: 'upload_progress', progress: 0.2 }], { phase: 'uploading', progress: 0.5 });
    expect(state).toEqual({ phase: 'uploading', progress: 0.5 });
  });

  it('allows retrying a failed upload', () => {
    const failed = run([{ type: 'upload_failed', error: 'offline' }], { phase: 'uploading', progress: 0.3 });
    expect(failed).toEqual({ phase: 'upload_failed', error: 'offline' });
    expect(isRecordingBusy(failed)).toBe(true);
    expect(run([{ type: 'upload_started' }], failed)).toEqual({ phase: 'uploading', progress: 0 });
  });

  it('reports transcription failures for its own recording only', () => {
    const transcribing: RecordingState = { phase: 'transcribing', recordingId: 3 };
    expect(run([{ type: 'transcription_failed', recordingId: 4, error: 'x' }], transcribing)).toBe(transcribing);
    expect(run([{ type: 'transcription_failed', recordingId: 3, error: 'No speech' }], transcribing)).toEqual({
      phase: 'failed',
      error: 'No speech',
    });
  });

  it('ignores actions that do not fit the current phase', () => {
    expect(run([{ type: 'started', at: 1 }])).toEqual(initialRecordingState);
    expect(run([{ type: 'start' }], { phase: 'recording', startedAt: 1 })).toEqual({ phase: 'recording', startedAt: 1 });
    expect(run([{ type: 'start' }], { phase: 'uploading', progress: 0.1 })).toEqual({ phase: 'uploading', progress: 0.1 });
    expect(run([{ type: 'uploaded', recordingId: 1 }], { phase: 'recording', startedAt: 1 })).toEqual({
      phase: 'recording',
      startedAt: 1,
    });
  });

  it('discards from any phase', () => {
    expect(run([{ type: 'discard', reason: 'consent withdrawn' }], { phase: 'recording', startedAt: 5 })).toEqual({
      phase: 'discarded',
      reason: 'consent withdrawn',
    });
  });
});
