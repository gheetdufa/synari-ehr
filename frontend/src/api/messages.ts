import { API_URL } from '../lib/config';
import { ApiError, api, apiPage, getAccessToken, type PageParams, type Realm } from './client';
import type { ClientRef } from './clients';

/** Which side of the conversation wrote a message: the practice or the client. */
export type SenderRole = 'staff' | 'client';
export type RiskLevel = 'none' | 'low' | 'moderate' | 'high';

/** Most characters one message may contain (matches the API). */
export const MAX_MESSAGE_LENGTH = 5000;
/** Most files one message may carry (matches the API). */
export const MAX_ATTACHMENTS = 5;
/** Messages fetched per page of a thread. */
export const MESSAGE_PAGE_SIZE = 50;
/** File types the API accepts as attachments, for the file picker. */
export const ATTACHMENT_ACCEPT =
  '.pdf,.jpg,.jpeg,.png,.gif,.webp,.heic,.txt,.csv,.doc,.docx,.mp3,.m4a,.wav,.webm,.ogg';

/** A file on a message; `id` is the file id used by the download endpoints. */
export interface MessageAttachment {
  id: number;
  filename: string;
  content_type: string;
  size_bytes: number;
}

/** A message. Removed messages have an empty body and no files. */
export interface MessageBase {
  id: number;
  conversation_id: number;
  sender_role: SenderRole;
  /**
   * Who wrote it: the staff member (the conversation's clinician for automatic replies), the
   * contact writing for the client ("Pat Rivera (for Alex)"), or null for the client's own.
   */
  sender_name: string | null;
  body: string;
  removed: boolean;
  is_automatic: boolean;
  attachments: MessageAttachment[];
  created_at: string;
  read_by_recipient: boolean;
}

/** A message as the client portal sees it. */
export interface PortalMessage extends MessageBase {
  /** The person signed in wrote it: the client, or the contact using their portal. */
  sent_by_me: boolean;
}

/** A message as staff see it: which team member or contact wrote it, and its crisis screening. */
export interface StaffMessage extends MessageBase {
  sender_staff_id: number | null;
  sender_contact_id: number | null;
  risk_level: RiskLevel;
}

/** The client's just-sent message; crisis_resources asks the portal to show 988/911 help. */
export interface PortalSentMessage extends PortalMessage {
  crisis_resources: boolean;
}

/** The clinician a conversation is with; the name includes credentials ("Jordan Lee, LCSW"). */
export interface ConversationClinician {
  id: number;
  name: string;
}

/** One row of the staff inbox: the conversation between one client and one clinician. */
export interface Conversation {
  id: number;
  client: ClientRef;
  clinician: ConversationClinician;
  last_message_at: string | null;
  /** What the conversation's clinician hasn't read; nobody else's reading counts. */
  unread_count: number;
  last_message_preview: string;
  /** An unread client message in this thread was flagged for crisis language. */
  has_urgent: boolean;
}

/** A clinician the client can message; `id` stays null until either side starts the conversation. */
export interface PortalConversation {
  id: number | null;
  clinician: ConversationClinician;
  last_message_at: string | null;
  unread_count: number;
  /** The clinician's away message while they have it switched on. */
  away_message: string | null;
}

export interface SendMessageInput {
  body: string;
  attachment_ids: number[];
}

/**
 * Filters for the staff inbox: one clinician's conversations, those with one client, or a search
 * (`q`: the client's name, email or phone).
 */
export interface ConversationListParams extends PageParams {
  clinician_id?: number;
  client_id?: number;
  q?: string;
}

export interface ThreadPageParams {
  before_id?: number;
  limit?: number;
}

export interface UploadOptions {
  /** Called with the uploaded fraction (0 to 1) as the request body is sent. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

function errorDetail(responseText: string): unknown {
  try {
    const data = JSON.parse(responseText) as { detail?: unknown };
    return data.detail ?? data;
  } catch {
    return null;
  }
}

/**
 * Multipart upload with progress events. fetch() can't report upload progress, so this uses
 * XMLHttpRequest with the same bearer token the shared client would send.
 */
async function uploadWithProgress(
  path: string,
  realm: Realm,
  file: File,
  { onProgress, signal }: UploadOptions,
): Promise<MessageAttachment> {
  if (signal?.aborted) throw new DOMException('Upload canceled', 'AbortError');
  const token = await getAccessToken(realm);
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `${API_URL}${path}`);
    if (token) request.setRequestHeader('Authorization', `Bearer ${token}`);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(event.loaded / event.total);
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        resolve(JSON.parse(request.responseText) as MessageAttachment);
      } else {
        reject(new ApiError(request.status, errorDetail(request.responseText)));
      }
    };
    request.onerror = () => reject(new ApiError(0, null));
    request.onabort = () => reject(new DOMException('Upload canceled', 'AbortError'));
    signal?.addEventListener('abort', () => request.abort(), { once: true });
    const form = new FormData();
    form.append('file', file);
    request.send(form);
  });
}

/** Where a message attachment downloads from for each kind of account. */
export function attachmentPath(realm: Realm, fileId: number): string {
  return realm === 'client' ? `/portal/files/${fileId}` : `/files/${fileId}`;
}

/** Staff messaging: every conversation you can read, each with its own thread. */
export const messagesApi = {
  /** A page of the conversations you can read, most recent first, with how many match in all. */
  conversations: (params: ConversationListParams = {}) =>
    apiPage<Conversation>('/conversations', { query: { ...params } }),
  /** One conversation you can read (404 when it's out of reach). */
  conversation: (conversationId: number) => api<Conversation>(`/conversations/${conversationId}`),
  /** Unread client messages in your own conversations. */
  unreadCount: () => api<{ count: number }>('/messages/unread-count'),
  /** Your own conversation with a client, created if it doesn't exist yet. */
  openWithClient: (clientId: number) => api<Conversation>(`/clients/${clientId}/conversations`, { method: 'POST' }),
  messages: (conversationId: number, params: ThreadPageParams = {}) =>
    api<StaffMessage[]>(`/conversations/${conversationId}/messages`, { query: { ...params } }),
  uploadAttachment: (conversationId: number, file: File, options: UploadOptions = {}) =>
    uploadWithProgress(`/conversations/${conversationId}/attachments`, 'staff', file, options),
  discardAttachment: (fileId: number) => api<void>(`/messages/attachments/${fileId}`, { method: 'DELETE' }),
  send: (conversationId: number, input: SendMessageInput) =>
    api<StaffMessage>(`/conversations/${conversationId}/messages`, { body: input }),
  markRead: (conversationId: number) => api<void>(`/conversations/${conversationId}/read`, { method: 'POST' }),
  remove: (messageId: number) => api<StaffMessage>(`/messages/${messageId}`, { method: 'DELETE' }),
};

/** Client-portal messaging: one conversation per clinician the client can message. */
export const portalMessagesApi = {
  conversations: () => api<PortalConversation[]>('/portal/conversations', { realm: 'client' }),
  /** The conversation with a care-team clinician, created if it doesn't exist yet. */
  start: (clinicianId: number) =>
    api<PortalConversation>('/portal/conversations', { realm: 'client', body: { clinician_id: clinicianId } }),
  messages: (conversationId: number, params: ThreadPageParams = {}) =>
    api<PortalMessage[]>(`/portal/conversations/${conversationId}/messages`, {
      realm: 'client',
      query: { ...params },
    }),
  uploadAttachment: (file: File, options: UploadOptions = {}) =>
    uploadWithProgress('/portal/messages/attachments', 'client', file, options),
  discardAttachment: (fileId: number) =>
    api<void>(`/portal/messages/attachments/${fileId}`, { realm: 'client', method: 'DELETE' }),
  send: (conversationId: number, input: SendMessageInput) =>
    api<PortalSentMessage>(`/portal/conversations/${conversationId}/messages`, { realm: 'client', body: input }),
  markRead: (conversationId: number) =>
    api<void>(`/portal/conversations/${conversationId}/read`, { realm: 'client', method: 'POST' }),
  remove: (messageId: number) =>
    api<PortalMessage>(`/portal/messages/${messageId}`, { realm: 'client', method: 'DELETE' }),
};

/** Staff query keys. The unread badge key (['messages', 'unread-count']) shares the prefix. */
export const messageKeys = {
  all: ['messages'] as const,
  /** Every conversation list; invalidate this after a change. */
  conversations: () => ['messages', 'conversations'] as const,
  /** The inbox, all conversations or one clinician's, optionally searched (an infinite query). */
  inbox: (params: { clinician_id?: number; q?: string }) => ['messages', 'conversations', 'inbox', params] as const,
  /** One conversation, for links to a conversation that isn't on a loaded page. */
  conversation: (conversationId: number) => ['messages', 'conversations', 'one', conversationId] as const,
  /** Every conversation you can read with one client. */
  withClient: (clientId: number) => ['messages', 'conversations', 'client', clientId] as const,
  thread: (conversationId: number) => ['messages', 'thread', conversationId] as const,
};

/** Client-portal query keys (prefixed 'portal' so sign-out clears them). */
export const portalMessageKeys = {
  all: ['portal', 'messages'] as const,
  conversations: () => ['portal', 'messages', 'conversations'] as const,
  /** null: a conversation with a clinician that hasn't started yet. */
  thread: (conversationId: number | null) => ['portal', 'messages', 'thread', conversationId] as const,
};
