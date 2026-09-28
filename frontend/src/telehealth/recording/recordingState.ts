/** State machine for recording a session: capture, upload, then wait for the transcription. */

export type RecordingState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'recording'; startedAt: number }
  | { phase: 'finishing' }
  | { phase: 'uploading'; progress: number }
  | { phase: 'upload_failed'; error: string }
  | { phase: 'transcribing'; recordingId: number }
  | { phase: 'ready'; recordingId: number; noteId: number }
  | { phase: 'failed'; error: string }
  | { phase: 'discarded'; reason: string };

export type RecordingAction =
  | { type: 'start' }
  | { type: 'started'; at: number }
  | { type: 'start_failed'; error: string }
  | { type: 'finish' }
  | { type: 'upload_started' }
  | { type: 'upload_progress'; progress: number }
  | { type: 'uploaded'; recordingId: number }
  | { type: 'upload_failed'; error: string }
  | { type: 'processed'; recordingId: number; noteId: number }
  | { type: 'transcription_failed'; recordingId: number; error: string }
  | { type: 'discard'; reason: string };

export const initialRecordingState: RecordingState = { phase: 'idle' };

export function recordingReducer(state: RecordingState, action: RecordingAction): RecordingState {
  switch (action.type) {
    case 'start':
      return canStartRecording(state) ? { phase: 'starting' } : state;
    case 'started':
      return state.phase === 'starting' ? { phase: 'recording', startedAt: action.at } : state;
    case 'start_failed':
      return state.phase === 'starting' ? { phase: 'failed', error: action.error } : state;
    case 'finish':
      return state.phase === 'recording' ? { phase: 'finishing' } : state;
    case 'upload_started':
      return state.phase === 'finishing' || state.phase === 'upload_failed' ? { phase: 'uploading', progress: 0 } : state;
    case 'upload_progress':
      return state.phase === 'uploading'
        ? { phase: 'uploading', progress: Math.min(1, Math.max(state.progress, action.progress)) }
        : state;
    case 'uploaded':
      return state.phase === 'uploading' ? { phase: 'transcribing', recordingId: action.recordingId } : state;
    case 'upload_failed':
      return state.phase === 'uploading' ? { phase: 'upload_failed', error: action.error } : state;
    case 'processed':
      return state.phase === 'transcribing' && state.recordingId === action.recordingId
        ? { phase: 'ready', recordingId: action.recordingId, noteId: action.noteId }
        : state;
    case 'transcription_failed':
      return state.phase === 'transcribing' && state.recordingId === action.recordingId
        ? { phase: 'failed', error: action.error }
        : state;
    case 'discard':
      return { phase: 'discarded', reason: action.reason };
  }
}

/** A new recording can start from rest, or after a previous one finished one way or another. */
export function canStartRecording(state: RecordingState): boolean {
  return state.phase === 'idle' || state.phase === 'ready' || state.phase === 'failed' || state.phase === 'discarded';
}

/** Audio exists only in this tab: leaving the page now would lose it. */
export function isRecordingBusy(state: RecordingState): boolean {
  return (
    state.phase === 'starting' ||
    state.phase === 'recording' ||
    state.phase === 'finishing' ||
    state.phase === 'uploading' ||
    state.phase === 'upload_failed'
  );
}
