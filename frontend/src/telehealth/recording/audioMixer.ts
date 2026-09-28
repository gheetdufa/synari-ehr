/**
 * Mixes every audio track in the call (the host's microphone plus each remote participant)
 * into one MediaStream with WebAudio, so a single MediaRecorder captures the whole session.
 */

/** The parts of AudioContext the mixer uses; tests pass a fake. */
export interface MixerContext {
  createMediaStreamSource(stream: MediaStream): AudioNode;
  createMediaStreamDestination(): MediaStreamAudioDestinationNode;
  resume(): Promise<void>;
  close(): Promise<void>;
}

export class SessionAudioMixer {
  private readonly sources = new Map<string, AudioNode>();
  private readonly destination: MediaStreamAudioDestinationNode;

  constructor(
    private readonly context: MixerContext,
    private readonly streamFor: (track: MediaStreamTrack) => MediaStream,
  ) {
    this.destination = context.createMediaStreamDestination();
  }

  /** The mixed output to record. */
  get stream(): MediaStream {
    return this.destination.stream;
  }

  /** How many tracks are currently mixed in. */
  get trackCount(): number {
    return this.sources.size;
  }

  /** Resume the context (it may start suspended until a user gesture). */
  resume(): Promise<void> {
    return this.context.resume();
  }

  /**
   * Make the mix contain exactly these tracks: new ones are connected, ones that left or ended are
   * disconnected. Safe to call as often as the call's tracks change.
   */
  sync(tracks: MediaStreamTrack[]): void {
    const live = new Map<string, MediaStreamTrack>();
    for (const track of tracks) {
      if (track.kind === 'audio' && track.readyState !== 'ended') live.set(track.id, track);
    }
    for (const [id, source] of this.sources) {
      if (live.has(id)) continue;
      source.disconnect();
      this.sources.delete(id);
    }
    for (const [id, track] of live) {
      if (this.sources.has(id)) continue;
      const source = this.context.createMediaStreamSource(this.streamFor(track));
      source.connect(this.destination);
      this.sources.set(id, source);
    }
  }

  async close(): Promise<void> {
    for (const source of this.sources.values()) source.disconnect();
    this.sources.clear();
    await this.context.close().catch(() => undefined);
  }
}

/** A mixer backed by the browser's AudioContext, or null where WebAudio isn't available. */
export function createSessionMixer(): SessionAudioMixer | null {
  if (typeof window === 'undefined' || typeof window.AudioContext !== 'function' || typeof MediaStream !== 'function') {
    return null;
  }
  return new SessionAudioMixer(new window.AudioContext(), (track) => new MediaStream([track]));
}

export interface RecordingFormat {
  mimeType: string;
  /** File extension the API accepts for this format. */
  extension: 'webm' | 'm4a' | 'ogg';
}

const FORMATS: RecordingFormat[] = [
  { mimeType: 'audio/webm;codecs=opus', extension: 'webm' },
  { mimeType: 'audio/webm', extension: 'webm' },
  { mimeType: 'audio/mp4;codecs=mp4a.40.2', extension: 'm4a' },
  { mimeType: 'audio/mp4', extension: 'm4a' },
  { mimeType: 'audio/ogg;codecs=opus', extension: 'ogg' },
];

/** The first recording format the browser supports: Opus in WebM, else AAC in MP4 (Safari). */
export function pickRecordingFormat(isTypeSupported: (mimeType: string) => boolean): RecordingFormat | null {
  return FORMATS.find((format) => isTypeSupported(format.mimeType)) ?? null;
}

/** The format this browser will record in, or null if it can't record session audio at all. */
export function browserRecordingFormat(): RecordingFormat | null {
  if (typeof MediaRecorder !== 'function' || typeof MediaRecorder.isTypeSupported !== 'function') return null;
  if (typeof window === 'undefined' || typeof window.AudioContext !== 'function') return null;
  return pickRecordingFormat((mimeType) => MediaRecorder.isTypeSupported(mimeType));
}

/** Low bitrate speech audio keeps a two-hour session well under the API's 50 MB upload limit. */
export const RECORDING_BITS_PER_SECOND = 32_000;
