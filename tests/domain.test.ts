import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/lib/api';
import {
  addChat,
  applyEvent,
  confirmMessage,
  emptyHistory,
  nextStatus,
  selectChat,
  upsertMessage,
  type StatusLedger,
} from '../src/lib/domain';
import { parseHistory } from '../src/lib/storage';
import type { HistoryState, Message, MessengerEvent } from '../src/lib/types';

const outgoing = (overrides: Partial<Message> = {}): Message => ({
  id: 'local-1',
  clientId: 'client-1',
  chatId: '42',
  text: 'Привет',
  timestamp: 1,
  outgoing: true,
  status: 'sending',
  ...overrides,
});
const initial = (): HistoryState => ({
  ...emptyHistory(),
  chats: [{ id: '42', name: 'Мария', unread: 0 }],
  activeChatId: '42',
});
const incoming = (
  overrides: Partial<Extract<MessengerEvent, { kind: 'message' }>> = {},
): Extract<MessengerEvent, { kind: 'message' }> => ({
  kind: 'message',
  id: 'remote-1',
  chatId: '42',
  text: 'Ответ',
  timestamp: 2,
  outgoing: false,
  ...overrides,
});

describe('message delivery and deduplication', () => {
  it('does not regress a read or delivered status on late events', () => {
    expect(nextStatus('read', 'delivered')).toBe('read');
    expect(nextStatus('read', 'failed')).toBe('read');
    expect(nextStatus('delivered', 'sent')).toBe('delivered');
    expect(nextStatus('delivered', 'failed')).toBe('delivered');
    expect(nextStatus('failed', 'sent')).toBe('failed');
    expect(nextStatus('sent', 'failed')).toBe('failed');
    expect(nextStatus('unknown', 'delivered')).toBe('delivered');
  });

  it('deduplicates repeat notifications and increments unread only once', () => {
    const base = { ...initial(), activeChatId: null };
    const once = applyEvent(base, incoming());
    const twice = applyEvent(once, incoming());
    expect(twice.messages).toHaveLength(1);
    expect(twice.chats[0].unread).toBe(1);
    expect(base.chats[0].unread).toBe(0);
    expect(base.messages).toHaveLength(0);
  });

  it('does not mark active-chat or outgoing messages unread', () => {
    expect(applyEvent(initial(), incoming()).chats[0].unread).toBe(0);
    expect(
      applyEvent({ ...initial(), activeChatId: null }, incoming({ outgoing: true })).chats[0]
        .unread,
    ).toBe(0);
  });

  it('merges an outgoing echo received before the send HTTP response', () => {
    const base = { ...initial(), messages: [outgoing()] };
    const echoed = applyEvent(base, incoming({ id: 'server-1', outgoing: true, text: 'Привет' }));
    const delivered = applyEvent(echoed, {
      kind: 'status',
      id: 'server-1',
      chatId: '42',
      status: 'read',
    });
    const confirmed = confirmMessage(delivered, 'client-1', 'server-1');
    expect(confirmed.messages).toHaveLength(1);
    expect(confirmed.messages[0]).toMatchObject({
      id: 'server-1',
      clientId: 'client-1',
      status: 'read',
    });
  });

  it('merges an echo directly when the BFF knows clientId', () => {
    const messages = upsertMessage([outgoing()], outgoing({ id: 'server-1', status: 'sent' }));
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('server-1');
  });

  it('does not merge identical text that was deliberately sent twice', () => {
    const messages = upsertMessage([outgoing()], outgoing({ id: 'local-2', clientId: 'client-2' }));
    expect(messages).toHaveLength(2);
  });

  it('applies statuses that arrived before their message', () => {
    const ledger: StatusLedger = new Map();
    const readFirst = applyEvent(
      initial(),
      { kind: 'status', chatId: '42', id: 'remote-1', status: 'read' },
      ledger,
    );
    const deliveredLater = applyEvent(
      readFirst,
      { kind: 'status', chatId: '42', id: 'remote-1', status: 'delivered' },
      ledger,
    );
    expect(
      applyEvent(deliveredLater, incoming({ outgoing: true }), ledger).messages[0].status,
    ).toBe('read');
  });

  it('routes group messages by chatId and creates unknown chats', () => {
    const result = applyEvent(initial(), incoming({ chatId: '-555', senderName: 'Команда' }));
    expect(result.chats[0]).toEqual({ id: '-555', name: 'Команда', unread: 1 });
    expect(result.messages[0].chatId).toBe('-555');
  });

  it('limits history while keeping recent messages', () => {
    const messages = Array.from({ length: 2000 }, (_, index) =>
      outgoing({ id: `old-${index}`, clientId: `old-${index}`, timestamp: index }),
    );
    const result = upsertMessage(
      messages,
      outgoing({ id: 'new', clientId: 'new', timestamp: 2001 }),
    );
    expect(result).toHaveLength(2000);
    expect(result[0].id).toBe('old-1');
    expect(result.at(-1)?.id).toBe('new');
  });
});

describe('chat navigation', () => {
  it('opens an existing resolved chat without duplicating it or losing drafts', () => {
    const base = {
      ...initial(),
      chats: [{ id: '42', name: 'Мария', unread: 3 }],
      drafts: { '42': 'Неотправленный текст' },
    };
    const result = addChat(base, { id: '42', name: 'Иное имя', unread: 0 });
    expect(result.chats).toHaveLength(1);
    expect(result.chats[0].name).toBe('Мария');
    expect(result.chats[0].unread).toBe(0);
    expect(result.drafts['42']).toBe('Неотправленный текст');
  });

  it('ignores a nonexistent chat selection', () => {
    const state = initial();
    expect(selectChat(state, 'missing')).toBe(state);
  });
});

describe('private tab history restoration', () => {
  it('tolerates corrupt storage and filters invalid items', () => {
    expect(parseHistory('{garbage')).toEqual(emptyHistory());
    const parsed = parseHistory(
      JSON.stringify({
        chats: [
          { id: '42', name: 'Мария', unread: -1 },
          { id: 55, name: null },
        ],
        messages: [outgoing(), { id: 'bad', text: 99 }],
        activeChatId: 'missing',
        drafts: { '42': 'Черновик', missing: 'Не нужен' },
        apiTokenInstance: 'must-not-be-copied',
      }),
    );
    expect(parsed.chats).toHaveLength(1);
    expect(parsed.chats[0].unread).toBe(0);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.activeChatId).toBe('42');
    expect(parsed.drafts).toEqual({ '42': 'Черновик' });
    expect(parsed).not.toHaveProperty('apiTokenInstance');
  });

  it('never silently resends or marks interrupted sends as delivered', () => {
    const restored = parseHistory(JSON.stringify({ ...initial(), messages: [outgoing()] }));
    expect(restored.messages[0].status).toBe('unknown');
    expect(restored.messages[0].error).toContain('Проверьте Telegram');
  });
});

describe('browser to server API contract', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the notifications mutation as JSON and includes same-origin cookies', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ authenticated: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    await api.enableNotifications();
    expect(fetcher).toHaveBeenCalledWith(
      '/api/session/notifications',
      expect.objectContaining({
        method: 'POST',
        body: '{}',
        credentials: 'same-origin',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    );
  });

  it('deletes the same-origin session and tolerates an empty response', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(api.logout()).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith(
      '/api/session',
      expect.objectContaining({ method: 'DELETE', credentials: 'same-origin' }),
    );
  });

  it('treats loss of the send response as unknown, preventing unsafe retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Network unavailable')));
    await expect(api.send('42', 'Привет', 'client-1')).rejects.toMatchObject({
      ambiguous: true,
      status: 0,
    });
  });

  it('distinguishes definitive rejection from ambiguous provider failure', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: 'INVALID_INPUT', message: 'Проверьте чат' } }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { code: 'SEND_UNCERTAIN', message: 'Нет подтверждения', ambiguous: true },
          }),
          { status: 502 },
        ),
      );
    vi.stubGlobal('fetch', fetcher);
    await expect(api.send('42', 'Привет', 'client-1')).rejects.toMatchObject({
      ambiguous: false,
      status: 400,
    });
    await expect(api.send('42', 'Привет', 'client-2')).rejects.toMatchObject({
      ambiguous: true,
      status: 502,
    });
  });

  it('exposes expired cursor recovery without discarding the warning', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            cursor: 555,
            error: { code: 'EVENTS_EXPIRED', message: 'Часть событий недоступна' },
          }),
          { status: 409 },
        ),
      ),
    );
    const failure = await api.events(0).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ cursor: 555, code: 'EVENTS_EXPIRED', status: 409 });
  });
});
