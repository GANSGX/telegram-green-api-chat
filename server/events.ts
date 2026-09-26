export type ChatEvent =
  | {
      kind: 'message';
      id: string;
      chatId: string;
      senderName: string;
      text: string;
      timestamp: number;
      outgoing: boolean;
      clientId?: string;
    }
  | { kind: 'status'; id: string; chatId: string; status: 'sent' | 'delivered' | 'read' | 'failed' }
  | { kind: 'connection'; state: 'connected' | 'reconnecting' | 'unauthorized'; message?: string };

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
const string = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** Convert only the text/chat events supported by this app. Unknown notifications are still acknowledged. */
export function normalizeNotification(body: unknown, instanceId: string): ChatEvent | null {
  const webhook = record(body);
  if (!webhook) return null;
  const instance = record(webhook.instanceData);
  if (
    instance &&
    (String(instance.idInstance) !== instanceId || instance.typeInstance !== 'telegram')
  )
    return null;
  const id = string(webhook.idMessage);
  if (webhook.typeWebhook === 'outgoingMessageStatus') {
    const chatId = string(webhook.chatId);
    if (!id || !chatId) return null;
    const status = webhook.status === 'noAccount' ? 'failed' : webhook.status;
    if (!['sent', 'delivered', 'read', 'failed'].includes(String(status))) return null;
    return {
      kind: 'status',
      id,
      chatId,
      status: status as 'sent' | 'delivered' | 'read' | 'failed',
    };
  }
  const outgoing =
    webhook.typeWebhook === 'outgoingMessageReceived' ||
    webhook.typeWebhook === 'outgoingAPIMessageReceived';
  if (!outgoing && webhook.typeWebhook !== 'incomingMessageReceived') return null;
  const sender = record(webhook.senderData);
  const data = record(webhook.messageData);
  const chatId = string(sender?.chatId);
  if (
    !id ||
    !chatId ||
    !data ||
    typeof webhook.timestamp !== 'number' ||
    !Number.isFinite(webhook.timestamp)
  )
    return null;
  const text =
    data.typeMessage === 'textMessage'
      ? string(record(data.textMessageData)?.textMessage)
      : data.typeMessage === 'extendedTextMessage'
        ? string(record(data.extendedTextMessageData)?.text)
        : undefined;
  if (text === undefined || text.length > 65_536) return null;
  const senderName =
    string(sender?.chatName) ||
    string(sender?.senderContactName) ||
    string(sender?.senderName) ||
    chatId;
  return {
    kind: 'message',
    id,
    chatId,
    senderName,
    text,
    timestamp: webhook.timestamp * 1000,
    outgoing,
  };
}

export function eventKey(event: ChatEvent): string {
  if (event.kind === 'connection') return `connection:${event.state}:${event.message ?? ''}`;
  return `${event.kind}:${event.chatId}:${event.id}${event.kind === 'status' ? `:${event.status}` : ''}`;
}
