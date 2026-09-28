import { MAX_MESSAGE_CHARS, MAX_MESSAGES, type ChatMessage, type ChatRole } from '../../api/ai';

/** One message in the on-screen conversation (kept in memory only). */
export interface ChatEntry {
  id: number;
  role: ChatRole;
  content: string;
}

/** The conversation as the assistant endpoint accepts it: the newest 40 non-empty messages, each capped. */
export function toAssistantMessages(entries: ChatEntry[]): ChatMessage[] {
  return entries
    .filter((entry) => entry.content.trim().length > 0)
    .slice(-MAX_MESSAGES)
    .map(({ role, content }) => ({ role, content: content.slice(0, MAX_MESSAGE_CHARS) }));
}
