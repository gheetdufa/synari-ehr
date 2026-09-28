import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, CircleDot, FileText, Loader2, Square, UploadCloud, XCircle } from 'lucide-react';
import type { Appointment } from '../../api/appointments';
import type { RecordingConsent } from '../../api/telehealth';
import { formatElapsed } from '../sessionWindow';
import { useNow } from '../useNow';
import { linkClientName } from '../waiting/waitingRoom';
import { canStartRecording, type RecordingState } from './recordingState';
import type { SessionRecorder } from './useSessionRecorder';

const DARK_BUTTON =
  'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-300 disabled:cursor-not-allowed disabled:opacity-40';

/** Compact status for the call header: a red "Recording 12:03" dot, or upload/transcription progress. */
export function RecordingIndicator({ state }: { state: RecordingState }) {
  const now = useNow(1000);
  if (state.phase === 'recording') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-red-600/90 px-2.5 py-1 text-xs font-semibold text-white" role="status">
        <span className="h-2 w-2 animate-pulse rounded-full bg-white" aria-hidden="true" />
        Recording <span className="font-mono tabular-nums">{formatElapsed(now - state.startedAt)}</span>
      </span>
    );
  }
  if (state.phase === 'finishing' || state.phase === 'uploading') {
    const percent = state.phase === 'uploading' ? Math.round(state.progress * 100) : 0;
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-xs text-white" role="status">
        <UploadCloud className="h-3.5 w-3.5" /> Saving recording {percent}%
      </span>
    );
  }
  if (state.phase === 'upload_failed') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-400/20 px-2.5 py-1 text-xs text-amber-200" role="status">
        <AlertTriangle className="h-3.5 w-3.5" /> Recording not saved
      </span>
    );
  }
  return null;
}

/**
 * Where the recording is in its life: capture, upload, transcription, draft notes. A session with
 * several clients is drafted into one note per client, so it links to the session's notes.
 */
export function RecordingStatus({
  recorder,
  appointment,
  inCall,
}: {
  recorder: SessionRecorder;
  appointment: Pick<Appointment, 'id' | 'participants'>;
  inCall: boolean;
}) {
  const { state } = recorder;
  const severalClients = appointment.participants.length > 1;
  const now = useNow(1000);
  switch (state.phase) {
    case 'idle':
    case 'starting':
      return null;
    case 'recording':
      return (
        <div className="flex items-center gap-2 text-sm text-white">
          <CircleDot className="h-4 w-4 animate-pulse text-red-400" />
          Recording · <span className="font-mono tabular-nums">{formatElapsed(now - state.startedAt)}</span>
        </div>
      );
    case 'finishing':
    case 'uploading': {
      const percent = state.phase === 'uploading' ? Math.round(state.progress * 100) : 0;
      return (
        <div className="space-y-2 text-sm text-white">
          <p>Uploading the recording… {percent}%</p>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Upload progress">
            <div className="h-full rounded-full bg-primary-400 transition-[width]" style={{ width: `${percent}%` }} />
          </div>
          <p className="text-xs text-white/60">Keep this page open until the upload finishes.</p>
        </div>
      );
    }
    case 'upload_failed':
      return (
        <div className="space-y-3 text-sm">
          <p className="flex items-start gap-2 text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {state.error} The audio is still in this browser; try again before closing the page.
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={recorder.retryUpload} className={`${DARK_BUTTON} bg-primary-500 text-[#042f2e] hover:bg-primary-400`}>
              Try again
            </button>
            <button
              type="button"
              onClick={() => void recorder.discard('The recording was discarded.')}
              className={`${DARK_BUTTON} bg-white/10 text-white hover:bg-white/20`}
            >
              Discard recording
            </button>
          </div>
        </div>
      );
    case 'transcribing':
      return (
        <p className="flex items-start gap-2 text-sm text-white">
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary-300" />
          <span>
            Transcribing… {severalClients ? 'Draft notes for each client' : 'A draft note'} will be ready in a few
            minutes. You&apos;ll also get a notification, so you don&apos;t need to wait here.
          </span>
        </p>
      );
    case 'ready':
      return (
        <div className="space-y-3 text-sm text-white">
          <p className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-primary-300" />
            {severalClients ? 'Your draft notes are ready to review.' : 'Your draft note is ready to review.'}
          </p>
          <Link
            to={severalClients ? `/portal/notes?session=${appointment.id}` : `/portal/notes/${state.noteId}`}
            target={inCall ? '_blank' : undefined}
            rel={inCall ? 'noopener' : undefined}
            className={`${DARK_BUTTON} bg-primary-500 text-[#042f2e] hover:bg-primary-400`}
          >
            <FileText className="h-4 w-4" /> {severalClients ? 'Open draft notes' : 'Open draft note'}
          </Link>
        </div>
      );
    case 'failed':
      return (
        <p className="flex items-start gap-2 text-sm text-red-200">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" /> {state.error}
        </p>
      );
    case 'discarded':
      return <p className="text-sm text-white/70">{state.reason}</p>;
  }
}

/**
 * Recording controls for the session's host. Recording is possible only when the practice allows it
 * and everyone admitted to the session agreed; audio is captured in this browser and uploaded on stop.
 */
export function RecordingPanel({
  appointment,
  recorder,
  consent,
  consentError,
}: {
  appointment: Pick<Appointment, 'id' | 'participants'>;
  recorder: SessionRecorder;
  consent: RecordingConsent | undefined;
  consentError: unknown;
}) {
  const { state, format } = recorder;
  const participants = consent?.participants ?? [];
  const allConsented = consent?.all_consented ?? false;
  const canStart = !!format && allConsented && canStartRecording(state);
  const severalClients = appointment.participants.length > 1;

  return (
    <div className="h-full space-y-5 overflow-y-auto p-4 text-sm">
      <p className="text-white/70">
        Session audio is recorded in this browser and uploaded when you stop, then transcribed into{' '}
        {severalClients ? 'a draft note for each client' : 'a draft note'}. The audio is deleted once you sign{' '}
        {severalClients ? 'the notes' : 'the note'}.
      </p>

      <section aria-labelledby="consent-heading">
        <h3 id="consent-heading" className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">
          Consent
        </h3>
        {consentError ? (
          <p className="text-amber-200">Couldn&apos;t load consent right now. It will refresh shortly.</p>
        ) : participants.length === 0 ? (
          <p className="text-white/70">
            Admit {severalClients ? 'your clients' : 'your client'} first. Everyone admitted must agree before you can
            record.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {participants.map((participant) => {
              const clientName = linkClientName(appointment, participant.client_id);
              return (
                <li key={participant.entry_id} className="flex items-center justify-between gap-3 rounded-lg bg-white/5 px-3 py-2">
                  <span className="min-w-0">
                    <span className="block truncate text-white">{participant.display_name}</span>
                    {clientName && <span className="block truncate text-xs text-white/60">{clientName}&apos;s link</span>}
                  </span>
                  {participant.recording_consent ? (
                    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-primary-300">
                      <CheckCircle2 className="h-3.5 w-3.5" /> Agreed
                    </span>
                  ) : (
                    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-amber-300">
                      <XCircle className="h-3.5 w-3.5" /> Didn&apos;t agree
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {participants.length > 0 && !allConsented && (
          <p className="mt-2 text-xs text-amber-200">
            Recording is off for this session because not everyone agreed. You can take notes as usual.
          </p>
        )}
      </section>

      {!format && (
        <p className="rounded-lg bg-amber-400/10 px-3 py-2 text-amber-100">
          This browser can&apos;t record audio. Use a current version of Chrome, Edge, Firefox or Safari.
        </p>
      )}

      <RecordingStatus recorder={recorder} appointment={appointment} inCall />

      <div className="flex flex-wrap gap-2">
        {state.phase === 'recording' ? (
          <button type="button" onClick={() => void recorder.stop()} className={`${DARK_BUTTON} bg-red-600 text-white hover:bg-red-500`}>
            <Square className="h-4 w-4" /> Stop and save
          </button>
        ) : (
          (canStartRecording(state) || state.phase === 'starting') && (
            <button
              type="button"
              onClick={() => void recorder.start()}
              disabled={!canStart}
              className={`${DARK_BUTTON} bg-primary-500 text-[#042f2e] hover:bg-primary-400`}
            >
              <CircleDot className="h-4 w-4" />
              {state.phase === 'starting' ? 'Starting…' : state.phase === 'idle' ? 'Start recording' : 'Record again'}
            </button>
          )
        )}
      </div>
    </div>
  );
}
