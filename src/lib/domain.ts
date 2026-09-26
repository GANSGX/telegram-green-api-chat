import {
  MAX_HISTORY_MESSAGES,
  type Chat,
  type HistoryState,
  type Message,
  type MediaAttachment,
  type MessageStatus,
  type MessengerEvent,
} from './types';

export const emptyHistory = (): HistoryState => ({
  chats: [],
  messages: [],
  activeChatId: null,
  drafts: {},
});

const rank: Record<MessageStatus, number> = {
  sending: 0,
  unknown: 1,
  sent: 2,
  failed: 3,
  delivered: 4,
  read: 5,
};

/** Successful delivery evidence wins over late/transient failures. */
export function nextStatus(current: MessageStatus, incoming: MessageStatus): MessageStatus {
  if (current === 'read' || (current === 'delivered' && incoming !== 'read')) return current;
  if (incoming === 'failed') return 'failed';
  if (incoming === 'unknown' && rank[current] >= rank.sent) return current;
  return rank[incoming] > rank[current] ? incoming : current;
}

export function upsertMessage(messages: Message[], incoming: Message): Message[] {
  const index = messages.findIndex(
    (item) =>
      item.chatId === incoming.chatId &&
      (item.id === incoming.id ||
        Boolean(item.clientId && incoming.clientId && item.clientId === incoming.clientId)),
  );
  if (index < 0)
    return [...messages, incoming]
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-MAX_HISTORY_MESSAGES);
  const current = messages[index];
  const status = nextStatus(current.status, incoming.status);
  const merged = {
    ...current,
    ...incoming,
    clientId: incoming.clientId ?? current.clientId,
    media: incoming.media ?? current.media,
    status,
  };
  if (status !== 'failed' && status !== 'unknown') delete merged.error;
  return messages.map((message, i) => (i === index ? merged : message));
}

/** A status can arrive before its message. Keep a small, ephemeral ledger. */
export type StatusLedger = Map<string, { status: MessageStatus; description?: string }>;
export const messageKey = (chatId: string, id: string) => `${chatId}\u0000${id}`;

export function applyEvent(
  state: HistoryState,
  event: MessengerEvent,
  ledger: StatusLedger = new Map(),
): HistoryState {
  if (event.kind === 'connection') return state;
  if (event.kind === 'status') {
    const status = event.status === 'noAccount' ? 'failed' : event.status;
    const key = messageKey(event.chatId, event.id);
    const previous = ledger.get(key);
    ledger.set(key, {
      status: previous ? nextStatus(previous.status, status) : status,
      description: event.description,
    });
    if (ledger.size > 1000) ledger.delete(ledger.keys().next().value!);
    return {
      ...state,
      messages: state.messages.map((message) => {
        if (message.chatId !== event.chatId || message.id !== event.id) return message;
        const resolved = nextStatus(message.status, status);
        return {
          ...message,
          status: resolved,
          error:
            resolved === 'failed'
              ? (event.description ?? 'Telegram не смог доставить сообщение')
              : undefined,
        };
      }),
    };
  }

  const exists = state.messages.some(
    (message) =>
      message.chatId === event.chatId &&
      (message.id === event.id ||
        Boolean(message.clientId && event.clientId && message.clientId === event.clientId)),
  );
  const pendingStatus = ledger.get(messageKey(event.chatId, event.id));
  const message: Message = {
    id: event.id,
    clientId: event.clientId,
    chatId: event.chatId,
    text: event.text,
    timestamp: event.timestamp,
    outgoing: event.outgoing,
    media: event.media,
    status: pendingStatus?.status ?? (event.outgoing ? 'sent' : 'delivered'),
    error: pendingStatus?.status === 'failed' ? pendingStatus.description : undefined,
  };
  const existingChat = state.chats.find((chat) => chat.id === event.chatId);
  const increment = !event.outgoing && !exists && state.activeChatId !== event.chatId ? 1 : 0;
  const chats: Chat[] = existingChat
    ? state.chats.map((chat) =>
        chat.id === event.chatId ? { ...chat, unread: chat.unread + increment } : chat,
      )
    : [
        { id: event.chatId, name: event.senderName || event.chatId, unread: increment },
        ...state.chats,
      ];
  return { ...state, chats, messages: upsertMessage(state.messages, message) };
}

export function confirmMessage(
  state: HistoryState,
  clientId: string,
  serverId: string,
  media?: MediaAttachment,
): HistoryState {
  const optimistic = state.messages.find((message) => message.clientId === clientId);
  if (!optimistic) return state;
  // An outgoing webhook may precede the HTTP response. Fold that echo into the optimistic row.
  const echo = state.messages.find(
    (message) =>
      message.chatId === optimistic.chatId &&
      message.id === serverId &&
      message.clientId !== clientId,
  );
  const status = nextStatus(optimistic.status, echo?.status ?? 'sent');
  const updated: Message = {
    ...optimistic,
    ...echo,
    id: serverId,
    clientId,
    media: media ?? echo?.media ?? optimistic.media,
    status,
    error: undefined,
  };
  return {
    ...state,
    messages: state.messages
      .filter((message) => message !== optimistic && message !== echo)
      .concat(updated)
      .sort((a, b) => a.timestamp - b.timestamp),
  };
}

export function selectChat(state: HistoryState, chatId: string): HistoryState {
  if (!state.chats.some((chat) => chat.id === chatId)) return state;
  return {
    ...state,
    activeChatId: chatId,
    chats: state.chats.map((chat) => (chat.id === chatId ? { ...chat, unread: 0 } : chat)),
  };
}

export function addChat(state: HistoryState, chat: Chat): HistoryState {
  const existing = state.chats.find((item) => item.id === chat.id);
  return selectChat({ ...state, chats: existing ? state.chats : [chat, ...state.chats] }, chat.id);
}
