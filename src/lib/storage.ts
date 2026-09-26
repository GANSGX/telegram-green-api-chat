import { emptyHistory } from './domain';
import {
  MAX_HISTORY_CHATS,
  MAX_HISTORY_MESSAGES,
  MAX_MESSAGE_LENGTH,
  type Chat,
  type HistoryState,
  type Message,
  type MessageStatus,
} from './types';

const prefix = 'telegram-chat.history.v1.';
const statuses = new Set<MessageStatus>([
  'sending',
  'sent',
  'delivered',
  'read',
  'failed',
  'unknown',
]);
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isString = (value: unknown, max = 500) => typeof value === 'string' && value.length <= max;

export function parseHistory(raw: string | null): HistoryState {
  if (!raw || raw.length > 12_000_000) return emptyHistory();
  try {
    const data: unknown = JSON.parse(raw);
    if (!record(data) || !Array.isArray(data.chats) || !Array.isArray(data.messages))
      return emptyHistory();
    const chats = data.chats
      .filter(
        (chat): chat is Chat =>
          record(chat) &&
          isString(chat.id) &&
          isString(chat.name) &&
          typeof chat.unread === 'number' &&
          Number.isFinite(chat.unread) &&
          (chat.recipient === undefined || isString(chat.recipient)),
      )
      .slice(0, MAX_HISTORY_CHATS)
      .map((chat) => ({
        id: chat.id,
        name: chat.name,
        recipient: chat.recipient,
        unread: Math.max(0, Math.floor(chat.unread)),
      }));
    const ids = new Set(chats.map((chat) => chat.id));
    const messages = data.messages
      .filter(
        (message): message is Message =>
          record(message) &&
          isString(message.id) &&
          isString(message.chatId) &&
          ids.has(message.chatId as string) &&
          isString(message.text, MAX_MESSAGE_LENGTH) &&
          typeof message.timestamp === 'number' &&
          Number.isFinite(message.timestamp) &&
          typeof message.outgoing === 'boolean' &&
          statuses.has(message.status as MessageStatus) &&
          (message.clientId === undefined || isString(message.clientId)) &&
          (message.error === undefined || isString(message.error, 2000)),
      )
      .slice(-MAX_HISTORY_MESSAGES)
      .map((message) => ({
        id: message.id,
        clientId: message.clientId,
        chatId: message.chatId,
        text: message.text,
        timestamp: message.timestamp,
        outgoing: message.outgoing,
        status: message.status === 'sending' ? ('unknown' as const) : message.status,
        error:
          message.status === 'sending'
            ? 'Отправка прервалась. Проверьте Telegram перед повторной отправкой.'
            : message.error,
      }));
    const drafts: Record<string, string> = {};
    if (record(data.drafts))
      for (const [key, value] of Object.entries(data.drafts)) {
        if (ids.has(key) && typeof value === 'string' && value.length <= 100_000)
          drafts[key] = value;
      }
    return {
      chats,
      messages,
      drafts,
      activeChatId:
        typeof data.activeChatId === 'string' && ids.has(data.activeChatId)
          ? data.activeChatId
          : (chats[0]?.id ?? null),
    };
  } catch {
    return emptyHistory();
  }
}

export function loadHistory(instanceId: string): HistoryState {
  try {
    return parseHistory(sessionStorage.getItem(prefix + instanceId));
  } catch {
    return emptyHistory();
  }
}

export function saveHistory(instanceId: string, history: HistoryState): boolean {
  try {
    sessionStorage.setItem(
      prefix + instanceId,
      JSON.stringify({
        chats: history.chats.slice(0, MAX_HISTORY_CHATS),
        messages: history.messages.slice(-MAX_HISTORY_MESSAGES),
        activeChatId: history.activeChatId,
        drafts: history.drafts,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearHistory(instanceId: string): void {
  try {
    sessionStorage.removeItem(prefix + instanceId);
  } catch {
    /* Storage can be unavailable in private mode. */
  }
}
