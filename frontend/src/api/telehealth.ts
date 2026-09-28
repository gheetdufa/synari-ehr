import { API_URL } from '../lib/config';
import { api, ApiError, getAccessToken } from './client';
import type { ClientRef } from './clients';

/** Whether a join link can be used right now. */
export type JoinStatus = 'open' | 'too_early' | 'ended' | 'canceled';
/** A waiting-room entry's own status. */
export type WaitingStatus = 'waiting' | 'admitted' | 'declined' | 'left';
/** What polling an entry reports: its status, or the appointment's state once it can't be joined. */
export type EntryState = WaitingStatus | 'canceled' | 'ended';
export type RecordingStatus = 'uploaded' | 'transcribing' | 'transcribed' | 'failed';

/** Everything needed to connect to a LiveKit room. */
export interface RoomAccess {
  livekit_url: string;
  token: string;
  room_name: string;
  identity: string;
}

/** What anyone holding a join link may see (no client details). */
export interface JoinInfo {
  status: JoinStatus;
  starts_at: string;
  ends_at: string;
  clinician_name: string;
  practice_name: string;
  /** Show times in this zone: the client's, else the clinician's. */
  time_zone: string;
  waiting_room_enabled: boolean;
  recording_enabled: boolean;
}

export interface EnterInput {
  display_name: string;
  current_location: string;
  recording_consent: boolean;
}

export interface EnterResult {
  entry_id: number;
  secret: string;
  status: WaitingStatus;
}

/** Poll result; the room fields are set only while the entry is admitted. */
export interface EntryStatus {
  status: EntryState;
  livekit_url: string | null;
  token: string | null;
  room_name: string | null;
}

export interface WaitingRoomEntry {
  id: number;
  display_name: string;
  status: WaitingStatus;
  recording_consent: boolean;
  current_location: string;
  /** The client whose join link was used. */
  client_id: number | null;
  created_at: string;
  admitted_at: string | null;
}

/** Someone admitted to the session and whether they agreed to recording. */
export interface ConsentParticipant {
  entry_id: number;
  /** The client whose join link they used. */
  client_id: number | null;
  display_name: string;
  recording_consent: boolean;
}

export interface RecordingConsent {
  recording_enabled: boolean;
  all_consented: boolean;
  participants: ConsentParticipant[];
}

export interface RecordingCreated {
  id: number;
  status: RecordingStatus;
  created_at: string;
}

export interface Recording {
  id: number;
  appointment_id: number;
  status: RecordingStatus;
  transcript: string;
  error: string;
  note_id: number | null;
  created_at: string;
}

/** One client's own join link for an appointment. */
export interface ParticipantLink {
  client: ClientRef;
  url: string;
}

/** How one client's join link was sent. */
export interface SendLinkResult {
  client_id: number;
  email_sent: boolean;
  sms_sent: boolean;
}

/** Upload session audio with progress (0..1). fetch() can't report upload progress, so this uses XHR. */
async function uploadRecording(
  appointmentId: number,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<RecordingCreated> {
  const token = await getAccessToken('staff');
  const form = new FormData();
  form.append('file', file);
  return new Promise<RecordingCreated>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `${API_URL}/telehealth/appointments/${appointmentId}/recordings`);
    if (token) request.setRequestHeader('Authorization', `Bearer ${token}`);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(request.responseText) as unknown;
      } catch {
        body = null;
      }
      if (request.status >= 200 && request.status < 300) {
        onProgress(1);
        resolve(body as RecordingCreated);
        return;
      }
      const detail = body && typeof body === 'object' && 'detail' in body ? (body as { detail: unknown }).detail : body;
      reject(new ApiError(request.status, detail));
    };
    request.onerror = () => reject(new ApiError(0, null));
    request.send(form);
  });
}

/**
 * Staff telehealth endpoints. Only the appointment's clinician hosts (host token, waiting room,
 * recording); staff who manage the clinician's calendar may also list and send the join links.
 */
export const telehealthApi = {
  hostToken: (appointmentId: number) =>
    api<RoomAccess>(`/telehealth/appointments/${appointmentId}/host-token`, { method: 'POST' }),
  /** Each client's own join link. */
  joinLinks: (appointmentId: number) =>
    api<ParticipantLink[]>(`/telehealth/appointments/${appointmentId}/join-links`),
  /** Email (and text, with consent) one client's link, or every present client's without `clientId`. */
  sendLinks: (appointmentId: number, clientId?: number) =>
    api<SendLinkResult[]>(`/telehealth/appointments/${appointmentId}/send-link`, {
      method: 'POST',
      query: { client_id: clientId },
    }),
  waitingRoom: (appointmentId: number) =>
    api<WaitingRoomEntry[]>(`/telehealth/appointments/${appointmentId}/waiting-room`),
  admit: (entryId: number) => api<WaitingRoomEntry>(`/telehealth/entries/${entryId}/admit`, { method: 'POST' }),
  decline: (entryId: number) => api<WaitingRoomEntry>(`/telehealth/entries/${entryId}/decline`, { method: 'POST' }),
  remove: (entryId: number) => api<WaitingRoomEntry>(`/telehealth/entries/${entryId}/remove`, { method: 'POST' }),
  endSession: (appointmentId: number) =>
    api<{ detail: string }>(`/telehealth/appointments/${appointmentId}/end`, { method: 'POST' }),
  admitAll: (appointmentId: number) =>
    api<WaitingRoomEntry[]>(`/telehealth/appointments/${appointmentId}/admit-all`, { method: 'POST' }),
  recordingConsent: (appointmentId: number) =>
    api<RecordingConsent>(`/telehealth/appointments/${appointmentId}/recording-consent`),
  recording: (recordingId: number) => api<Recording>(`/telehealth/recordings/${recordingId}`),
  uploadRecording,
};

const entryPath = (entryId: number) => `/telehealth/entries/${entryId}`;

/** Public join-link endpoints. They never send credentials, even if someone is signed in. */
export const guestApi = {
  joinInfo: (token: string) => api<JoinInfo>(`/telehealth/join/${encodeURIComponent(token)}`, { realm: null }),
  enter: (token: string, input: EnterInput) =>
    api<EnterResult>(`/telehealth/join/${encodeURIComponent(token)}/enter`, { realm: null, body: input }),
  poll: (entryId: number, secret: string, signal?: AbortSignal) =>
    api<EntryStatus>(entryPath(entryId), { realm: null, query: { secret }, signal }),
  leave: (entryId: number, secret: string) =>
    api<EntryStatus>(`${entryPath(entryId)}/leave`, { realm: null, method: 'POST', query: { secret } }),
  /** Leave while the page is unloading: a beacon survives the page going away, a normal request may not. */
  leaveOnUnload(entryId: number, secret: string): void {
    const url = `${API_URL}${entryPath(entryId)}/leave?secret=${encodeURIComponent(secret)}`;
    if (typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(url)) return;
    void fetch(url, { method: 'POST', keepalive: true }).catch(() => undefined);
  },
};

export const telehealthKeys = {
  all: ['telehealth'] as const,
  waitingRoom: (appointmentId: number) => ['telehealth', 'waiting-room', appointmentId] as const,
  joinLinks: (appointmentId: number) => ['telehealth', 'join-links', appointmentId] as const,
  consent: (appointmentId: number) => ['telehealth', 'consent', appointmentId] as const,
  recording: (recordingId: number) => ['telehealth', 'recording', recordingId] as const,
  joinInfo: (token: string) => ['telehealth', 'join', token] as const,
};
