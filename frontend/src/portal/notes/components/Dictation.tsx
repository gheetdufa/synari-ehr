import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Mic, Square, Upload, X } from 'lucide-react';
import { aiApi, aiErrorMessage, isAbortError, MAX_AUDIO_BYTES } from '../../../api/ai';
import { Button } from '../../../ui/Button';
import { Spinner } from '../../../ui/Spinner';

/** Recordings stop on their own after this long, well under the 25 MB upload limit. */
const MAX_RECORDING_SECONDS = 20 * 60;

type Phase = 'idle' | 'starting' | 'recording' | 'transcribing';

function recordingSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
}

function preferredMimeType(): string | undefined {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((type) =>
    MediaRecorder.isTypeSupported(type),
  );
}

/** The transcription API detects the audio format from the file extension. */
function extensionFor(mimeType: string): string {
  if (mimeType.includes('mp4') || mimeType.includes('aac')) return 'm4a';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('wav')) return 'wav';
  return 'webm';
}

function microphoneError(error: unknown): string {
  if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
    return 'Microphone access is blocked. Allow it in your browser settings to dictate.';
  }
  if (error instanceof DOMException && error.name === 'NotFoundError') return 'No microphone was found.';
  return "Couldn't start recording. Check your microphone and try again.";
}

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Dictate (record in the browser) or upload audio, transcribe it, and hand back the text.
 * Neither the audio nor the transcript is stored by the server.
 */
export function Dictation({ onText, disabled = false }: { onText: (text: string) => void; disabled?: boolean }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const discard = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const canRecord = recordingSupported();

  const releaseMicrophone = () => {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  };

  useEffect(
    () => () => {
      discard.current = true;
      if (recorder.current?.state === 'recording') recorder.current.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
      abort.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (phase !== 'recording') return;
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [phase]);

  const transcribe = async (audio: Blob, filename: string) => {
    const controller = new AbortController();
    abort.current = controller;
    setPhase('transcribing');
    try {
      const { text } = await aiApi.transcribe(audio, filename, controller.signal);
      if (text.trim()) onTextRef.current(text.trim());
      else setError('No speech was detected in the audio.');
    } catch (failure) {
      if (!isAbortError(failure)) setError(aiErrorMessage(failure));
    } finally {
      if (abort.current === controller) abort.current = null;
      setPhase('idle');
    }
  };

  const stop = () => {
    if (recorder.current?.state === 'recording') recorder.current.stop();
  };

  useEffect(() => {
    if (phase === 'recording' && seconds >= MAX_RECORDING_SECONDS && recorder.current?.state === 'recording') {
      recorder.current.stop();
    }
  }, [phase, seconds]);

  const start = async () => {
    setError(null);
    setPhase('starting');
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = media;
      const mimeType = preferredMimeType();
      const next = new MediaRecorder(media, mimeType ? { mimeType } : undefined);
      chunks.current = [];
      discard.current = false;
      next.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.current.push(event.data);
      };
      next.onstop = () => {
        releaseMicrophone();
        recorder.current = null;
        const type = next.mimeType || mimeType || 'audio/webm';
        const audio = new Blob(chunks.current, { type });
        chunks.current = [];
        if (discard.current || audio.size === 0) {
          setPhase('idle');
          return;
        }
        void transcribe(audio, `dictation.${extensionFor(type)}`);
      };
      recorder.current = next;
      next.start(1000);
      setSeconds(0);
      setPhase('recording');
    } catch (failure) {
      releaseMicrophone();
      setError(microphoneError(failure));
      setPhase('idle');
    }
  };

  const cancel = () => {
    discard.current = true;
    if (recorder.current?.state === 'recording') recorder.current.stop();
    else abort.current?.abort();
  };

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(null);
    if (file.size > MAX_AUDIO_BYTES) {
      setError('Audio files must be under 25 MB.');
      return;
    }
    void transcribe(file, file.name);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {phase === 'recording' ? (
          <>
            <span className="inline-flex items-center gap-2 rounded-lg bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700">
              <span className="h-2 w-2 animate-pulse rounded-full bg-red-600" aria-hidden="true" />
              Recording {clock(seconds)}
            </span>
            <Button size="sm" variant="secondary" icon={<Square className="h-3.5 w-3.5" />} onClick={stop}>
              Stop and transcribe
            </Button>
            <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={cancel}>
              Discard
            </Button>
          </>
        ) : phase === 'transcribing' ? (
          <>
            <span className="inline-flex items-center gap-2 text-sm text-sage-700">
              <Spinner className="h-4 w-4 text-primary-600" /> Transcribing…
            </span>
            <Button size="sm" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            {canRecord && (
              <Button
                size="sm"
                variant="secondary"
                icon={<Mic className="h-4 w-4" />}
                loading={phase === 'starting'}
                disabled={disabled}
                onClick={() => void start()}
              >
                Dictate
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              icon={<Upload className="h-4 w-4" />}
              disabled={disabled || phase === 'starting'}
              onClick={() => fileInput.current?.click()}
            >
              Upload audio
            </Button>
            <input ref={fileInput} type="file" accept="audio/*,.m4a,.mp3,.wav,.webm,.ogg,.flac" className="hidden" onChange={upload} />
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
