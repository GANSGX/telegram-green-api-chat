export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'unknown';

export interface Chat {
  id: string;
  name: string;
  recipient?: string;
  unread: number;
}

export interface Message {
  id: string;
  clientId?: string;
  chatId: string;
  text: string;
  timestamp: number;
  outgoing: boolean;
  status: MessageStatus;
  error?: string;
}

export interface Session {
  authenticated: boolean;
  instanceId?: string;
  state?: string;
  notificationsEnabled?: boolean;
  notificationWarning?: string;
}

export interface Credentials {
  apiUrl: string;
  idInstance: string;
  apiTokenInstance: string;
}

export type ConnectionState = 'idle' | 'connected' | 'reconnecting' | 'unauthorized';
export type MessengerMode = 'login' | 'demo' | 'live';

export type MessengerEvent =
  | {
      kind: 'message';
      id: string;
      clientId?: string;
      chatId: string;
      senderName?: string;
      text: string;
      timestamp: number;
      outgoing: boolean;
    }
  | {
      kind: 'status';
      id: string;
      chatId: string;
      status: Exclude<MessageStatus, 'sending'> | 'noAccount';
      description?: string;
    }
  | { kind: 'connection'; state: Exclude<ConnectionState, 'idle'>; message?: string };

export interface EventBatch {
  cursor: number;
  events: MessengerEvent[];
}

export interface HistoryState {
  chats: Chat[];
  messages: Message[];
  activeChatId: string | null;
  drafts: Record<string, string>;
}

export const MAX_MESSAGE_LENGTH = 4096;
export const MAX_HISTORY_MESSAGES = 2000;
export const MAX_HISTORY_CHATS = 100;
