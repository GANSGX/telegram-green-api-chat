import { afterEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { createApp, type ServerOptions } from './app.js';
import { type Fetch } from './green-api.js';
import { MAX_MEDIA_BYTES } from './media.js';

const credentials = {
  apiUrl: 'https://4100.api.green-api.com',
  idInstance: '4100000000',
  apiTokenInstance: 'never-expose-this-secret-token',
};
const readySettings = {
  typeInstance: 'telegram',
  webhookUrl: '',
  incomingWebhook: 'yes',
  outgoingWebhook: 'yes',
  outgoingMessageWebhook: 'yes',
  outgoingAPIMessageWebhook: 'yes',
};
type Handler = (init?: RequestInit, url?: string) => Response | Promise<Response>;
const fixtures: { server: Server; close: () => void }[] = [];

function mockProvider(overrides: Record<string, Handler> = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = new URL(url).pathname.split('/')[2];
    if (overrides[method]) return overrides[method](init, url);
    if (method === 'getStateInstance') return Response.json({ stateInstance: 'authorized' });
    if (method === 'getSettings') return Response.json(readySettings);
    if (method === 'sendMessage') return Response.json({ idMessage: 'provider-message-1' });
    if (method === 'checkAccount')
      return Response.json({ exist: true, chatId: '777', username: '@friend' });
    if (method === 'receiveNotification') return Response.json(null);
    if (method === 'deleteNotification') return Response.json({ result: true });
    if (method === 'setSettings') return Response.json({ saveSettings: true });
    throw new Error('Unexpected test method');
  });
}

async function setup(overrides: Record<string, Handler> = {}, options: ServerOptions = {}) {
  const provider = mockProvider(overrides);
  const service = createApp({
    fetch: provider as Fetch,
    polling: false,
    eventWaitMs: 20,
    ...options,
  });
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  fixtures.push({ server, close: service.close });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (
    path: string,
    opts: {
      method?: string;
      body?: unknown;
      cookie?: string;
      origin?: string;
      headers?: Record<string, string>;
    } = {},
  ) =>
    fetch(`${base}/api${path}`, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(opts.cookie ? { Cookie: opts.cookie } : {}),
        ...(opts.origin ? { Origin: opts.origin } : {}),
        ...opts.headers,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  const login = async (body = credentials) => {
    const response = await request('/session', { body });
    expect(response.status).toBe(200);
    return response.headers.get('set-cookie')!.split(';')[0];
  };
  const calls = (method: string) =>
    provider.mock.calls.filter(([url]) => new URL(String(url)).pathname.split('/')[2] === method);
  return { request, login, provider, calls, base };
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.close();
    fixture.server.closeAllConnections();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
});

describe('session and request security', () => {
  it('keeps credentials server-side and returns an opaque HttpOnly SameSite cookie', async () => {
    const { request } = await setup();
    const response = await request('/session', { body: credentials });
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/api');
    expect(cookie).not.toContain(credentials.apiTokenInstance);
    expect(await response.json()).toEqual({
      authenticated: true,
      instanceId: '4100000000',
      state: 'authorized',
      notificationsEnabled: true,
    });
    const anonymous = await request('/session');
    expect(await anonymous.json()).toEqual({ authenticated: false });
  });

  it.each([
    'http://4100.api.green-api.com',
    'https://localhost',
    'https://4100.api.green-api.com.evil.test',
    'https://4100.api.green-api.com@evil.test',
    'https://4100.api.green-api.com/private',
    'https://4100.api.green-api.com:443',
  ])('rejects an unsafe API URL %s before any network request', async (apiUrl) => {
    const { request, provider } = await setup();
    const response = await request('/session', { body: { ...credentials, apiUrl } });
    expect(response.status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });

  it('rejects foreign origins, cross-site requests, DNS rebinding hosts and non-JSON mutations', async () => {
    const { request, provider, base } = await setup();
    expect(
      (await request('/session', { body: credentials, origin: 'https://evil.test' })).status,
    ).toBe(403);
    expect(
      (
        await request('/session', {
          body: credentials,
          headers: { 'Sec-Fetch-Site': 'cross-site' },
        })
      ).status,
    ).toBe(403);
    // fetch intentionally ignores a custom Host header. A raw HTTP request exercises DNS rebinding.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        `${base}/api/session`,
        { method: 'POST', headers: { Host: 'evil.test', 'Content-Type': 'application/json' } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(credentials));
    });
    expect(status).toBe(403);
    expect((await request('/session', { method: 'POST' })).status).toBe(415);
    expect(provider).not.toHaveBeenCalled();
  });

  it('allows one consumer per instance and releases its reservation at logout', async () => {
    const { request, login } = await setup();
    const cookie = await login();
    const duplicate = await request('/session', {
      body: { ...credentials, apiUrl: 'https://4200.api.green-api.com' },
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: { code: 'INSTANCE_IN_USE' } });
    expect((await request('/session', { method: 'DELETE', cookie })).status).toBe(200);
    expect((await request('/events', { cookie })).status).toBe(401);
    await login();
  });

  it('rejects a WhatsApp instance and does not retain the failed session', async () => {
    const { request } = await setup({
      getSettings: () => Response.json({ ...readySettings, typeInstance: 'whatsapp' }),
    });
    const response = await request('/session', { body: credentials });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'WRONG_MESSENGER' } });
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('never overwrites an existing webhook integration', async () => {
    const { request, login, calls } = await setup({
      getSettings: () =>
        Response.json({ ...readySettings, webhookUrl: 'https://existing.example/hook' }),
    });
    const cookie = await login();
    const response = await request('/session/notifications', { body: {}, cookie });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'WEBHOOK_CONFIGURED' } });
    expect(calls('setSettings')).toHaveLength(0);
  });

  it('bounds session count', async () => {
    const { request, login } = await setup({}, { maxSessions: 1 });
    await login();
    expect(
      (await request('/session', { body: { ...credentials, idInstance: '4100000001' } })).status,
    ).toBe(503);
  });

  it('releases a pending login when the browser abandons the connection', async () => {
    let first = true;
    let complete!: (response: Response) => void;
    const { base, provider, login } = await setup({
      getSettings: () => {
        if (!first) return Response.json(readySettings);
        first = false;
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    });
    const controller = new AbortController();
    const abandoned = fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
      signal: controller.signal,
    }).catch(() => null);
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(2));
    controller.abort();
    await abandoned;
    await new Promise((resolve) => setTimeout(resolve, 20));
    complete(Response.json(readySettings));
    await login();
  });

  it('enables documented string flags and reports the provider restart as pending', async () => {
    const { request, login, calls } = await setup({
      getSettings: () => Response.json({ ...readySettings, incomingWebhook: 'no' }),
    });
    const cookie = await login();
    const response = await request('/session/notifications', { body: {}, cookie });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      authenticated: true,
      state: 'starting',
      notificationsEnabled: false,
    });
    expect(JSON.parse(calls('setSettings')[0][1]!.body as string)).toEqual({
      incomingWebhook: 'yes',
      outgoingWebhook: 'yes',
      outgoingMessageWebhook: 'yes',
      outgoingAPIMessageWebhook: 'yes',
      stateWebhook: 'yes',
    });
  });
});

describe('recipient resolution', () => {
  it('resolves phone numbers to canonical chat IDs and keeps usernames in the provider contract', async () => {
    const { request, login, calls } = await setup();
    const cookie = await login();
    expect(
      await (
        await request('/chats/resolve', { body: { recipient: '+7 (999) 123-45-67' }, cookie })
      ).json(),
    ).toEqual({ chatId: '777', name: '@friend' });
    await request('/chats/resolve', { body: { recipient: '@friend' }, cookie });
    expect(JSON.parse(calls('checkAccount')[0][1]!.body as string)).toEqual({
      phoneNumber: 79991234567,
    });
    expect(JSON.parse(calls('checkAccount')[1][1]!.body as string)).toEqual({
      username: '@friend',
    });
  });
  it('explains the hidden-phone case and handles semantic HTTP-200 rate limit failures', async () => {
    let rateLimit = false;
    const { request, login } = await setup({
      checkAccount: () =>
        Response.json(
          rateLimit
            ? { status: false, data: { reason: 'rate_limit_exceeded' } }
            : { exist: false, chatId: '' },
        ),
    });
    const cookie = await login();
    const missing = await request('/chats/resolve', { body: { recipient: '@friend' }, cookie });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.message).toContain('приватности');
    rateLimit = true;
    expect(
      (await request('/chats/resolve', { body: { recipient: '@friend' }, cookie })).status,
    ).toBe(429);
  });
});

describe('send idempotency and uncertain outcomes', () => {
  const message = { chatId: '777', message: 'Привет', clientId: 'client-intent-1' };
  it('coalesces simultaneous requests and rejects reuse with a different payload', async () => {
    let complete!: (response: Response) => void;
    const { request, login, calls } = await setup({
      sendMessage: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    });
    const cookie = await login();
    const first = request('/messages', { body: message, cookie });
    const second = request('/messages', { body: message, cookie });
    await vi.waitFor(() => expect(calls('sendMessage')).toHaveLength(1));
    complete(Response.json({ idMessage: 'telegram-id' }));
    expect(await (await first).json()).toEqual({ idMessage: 'telegram-id' });
    expect(await (await second).json()).toEqual({ idMessage: 'telegram-id' });
    expect(await (await request('/messages', { body: message, cookie })).json()).toEqual({
      idMessage: 'telegram-id',
    });
    expect(
      (await request('/messages', { body: { ...message, message: 'Другое' }, cookie })).status,
    ).toBe(409);
    expect(calls('sendMessage')).toHaveLength(1);
  });
  it('retains an ambiguous send outcome and never retries it implicitly or leaks secret URL errors', async () => {
    const { request, login, calls } = await setup({
      sendMessage: () => {
        throw new Error(`Network failed ${credentials.apiTokenInstance}`);
      },
    });
    const cookie = await login();
    const response = await request('/messages', { body: message, cookie });
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toMatchObject({
      error: { code: 'SEND_UNCERTAIN', ambiguous: true, retryable: false },
    });
    expect(JSON.stringify(body)).not.toContain(credentials.apiTokenInstance);
    expect((await request('/messages', { body: message, cookie })).status).toBe(502);
    expect(calls('sendMessage')).toHaveLength(1);
  });
  it('permits an explicit retry after an unambiguous provider rejection', async () => {
    let rejected = true;
    const { request, login, calls } = await setup({
      sendMessage: () =>
        rejected ? new Response('', { status: 429 }) : Response.json({ idMessage: 'retry-id' }),
    });
    const cookie = await login();
    const result = await request('/messages', { body: message, cookie });
    expect(result.status).toBe(429);
    expect(await result.json()).toMatchObject({ error: { ambiguous: false, retryable: true } });
    rejected = false;
    expect(await (await request('/messages', { body: message, cookie })).json()).toEqual({
      idMessage: 'retry-id',
    });
    expect(calls('sendMessage')).toHaveLength(2);
  });
  it('rejects empty or oversized messages before sending', async () => {
    const { request, login, calls } = await setup();
    const cookie = await login();
    for (const text of ['   ', 'a'.repeat(4097)])
      expect(
        (await request('/messages', { body: { ...message, message: text }, cookie })).status,
      ).toBe(400);
    expect(calls('sendMessage')).toHaveLength(0);
  });
});

function incoming(receiptId: number, id = 'incoming-id') {
  return {
    receiptId,
    body: {
      typeWebhook: 'incomingMessageReceived',
      instanceData: { idInstance: 4100000000, typeInstance: 'telegram' },
      idMessage: id,
      timestamp: 1750000000,
      senderData: { chatId: '777', senderName: 'Собеседник' },
      messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'Ответ' } },
    },
  };
}

describe('single background queue consumer', () => {
  it('correlates an outgoing echo that arrives before the send response using the real provider message id', async () => {
    let deliver!: (response: Response) => void;
    let completeSend!: (response: Response) => void;
    let received = false;
    const { request, login, calls } = await setup(
      {
        receiveNotification: () => {
          if (received) return Response.json(null);
          received = true;
          return new Promise((resolve) => {
            deliver = resolve;
          });
        },
        sendMessage: () =>
          new Promise((resolve) => {
            completeSend = resolve;
          }),
      },
      { polling: true },
    );
    const cookie = await login();
    const send = request('/messages', {
      body: { chatId: '777', message: 'Ответ', clientId: 'intent-echo-race' },
      cookie,
    });
    await vi.waitFor(() => expect(calls('sendMessage')).toHaveLength(1));
    const echo = incoming(1, 'actual-provider-id');
    echo.body.typeWebhook = 'outgoingAPIMessageReceived';
    deliver(Response.json(echo));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls('deleteNotification')).toHaveLength(0);
    completeSend(Response.json({ idMessage: 'actual-provider-id' }));
    expect((await send).status).toBe(200);
    await vi.waitFor(() => expect(calls('deleteNotification')).toHaveLength(1));
    const result = await (await request('/events?cursor=0', { cookie })).json();
    expect(result.events.find((event: { kind: string }) => event.kind === 'message')).toMatchObject(
      { id: 'actual-provider-id', clientId: 'intent-echo-race', outgoing: true },
    );
  });

  it('retains before ack, retries only ack, deduplicates redelivery and acknowledges unsupported events', async () => {
    const order: string[] = [];
    const queue: unknown[] = [
      incoming(1),
      incoming(2),
      { receiptId: 3, body: { typeWebhook: 'unsupported' } },
    ];
    let attempts = 0;
    const { request, login, calls } = await setup(
      {
        receiveNotification: () => {
          order.push('receive');
          return Response.json(queue.shift() ?? null);
        },
        deleteNotification: (_init, url) => {
          order.push(`ack-${url!.split('/').at(-1)}`);
          attempts++;
          return attempts === 1
            ? new Response('', { status: 503 })
            : Response.json({ result: true });
        },
      },
      { polling: true, retryBaseMs: 1 },
    );
    const cookie = await login();
    await vi.waitFor(() => expect(calls('deleteNotification')).toHaveLength(4));
    const result = await (await request('/events?cursor=0', { cookie })).json();
    expect(
      result.events.filter((event: { kind: string }) => event.kind === 'message'),
    ).toHaveLength(1);
    expect(order.slice(0, 7)).toEqual([
      'receive',
      'ack-1',
      'ack-1',
      'receive',
      'ack-2',
      'receive',
      'ack-3',
    ]);
    await request('/session', { method: 'DELETE', cookie });
    const count = calls('receiveNotification').length;
    await new Promise((resolve) => setTimeout(resolve, 175));
    expect(calls('receiveNotification')).toHaveLength(count);
  });

  it('reports a cursor retention gap instead of silently dropping events', async () => {
    const queue = [incoming(1, 'a'), incoming(2, 'b'), incoming(3, 'c')];
    const { request, login, calls } = await setup(
      { receiveNotification: () => Response.json(queue.shift() ?? null) },
      { polling: true, eventRetention: 2 },
    );
    const cookie = await login();
    await vi.waitFor(() => expect(calls('deleteNotification')).toHaveLength(3));
    const response = await request('/events?cursor=0', { cookie });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'EVENTS_EXPIRED' }, cursor: 4 });
  });

  it('shares retained events across tabs without starting additional upstream pollers', async () => {
    let deliver!: (value: Response) => void;
    let calls = 0;
    const { request, login } = await setup(
      {
        receiveNotification: () => {
          calls++;
          if (calls === 1)
            return new Promise((resolve) => {
              deliver = resolve;
            });
          return Response.json(null);
        },
      },
      { polling: true, eventWaitMs: 1000 },
    );
    const cookie = await login();
    const first = request('/events?cursor=1', { cookie });
    const second = request('/events?cursor=1', { cookie });
    deliver(Response.json(incoming(1)));
    const [a, b] = await Promise.all([
      first.then((value) => value.json()),
      second.then((value) => value.json()),
    ]);
    expect(a).toEqual(b);
    expect(a.events).toHaveLength(1);
    expect(a.events[0].kind).toBe('message');
  });
});

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
function attachment(
  options: {
    bytes?: Uint8Array;
    name?: string;
    mime?: string;
    clientId?: string;
    caption?: string;
    kind?: string;
  } = {},
) {
  const form = new FormData();
  form.append('chatId', '777');
  form.append('clientId', options.clientId ?? 'media-intent-1');
  form.append('caption', options.caption ?? 'Фото');
  form.append('kind', options.kind ?? 'file');
  form.append(
    'file',
    new Blob([new Uint8Array(options.bytes ?? png)], { type: options.mime ?? 'image/png' }),
    options.name ?? 'photo.png',
  );
  return form;
}
const mediaResult = {
  idMessage: 'media-provider-id',
  urlFile: 'https://mediaout-4100.storage.yandexcloud.net/4100000000/photo.png',
};
function fileNotification(
  url = 'https://4100.api.green-api.com/download/4100/photo.png',
  id = 'media-event-id',
) {
  return {
    receiptId: 1,
    body: {
      ...incoming(1, id).body,
      messageData: {
        typeMessage: 'imageMessage',
        fileMessageData: {
          downloadUrl: url,
          fileName: 'photo.png',
          mimeType: 'image/png',
          caption: 'Фото',
        },
      },
    },
  };
}

describe('real attachment uploads and private downloads', () => {
  it('preserves Cyrillic and emoji filenames from browser multipart encoding', async () => {
    const { base, login, calls } = await setup({
      sendFileByUpload: () => Response.json(mediaResult),
    });
    const cookie = await login();
    const name = 'Привет 📎.png';
    const response = await fetch(`${base}/api/messages/media`, {
      method: 'POST',
      body: attachment({ name }),
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).media.fileName).toBe(name);
    expect((calls('sendFileByUpload')[0][1]?.body as FormData).get('fileName')).toBe(name);
  });

  it('requires a session and same-origin request before reading a multipart upload', async () => {
    const { base, calls, login } = await setup({
      sendFileByUpload: () => Response.json(mediaResult),
    });
    expect(
      (await fetch(`${base}/api/messages/media`, { method: 'POST', body: attachment() })).status,
    ).toBe(401);
    const cookie = await login();
    expect(
      (
        await fetch(`${base}/api/messages/media`, {
          method: 'POST',
          body: attachment(),
          headers: { Cookie: cookie, Origin: 'https://evil.test' },
        })
      ).status,
    ).toBe(403);
    expect(
      (await fetch(`${base}/api/session`, { method: 'POST', body: attachment() })).status,
    ).toBe(415);
    expect(calls('sendFileByUpload')).toHaveLength(0);
  });

  it('sends real multipart bytes once, coalesces duplicates and isolates text/media intent IDs', async () => {
    let complete!: (response: Response) => void;
    const { base, login, calls, request } = await setup({
      sendFileByUpload: (init) => {
        expect(init?.headers).toEqual({ Accept: 'application/json' });
        const form = init?.body as FormData;
        expect(form.get('chatId')).toBe('777');
        expect(form.get('caption')).toBe('Фото');
        expect(form.get('fileName')).toBe('photo.png');
        expect(form.get('file')).toBeInstanceOf(Blob);
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    });
    const cookie = await login();
    const send = () =>
      fetch(`${base}/api/messages/media`, {
        method: 'POST',
        body: attachment(),
        headers: { Cookie: cookie },
      });
    const first = send();
    const second = send();
    await vi.waitFor(() => expect(calls('sendFileByUpload')).toHaveLength(1));
    expect(
      new Uint8Array(
        await (
          (calls('sendFileByUpload')[0][1]?.body as FormData).get('file') as Blob
        ).arrayBuffer(),
      ),
    ).toEqual(png);
    complete(Response.json(mediaResult));
    const result = await (await first).json();
    expect(await (await second).json()).toEqual(result);
    expect(result).toMatchObject({
      idMessage: mediaResult.idMessage,
      media: { kind: 'image', mimeType: 'image/png', size: png.length },
    });
    expect(JSON.stringify(result)).not.toContain('yandexcloud');
    expect(JSON.stringify(result)).not.toContain(credentials.apiTokenInstance);
    expect(
      (
        await request('/messages', {
          body: { chatId: '777', message: 'text', clientId: 'media-intent-1' },
          cookie,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await fetch(`${base}/api/messages/media`, {
          method: 'POST',
          body: attachment({ bytes: new Uint8Array([...png, 1]) }),
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(409);
    expect(calls('sendFileByUpload')).toHaveLength(1);
  });

  it('rejects empty, oversized, duplicate-file, oversized-caption and cancelled voice requests before upstream', async () => {
    const { base, login, calls } = await setup();
    const cookie = await login();
    for (const form of [
      attachment({ bytes: new Uint8Array() }),
      attachment({ caption: 'a'.repeat(1025) }),
      attachment({ kind: 'voice' }),
    ]) {
      expect(
        (
          await fetch(`${base}/api/messages/media`, {
            method: 'POST',
            body: form,
            headers: { Cookie: cookie },
          })
        ).status,
      ).toBe(400);
    }
    const duplicate = attachment();
    duplicate.append('file', new Blob([png]), 'second.png');
    expect(
      (
        await fetch(`${base}/api/messages/media`, {
          method: 'POST',
          body: duplicate,
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${base}/api/messages/media`, {
          method: 'POST',
          body: attachment({ bytes: new Uint8Array(MAX_MEDIA_BYTES + 1) }),
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(413);
    expect(calls('sendFileByUpload')).toHaveLength(0);
  });

  it('retains ambiguous upload failures without resending', async () => {
    const { base, login, calls } = await setup({
      sendFileByUpload: () => {
        throw new Error('secret upload url');
      },
    });
    const cookie = await login();
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${base}/api/messages/media`, {
        method: 'POST',
        body: attachment(),
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({
        error: { code: 'SEND_UNCERTAIN', ambiguous: true, retryable: false },
      });
    }
    expect(calls('sendFileByUpload')).toHaveLength(1);
  });

  it('bounds simultaneous uploads before allocating a fifth file and aborts the upstream on logout', async () => {
    const signals: AbortSignal[] = [];
    const { base, login, calls, request } = await setup({
      sendFileByUpload: (init) =>
        new Promise((_resolve, reject) => {
          signals.push(init!.signal!);
          init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    });
    const cookie = await login();
    const uploads = Array.from({ length: 4 }, (_, i) =>
      fetch(`${base}/api/messages/media`, {
        method: 'POST',
        body: attachment({ clientId: `parallel-upload-${i}` }),
        headers: { Cookie: cookie },
      }),
    );
    await vi.waitFor(() => expect(calls('sendFileByUpload')).toHaveLength(4));
    expect(
      (
        await fetch(`${base}/api/messages/media`, {
          method: 'POST',
          body: attachment(),
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(429);
    await request('/session', { method: 'DELETE', cookie });
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    for (const response of await Promise.all(uploads)) expect(response.status).toBe(502);
  });

  it('normalizes media before ACK, hides provider URLs, streams bytes with range support and isolates sessions', async () => {
    const queue = [fileNotification()];
    const { base, login, request, calls } = await setup(
      {
        receiveNotification: () => Response.json(queue.shift() ?? null),
        '4100': (_init, url) => {
          expect(url).toBe('https://4100.api.green-api.com/download/4100/photo.png');
          return new Response(png, {
            headers: { 'content-type': 'text/html', 'set-cookie': 'provider-secret' },
          });
        },
      },
      { polling: true },
    );
    const cookie = await login();
    await vi.waitFor(() => expect(calls('deleteNotification')).toHaveLength(1));
    const events = await (await request('/events?cursor=0', { cookie })).json();
    const event = events.events.find((item: { kind: string }) => item.kind === 'message');
    expect(event).toMatchObject({ text: 'Фото', media: { kind: 'image', mimeType: 'image/png' } });
    expect(JSON.stringify(events)).not.toContain('green-api.com');
    expect((await fetch(`${base}${event.media.url}`)).status).toBe(401);
    const other = await login({ ...credentials, idInstance: '4100000001' });
    expect((await fetch(`${base}${event.media.url}`, { headers: { Cookie: other } })).status).toBe(
      404,
    );
    const media = await fetch(`${base}${event.media.url}`, {
      headers: { Cookie: cookie, Range: 'bytes=0-3' },
    });
    expect(media.status).toBe(206);
    expect(media.headers.get('content-range')).toBe(`bytes 0-3/${png.length}`);
    expect(media.headers.get('content-type')).toBe('image/png');
    expect(media.headers.get('cache-control')).toBe('no-store');
    expect(media.headers.get('x-content-type-options')).toBe('nosniff');
    expect(media.headers.get('set-cookie')).toBeNull();
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(png.slice(0, 4));
    expect(
      (
        await fetch(`${base}${event.media.url}`, {
          headers: { Cookie: cookie, Range: 'bytes=999-' },
        })
      ).status,
    ).toBe(416);
  });

  it('ACKs an unsupported media URL and returns unavailable media without making SSRF requests', async () => {
    const queue = [fileNotification('https://127.0.0.1/internal')];
    const { base, login, request, calls, provider } = await setup(
      { receiveNotification: () => Response.json(queue.shift() ?? null) },
      { polling: true },
    );
    const cookie = await login();
    await vi.waitFor(() => expect(calls('deleteNotification')).toHaveLength(1));
    const events = await (await request('/events?cursor=0', { cookie })).json();
    const event = events.events.find((item: { kind: string }) => item.kind === 'message');
    expect(event.media.unavailable).toBe(true);
    expect((await fetch(`${base}${event.media.url}`, { headers: { Cookie: cookie } })).status).toBe(
      410,
    );
    expect(provider.mock.calls.every(([url]) => String(url).startsWith(credentials.apiUrl))).toBe(
      true,
    );
  });

  it('queues the fifth visible attachment and aborts waiting downloads on logout', async () => {
    const queue = [fileNotification()];
    const downloads: ((response: Response) => void)[] = [];
    const { base, login, request, calls } = await setup(
      {
        receiveNotification: () => Response.json(queue.shift() ?? null),
        '4100': (init) =>
          new Promise((resolve, reject) => {
            downloads.push(resolve);
            init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      },
      { polling: true },
    );
    const cookie = await login();
    await vi.waitFor(() => expect(calls('deleteNotification')).toHaveLength(1));
    const events = await (await request('/events?cursor=0', { cookie })).json();
    const url = events.events.find((item: { kind: string }) => item.kind === 'message').media.url;
    const requests = Array.from({ length: 6 }, () =>
      fetch(`${base}${url}`, { headers: { Cookie: cookie } }),
    );
    await vi.waitFor(() => expect(downloads).toHaveLength(4));
    downloads[0](new Response(png));
    await vi.waitFor(() => expect(downloads).toHaveLength(5));
    await request('/session', { method: 'DELETE', cookie });
    const responses = await Promise.all(requests);
    expect(responses.map((value) => value.status).filter((value) => value === 200)).toHaveLength(1);
    expect(responses.every((value) => value.status !== 429)).toBe(true);
    expect(downloads).toHaveLength(5);
  });

  it('correlates an attachment echo arriving before the upload response and preserves uploaded metadata', async () => {
    let deliver!: (response: Response) => void;
    let complete!: (response: Response) => void;
    let first = true;
    const { base, request, login, calls } = await setup(
      {
        receiveNotification: () => {
          if (!first) return Response.json(null);
          first = false;
          return new Promise((resolve) => {
            deliver = resolve;
          });
        },
        sendFileByUpload: () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      },
      { polling: true },
    );
    const cookie = await login();
    const send = fetch(`${base}/api/messages/media`, {
      method: 'POST',
      body: attachment(),
      headers: { Cookie: cookie },
    });
    await vi.waitFor(() => expect(calls('sendFileByUpload')).toHaveLength(1));
    const echo = fileNotification(undefined, mediaResult.idMessage);
    echo.body.typeWebhook = 'outgoingAPIMessageReceived';
    deliver(Response.json(echo));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls('deleteNotification')).toHaveLength(0);
    complete(Response.json(mediaResult));
    const sent = await (await send).json();
    await vi.waitFor(() => expect(calls('deleteNotification')).toHaveLength(1));
    const events = await (await request('/events?cursor=0', { cookie })).json();
    const event = events.events.find((item: { kind: string }) => item.kind === 'message');
    expect(event).toMatchObject({ clientId: 'media-intent-1', media: sent.media });
  });
});
