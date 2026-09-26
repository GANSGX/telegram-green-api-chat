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
import { parseHistory, saveHistory } from '../src/lib/storage';
import { attachmentValidationError, mediaKind, persistentMedia } from '../src/lib/media';
import {
  MAX_FILE_SIZE,
  type HistoryState,
  type MediaAttachment,
  type Message,
  type MessengerEvent,
} from '../src/lib/types';

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

describe('media messages and privacy', () => {
  afterEach(() => vi.unstubAllGlobals());

  const media: MediaAttachment = {
    id: 'opaque-media-1',
    kind: 'audio',
    fileName: 'sample.webm',
    mimeType: 'audio/webm',
    size: 24,
    duration: 1.5,
    url: '/api/media/opaque-media-1',
  };

  it('sends real MIME bytes with a browser-generated multipart boundary', async () => {
    const file = new File(['audio bytes'], 'sample.webm', { type: 'audio/webm' });
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ idMessage: 'provider-1', media }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetcher);
    await api.sendMedia('42', file, 'client-media-1', { caption: '' });
    const [path, options] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/messages/media');
    expect(options.method).toBe('POST');
    expect(options.credentials).toBe('same-origin');
    expect(options.headers).not.toHaveProperty('Content-Type');
    const body = options.body as FormData;
    expect(body.get('file')).toMatchObject({ name: 'sample.webm', type: 'audio/webm' });
    expect(body.get('clientId')).toBe('client-media-1');
    expect(body.get('kind')).toBe('file');
    expect(body.has('duration')).toBe(false);
    expect(body.get('caption')).toBe('');
  });

  it('does not consider ambiguous upload/send loss safe to retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Network error')));
    await expect(
      api.sendMedia('42', new File(['file'], 'note.txt'), 'client-media-1'),
    ).rejects.toMatchObject({ ambiguous: true });
  });

  it('deduplicates media-only outgoing echoes before their response', () => {
    const optimistic = outgoing({ text: '', media: { ...media, url: 'blob:local-preview' } });
    const echo = incoming({
      id: 'server-1',
      clientId: 'client-1',
      outgoing: true,
      text: '',
      media,
    });
    const echoed = applyEvent({ ...initial(), messages: [optimistic] }, echo);
    const confirmed = confirmMessage(echoed, 'client-1', 'server-1', media);
    expect(confirmed.messages).toHaveLength(1);
    expect(confirmed.messages[0]).toMatchObject({
      id: 'server-1',
      text: '',
      media,
      status: 'sent',
    });
  });

  it('retains attachments when a later text-only echo omits media metadata', () => {
    const withMedia = outgoing({ id: 'server-1', media, status: 'read' });
    const result = applyEvent(
      { ...initial(), messages: [withMedia] },
      incoming({ id: 'server-1', text: 'Привет', outgoing: true }),
    );
    expect(result.messages[0].media).toEqual(media);
    expect(result.messages[0].status).toBe('read');
  });

  it('preserves incoming media without a caption and unread deduplication', () => {
    const state = { ...initial(), activeChatId: null };
    const event = incoming({ text: '', media });
    const result = applyEvent(applyEvent(state, event), event);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].media).toEqual(media);
    expect(result.messages[0].text).toBe('');
    expect(result.chats[0].unread).toBe(1);
  });

  it.each([
    'blob:https://localhost/private-object',
    'data:audio/webm;base64,secret',
    'https://provider.example/token/file',
    '/api/media/opaque?token=secret',
    '/api/media/../session',
    '//provider.example/secret',
  ])('never persists an unapproved URL %s', (url) => {
    const stored = persistentMedia({ ...media, url });
    expect(stored).toMatchObject({ ...media, url: '' });
    expect(JSON.stringify(stored)).not.toContain(url);
  });

  it('serializes only supported media metadata and restores an expired local preview', () => {
    const setItem = vi.fn();
    vi.stubGlobal('sessionStorage', { setItem });
    const original = {
      ...media,
      url: 'blob:local-preview',
      file: new File(['secret'], 'sample.webm'),
      providerUrl: 'https://provider/secret-token',
    };
    expect(
      saveHistory('instance-1', {
        ...initial(),
        messages: [outgoing({ text: '', media: original })],
      }),
    ).toBe(true);
    const serialized = setItem.mock.calls[0][1] as string;
    expect(serialized).not.toContain('blob:');
    expect(serialized).not.toContain('secret');
    const restored = parseHistory(serialized);
    expect(restored.messages[0]).toMatchObject({
      text: '',
      status: 'unknown',
      media: { ...media, url: '' },
    });
  });

  it('keeps approved BFF URLs and unavailable markers in restored media', () => {
    const restored = parseHistory(
      JSON.stringify({
        ...initial(),
        messages: [outgoing({ status: 'sent', media: { ...media, unavailable: true } })],
      }),
    );
    expect(restored.messages[0].media).toEqual({ ...media, unavailable: true });
  });

  it('rejects empty, oversized or long-caption uploads before network I/O', () => {
    expect(attachmentValidationError({ size: 0 }, {})).toContain('пустой');
    expect(attachmentValidationError({ size: MAX_FILE_SIZE + 1 }, {})).toContain('16 МБ');
    expect(attachmentValidationError({ size: MAX_FILE_SIZE }, {})).toBeNull();
    expect(attachmentValidationError({ size: 10 }, { caption: 'a'.repeat(1025) })).toContain(
      '1024',
    );
  });

  it('uses the actual file MIME for preview types', () => {
    expect(mediaKind('image/png')).toBe('image');
    expect(mediaKind('video/webm')).toBe('video');
    expect(mediaKind('audio/webm')).toBe('audio');
    expect(mediaKind('application/pdf')).toBe('document');
  });

  it.each([
    'image/svg+xml',
    'image/svg',
    'text/html',
    'application/xhtml+xml',
    'image/unknown',
    '',
  ])('treats active or unknown MIME %s as a download-only document', (mimeType) => {
    expect(mediaKind(mimeType)).toBe('document');
  });

  it.each(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'])(
    'allows a raster preview for %s',
    (mimeType) => {
      expect(mediaKind(mimeType)).toBe('image');
    },
  );
});
