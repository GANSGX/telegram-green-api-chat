import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import multer from 'multer';
import { ApiError, GreenApi, type Fetch } from './green-api.js';
import { eventKey, normalizeNotification, type ChatEvent } from './events.js';
import {
  downloadMedia,
  inspectUpload,
  MAX_MEDIA_BYTES,
  MediaRegistry,
  uploadedName,
  type Media,
} from './media.js';

const COOKIE = 'telegram_chat_session';
const credentialSchema = z
  .object({
    apiUrl: z
      .string()
      .regex(
        /^https:\/\/\d{1,10}\.api\.green-api\.com\/?$/,
        'Скопируйте API URL Telegram-инстанса из кабинета GREEN-API.',
      )
      .transform((value) => value.replace(/\/$/, '')),
    idInstance: z.string().regex(/^[1-9]\d{5,19}$/, 'ID инстанса должен содержать только цифры.'),
    apiTokenInstance: z
      .string()
      .min(10, 'Введите токен инстанса.')
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/, 'Проверьте токен инстанса.'),
  })
  .strict();
const messageSchema = z
  .object({
    chatId: z.string().regex(/^-?[1-9]\d{0,19}$/, 'Некорректный ID чата.'),
    message: z
      .string()
      .max(4096, 'Сообщение не должно превышать 4096 символов.')
      .refine((value) => value.trim().length > 0, 'Введите сообщение.'),
    clientId: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();
const mediaSchema = z
  .object({
    chatId: messageSchema.shape.chatId,
    clientId: messageSchema.shape.clientId,
    caption: z.string().max(1024, 'Подпись не должна превышать 1024 символа.').default(''),
    kind: z.literal('file').default('file'),
    duration: z
      .string()
      .regex(/^\d+(\.\d+)?$/)
      .transform(Number)
      .refine((value) => value > 0 && value <= 600, 'Запись не должна превышать 10 минут.')
      .optional(),
  })
  .strict();
type Settings = {
  typeInstance?: string;
  webhookUrl?: string;
  incomingWebhook?: string;
  outgoingWebhook?: string;
  outgoingMessageWebhook?: string;
  outgoingAPIMessageWebhook?: string;
  stateWebhook?: string;
};
type State =
  'authorized' | 'notAuthorized' | 'starting' | 'blocked' | 'suspended' | 'pendingPassword';
type Notification = { receiptId: number; body: unknown };
type SendEntry = {
  hash: string;
  chatId: string;
  idMessage?: string;
  status: 'pending' | 'complete' | 'uncertain' | 'rejected';
  promise: Promise<{ idMessage: string; media?: Media }>;
  createdAt: number;
};
type Session = {
  id: string;
  instanceId: string;
  instanceKey: string;
  api: GreenApi;
  abort: AbortController;
  state: State;
  settings: Settings;
  settingsPending: boolean;
  lastUsed: number;
  nextDiagnostic: number;
  cursor: number;
  events: { cursor: number; event: ChatEvent }[];
  seen: Set<string>;
  connectionKey: string;
  listeners: Set<() => void>;
  sends: Map<string, SendEntry>;
  media: MediaRegistry;
  notificationsChange?: Promise<void>;
};

export interface ServerOptions {
  fetch?: Fetch;
  allowedOrigins?: string[];
  sessionTtlMs?: number;
  maxSessions?: number;
  eventRetention?: number;
  eventWaitMs?: number;
  diagnosticIntervalMs?: number;
  upstreamTimeoutMs?: number;
  /** Disable the background consumer in focused request tests only. */
  polling?: boolean;
  retryBaseMs?: number;
}

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success)
    throw new ApiError(
      400,
      'INVALID_INPUT',
      result.error.issues[0]?.message || 'Проверьте введённые данные.',
    );
  return result.data;
}

function enabled(settings: Settings): boolean {
  return (
    !settings.webhookUrl &&
    [
      'incomingWebhook',
      'outgoingWebhook',
      'outgoingMessageWebhook',
      'outgoingAPIMessageWebhook',
    ].every((key) => settings[key as keyof Settings] === 'yes')
  );
}

function sessionDto(session: Session) {
  return {
    authenticated: true as const,
    instanceId: session.instanceId,
    state: session.state,
    notificationsEnabled: !session.settingsPending && enabled(session.settings),
  };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    signal.addEventListener('abort', finish, { once: true });
  });
}

function stateValue(value: unknown): State {
  if (
    typeof value !== 'string' ||
    ![
      'authorized',
      'notAuthorized',
      'starting',
      'blocked',
      'suspended',
      'pendingPassword',
    ].includes(value)
  ) {
    throw new ApiError(
      502,
      'INVALID_PROVIDER_RESPONSE',
      'GREEN-API вернул неизвестное состояние инстанса.',
    );
  }
  return value as State;
}

function connectionEvent(session: Session): ChatEvent {
  if (['notAuthorized', 'blocked', 'pendingPassword'].includes(session.state))
    return {
      kind: 'connection',
      state: 'unauthorized',
      message: 'Завершите авторизацию Telegram в кабинете GREEN-API.',
    };
  if (session.state === 'suspended')
    return {
      kind: 'connection',
      state: 'reconnecting',
      message: 'Telegram временно ограничил аккаунт.',
    };
  if (session.state === 'starting' || session.settingsPending)
    return {
      kind: 'connection',
      state: 'reconnecting',
      message: 'Инстанс запускается. Применение настроек может занять до 5 минут.',
    };
  if (session.settings.webhookUrl)
    return {
      kind: 'connection',
      state: 'reconnecting',
      message:
        'У инстанса уже настроен Webhook URL. Для этого приложения нужен отдельный инстанс или отключение вебхука в кабинете.',
    };
  if (!enabled(session.settings))
    return {
      kind: 'connection',
      state: 'reconnecting',
      message: 'Включите получение сообщений в настройках подключения.',
    };
  return { kind: 'connection', state: 'connected' };
}

export function createApp(options: ServerOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  const fetcher = options.fetch ?? globalThis.fetch;
  const sessionTtl = options.sessionTtlMs ?? 30 * 60_000;
  const maxSessions = options.maxSessions ?? 32;
  const retention = options.eventRetention ?? 512;
  const waitMs = options.eventWaitMs ?? 20_000;
  const diagnosticInterval = options.diagnosticIntervalMs ?? 15_000;
  const retryBase = options.retryBaseMs ?? 1000;
  const origins = new Set(
    options.allowedOrigins ?? [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:3001',
      'http://127.0.0.1:3001',
    ],
  );
  const allowedHostnames = new Set([...origins].map((origin) => new URL(origin).hostname));
  const sessions = new Map<string, Session>();
  // Reservation is acquired before upstream validation so concurrent logins cannot create two consumers.
  const instances = new Map<string, string>();
  const loginAttempts = new Map<string, { count: number; until: number }>();
  let activeUploads = 0;
  let activeDownloads = 0;
  const downloadWaiters: (() => void)[] = [];
  async function acquireDownload(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new ApiError(410, 'MEDIA_UNAVAILABLE', 'Загрузка вложения прервана.');
    if (downloadWaiters.length >= 64)
      throw new ApiError(429, 'DOWNLOADS_BUSY', 'Загрузка вложений занята. Попробуйте позже.');
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
      };
      const cancel = () => {
        cleanup();
        const index = downloadWaiters.indexOf(grant);
        if (index >= 0) downloadWaiters.splice(index, 1);
        reject(
          new ApiError(410, 'MEDIA_UNAVAILABLE', 'Загрузка вложения прервана. Попробуйте позже.'),
        );
      };
      const grant = () => {
        cleanup();
        activeDownloads++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          activeDownloads--;
          downloadWaiters.shift()?.();
        });
      };
      const timer = setTimeout(cancel, 60_000);
      timer.unref?.();
      signal.addEventListener('abort', cancel, { once: true });
      if (activeDownloads < 4) grant();
      else downloadWaiters.push(grant);
    });
  }
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_MEDIA_BYTES,
      files: 1,
      fields: 5,
      fieldSize: 8192,
      fieldNameSize: 64,
      parts: 6,
    },
  }).single('file');

  function publish(session: Session, event: ChatEvent) {
    if (session.abort.signal.aborted) return;
    const key = eventKey(event);
    if (event.kind === 'connection') {
      if (session.connectionKey === key) return;
      session.connectionKey = key;
    } else {
      if (session.seen.has(key)) return;
      session.seen.add(key);
      if (session.seen.size > 4096) session.seen.delete(session.seen.values().next().value!);
    }
    session.events.push({ cursor: ++session.cursor, event });
    if (session.events.length > retention)
      session.events.splice(0, session.events.length - retention);
    for (const listener of [...session.listeners]) listener();
  }

  function destroySession(session: Session) {
    session.abort.abort();
    sessions.delete(session.id);
    if (instances.get(session.instanceKey) === session.id) instances.delete(session.instanceKey);
    for (const listener of [...session.listeners]) listener();
    session.listeners.clear();
    session.events.length = 0;
    session.seen.clear();
    session.sends.clear();
    session.media.clear();
  }

  function findSession(request: Request): Session | undefined {
    const cookie = request.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE}=`));
    const id = cookie?.slice(COOKIE.length + 1);
    const session = id && /^[A-Za-z0-9_-]{43}$/.test(id) ? sessions.get(id) : undefined;
    if (session && session.lastUsed + sessionTtl < Date.now()) {
      destroySession(session);
      return undefined;
    }
    if (session) session.lastUsed = Date.now();
    return session;
  }

  function requireSession(request: Request): Session {
    const session = findSession(request);
    if (!session)
      throw new ApiError(401, 'AUTH_REQUIRED', 'Сессия завершилась. Подключите GREEN-API снова.');
    return session;
  }

  function ensureAuthorized(session: Session) {
    if (session.state !== 'authorized' || session.settingsPending)
      throw new ApiError(
        409,
        'INSTANCE_NOT_READY',
        'Инстанс ещё не готов. Проверьте его состояние в кабинете GREEN-API.',
      );
  }

  async function refreshDiagnostics(session: Session) {
    const [state, settings] = await Promise.all([
      session.api.call<{ stateInstance: unknown }>('getStateInstance'),
      session.api.call<Settings>('getSettings'),
    ]);
    if (!settings || settings.typeInstance !== 'telegram')
      throw new ApiError(
        400,
        'WRONG_MESSENGER',
        'Нужен инстанс Telegram. Проверьте тип инстанса в кабинете GREEN-API.',
      );
    session.state = stateValue(state?.stateInstance);
    session.settings = settings;
    if (session.state === 'authorized' && enabled(settings)) session.settingsPending = false;
    session.nextDiagnostic = Date.now() + diagnosticInterval;
    publish(session, connectionEvent(session));
  }

  async function poll(session: Session) {
    let failures = 0;
    let pendingReceipt: number | undefined;
    while (!session.abort.signal.aborted) {
      try {
        // An acknowledgement failure must be retried independently. Never receive or process a new item first.
        if (pendingReceipt !== undefined) {
          const answer = await session.api.call<{ result: boolean }>('deleteNotification', {
            httpMethod: 'DELETE',
            receiptId: pendingReceipt,
          });
          if (!answer || typeof answer.result !== 'boolean')
            throw new ApiError(
              502,
              'INVALID_PROVIDER_RESPONSE',
              'GREEN-API не подтвердил обработку уведомления.',
            );
          pendingReceipt = undefined; // false also means that a previously acknowledged receipt has disappeared.
          failures = 0;
          continue;
        }
        if (Date.now() >= session.nextDiagnostic) await refreshDiagnostics(session);
        if (
          session.state !== 'authorized' ||
          session.settingsPending ||
          !enabled(session.settings)
        ) {
          await delay(
            Math.max(100, Math.min(diagnosticInterval, session.nextDiagnostic - Date.now())),
            session.abort.signal,
          );
          continue;
        }
        const notification = await session.api.call<Notification | null>('receiveNotification', {
          receiveTimeout: 25,
        });
        if (notification !== null) {
          if (
            !notification ||
            !Number.isSafeInteger(notification.receiptId) ||
            notification.receiptId < 0
          ) {
            throw new ApiError(
              502,
              'INVALID_PROVIDER_RESPONSE',
              'GREEN-API вернул некорректное уведомление.',
            );
          }
          const event = normalizeNotification(
            notification.body,
            session.instanceId,
            (input, chatId, id) => session.media.register(input, chatId, id),
          );
          if (event?.kind === 'message' && event.outgoing) {
            // An API webhook may beat the send HTTP response. Wait for matching in-flight requests,
            // then correlate using the provider id, never by text alone (identical messages are valid).
            const hash = createHash('sha256')
              .update(`${event.chatId}\0${event.text}`)
              .digest('hex');
            const matching = [...session.sends.values()].filter(
              (entry) =>
                entry.status === 'pending' &&
                (event.media ? entry.chatId === event.chatId : entry.hash === hash),
            );
            if (matching.length) await Promise.allSettled(matching.map((entry) => entry.promise));
            for (const [clientId, entry] of session.sends) {
              if (entry.idMessage === event.id && entry.chatId === event.chatId) {
                event.clientId = clientId;
                if (event.media) {
                  const sent = await entry.promise.catch(() => undefined);
                  if (sent?.media) event.media = sent.media;
                }
                break;
              }
            }
          }
          // Append to retained client events before acknowledging. A retry can never duplicate the UI event.
          if (event) publish(session, event);
          pendingReceipt = notification.receiptId;
        } else {
          // Defensive pacing for providers/proxies that return an empty response without long-polling.
          await delay(150, session.abort.signal);
        }
        failures = 0;
        publish(session, connectionEvent(session));
      } catch (error) {
        if (session.abort.signal.aborted) break;
        if (error instanceof ApiError && error.status === 401) {
          session.state = 'notAuthorized';
          publish(session, connectionEvent(session));
        } else {
          publish(session, {
            kind: 'connection',
            state: 'reconnecting',
            message: 'Соединение прервано. Пробуем подключиться снова.',
          });
        }
        failures++;
        await delay(
          Math.min(30_000, retryBase * 2 ** Math.min(failures - 1, 5)) *
            (0.8 + Math.random() * 0.4),
          session.abort.signal,
        );
      }
    }
  }

  const gc = setInterval(
    () => {
      const now = Date.now();
      for (const session of sessions.values())
        if (session.lastUsed + sessionTtl < now) destroySession(session);
      for (const [ip, value] of loginAttempts) if (value.until < now) loginAttempts.delete(ip);
    },
    Math.min(sessionTtl, 60_000),
  );
  gc.unref();

  app.use('/api', (request, response, next) => {
    response.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    if (!allowedHostnames.has(request.hostname))
      return next(new ApiError(403, 'INVALID_HOST', 'Недопустимый адрес приложения.'));
    const origin = request.get('origin');
    const site = request.get('sec-fetch-site');
    if ((origin && !origins.has(origin)) || site === 'cross-site')
      return next(new ApiError(403, 'ORIGIN_REJECTED', 'Запрос с другого сайта отклонён.'));
    const isMediaUpload =
      request.method === 'POST' &&
      request.path === '/messages/media' &&
      request.is('multipart/form-data');
    if (
      ['POST', 'PUT', 'PATCH'].includes(request.method) &&
      !request.is('application/json') &&
      !isMediaUpload
    )
      return next(new ApiError(415, 'JSON_REQUIRED', 'Ожидается запрос в формате JSON.'));
    next();
  });
  app.use('/api', express.json({ limit: '24kb', strict: true }));

  app.get('/api/health', (_request, response) => response.json({ ok: true }));
  app.get('/api/session', (request, response) => {
    const session = findSession(request);
    response.json(session ? sessionDto(session) : { authenticated: false });
  });

  app.post('/api/session', async (request, response) => {
    const credentials = parse(credentialSchema, request.body);
    const ip = request.ip ?? 'local';
    const attempts = loginAttempts.get(ip);
    if (attempts && attempts.until > Date.now() && attempts.count >= 15)
      throw new ApiError(
        429,
        'LOGIN_RATE_LIMITED',
        'Слишком много попыток подключения. Подождите минуту.',
      );
    loginAttempts.set(ip, {
      count: attempts && attempts.until > Date.now() ? attempts.count + 1 : 1,
      until: attempts && attempts.until > Date.now() ? attempts.until : Date.now() + 60_000,
    });
    const current = findSession(request);
    if (current)
      throw new ApiError(409, 'ALREADY_CONNECTED', 'Сначала отключите текущее подключение.');
    if (instances.size >= maxSessions)
      throw new ApiError(503, 'CAPACITY_REACHED', 'Сервер занят. Попробуйте подключиться позже.');
    // The instance id is globally unique. Using a different regional host cannot bypass the reservation.
    const instanceKey = credentials.idInstance;
    if (instances.has(instanceKey))
      throw new ApiError(
        409,
        'INSTANCE_IN_USE',
        'Этот инстанс уже подключён в другой сессии. Отключите её, чтобы избежать конкурирующего получения сообщений.',
      );
    const id = randomBytes(32).toString('base64url');
    const abort = new AbortController();
    instances.set(instanceKey, id);
    const session: Session = {
      id,
      instanceId: credentials.idInstance,
      instanceKey,
      abort,
      api: new GreenApi(credentials, fetcher, abort.signal, options.upstreamTimeoutMs),
      state: 'starting',
      settings: {},
      settingsPending: false,
      lastUsed: Date.now(),
      nextDiagnostic: 0,
      cursor: 0,
      events: [],
      seen: new Set(),
      connectionKey: '',
      listeners: new Set(),
      sends: new Map(),
      media: new MediaRegistry(credentials.apiUrl, credentials.idInstance),
    };
    const abandonLogin = () => {
      if (response.writableFinished) return;
      destroySession(session);
    };
    response.once('close', abandonLogin);
    try {
      await refreshDiagnostics(session);
      if (abort.signal.aborted || response.destroyed) return;
      sessions.set(id, session);
      response.cookie(COOKIE, id, {
        httpOnly: true,
        sameSite: 'strict',
        secure: request.secure,
        path: '/api',
      });
      response.json(sessionDto(session));
      if (options.polling !== false) void poll(session);
    } catch (error) {
      abort.abort();
      if (instances.get(instanceKey) === id) instances.delete(instanceKey);
      response.off('close', abandonLogin);
      throw error;
    }
  });

  app.delete('/api/session', (request, response) => {
    const session = findSession(request);
    if (session) destroySession(session);
    response.clearCookie(COOKIE, {
      httpOnly: true,
      sameSite: 'strict',
      secure: request.secure,
      path: '/api',
    });
    response.json({ authenticated: false });
  });

  app.post('/api/session/notifications', async (request, response) => {
    const session = requireSession(request);
    if (!session.notificationsChange) {
      session.notificationsChange = (async () => {
        const recentDiagnostic = Date.now() < session.nextDiagnostic - diagnosticInterval + 1000;
        const settings = recentDiagnostic
          ? session.settings
          : await session.api.call<Settings>('getSettings');
        if (!settings || settings.typeInstance !== 'telegram')
          throw new ApiError(
            502,
            'INVALID_PROVIDER_RESPONSE',
            'GREEN-API вернул некорректные настройки инстанса.',
          );
        if (settings?.webhookUrl)
          throw new ApiError(
            409,
            'WEBHOOK_CONFIGURED',
            'У инстанса уже настроен Webhook URL. Приложение не изменяет существующую интеграцию. Отключите вебхук в кабинете или используйте отдельный инстанс.',
          );
        if (enabled(settings)) {
          session.settings = settings;
          return;
        }
        const result = await session.api.call<{ saveSettings: boolean }>('setSettings', {
          body: {
            incomingWebhook: 'yes',
            outgoingWebhook: 'yes',
            outgoingMessageWebhook: 'yes',
            outgoingAPIMessageWebhook: 'yes',
            stateWebhook: 'yes',
          },
        });
        if (!result?.saveSettings)
          throw new ApiError(
            502,
            'SETTINGS_NOT_SAVED',
            'GREEN-API не подтвердил изменение настроек.',
          );
        session.settingsPending = true;
        session.state = 'starting';
        session.nextDiagnostic = Date.now() + 1500;
        publish(session, connectionEvent(session));
      })();
    }
    try {
      await session.notificationsChange;
    } finally {
      session.notificationsChange = undefined;
    }
    response.json(sessionDto(session));
  });

  app.post('/api/chats/resolve', async (request, response) => {
    const session = requireSession(request);
    ensureAuthorized(session);
    const { recipient } = parse(
      z.object({ recipient: z.string().trim().min(1).max(100) }).strict(),
      request.body,
    );
    let body: { username: string } | { phoneNumber: number };
    if (recipient.startsWith('@')) {
      if (!/^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(recipient))
        throw new ApiError(400, 'INVALID_RECIPIENT', 'Проверьте имя пользователя Telegram.');
      body = { username: recipient };
    } else {
      const digits = recipient.replace(/[\s()+-]/g, '');
      if (!/^[1-9]\d{6,14}$/.test(digits) || !/^[+\d\s()-]+$/.test(recipient))
        throw new ApiError(
          400,
          'INVALID_RECIPIENT',
          'Введите международный номер телефона или @username.',
        );
      body = { phoneNumber: Number(digits) };
    }
    const result = await session.api.call<{
      exist?: boolean;
      chatId?: string;
      username?: string;
      status?: boolean;
      data?: { reason?: string };
    }>('checkAccount', { body });
    if (result?.status === false) {
      if (result.data?.reason === 'rate_limit_exceeded')
        throw new ApiError(
          429,
          'TELEGRAM_LIMITED',
          'Telegram временно ограничил поиск контактов. Попробуйте через несколько часов.',
        );
      throw new ApiError(
        409,
        'INSTANCE_NOT_READY',
        'Не удалось найти контакт. Проверьте состояние инстанса.',
      );
    }
    if (!result?.exist)
      throw new ApiError(
        404,
        'RECIPIENT_NOT_FOUND',
        'Аккаунт не найден или номер скрыт настройками приватности. Попробуйте @username.',
      );
    if (typeof result.chatId !== 'string' || !/^-?[1-9]\d{0,19}$/.test(result.chatId))
      throw new ApiError(
        502,
        'INVALID_PROVIDER_RESPONSE',
        'GREEN-API не вернул корректный ID чата.',
      );
    response.json({ chatId: result.chatId, name: result.username || recipient });
  });

  app.post('/api/messages', async (request, response) => {
    const session = requireSession(request);
    ensureAuthorized(session);
    const payload = parse(messageSchema, request.body);
    const hash = createHash('sha256').update(`${payload.chatId}\0${payload.message}`).digest('hex');
    let entry = session.sends.get(payload.clientId);
    if (entry && entry.hash !== hash)
      throw new ApiError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'Этот идентификатор отправки уже использован для другого сообщения.',
      );
    if (!entry || entry.status === 'rejected') {
      if (!entry && session.sends.size >= 2000)
        throw new ApiError(
          429,
          'SEND_LIMIT_REACHED',
          'Достигнут лимит сообщений сессии. Переподключитесь после завершения отправок.',
        );
      const next: SendEntry = {
        hash,
        chatId: payload.chatId,
        status: 'pending',
        createdAt: Date.now(),
        promise: Promise.resolve({ idMessage: '' }),
      };
      // Install the entry synchronously before starting network I/O.
      session.sends.set(payload.clientId, next);
      next.promise = (async () => {
        try {
          const result = await session.api.call<{ idMessage?: string }>('sendMessage', {
            body: { chatId: payload.chatId, message: payload.message },
          });
          if (!result || typeof result.idMessage !== 'string' || !result.idMessage)
            throw new ApiError(
              502,
              'INVALID_PROVIDER_RESPONSE',
              'GREEN-API не подтвердил отправку.',
            );
          next.status = 'complete';
          next.idMessage = result.idMessage;
          return { idMessage: result.idMessage };
        } catch (error) {
          if (!(error instanceof ApiError) || error.status >= 500) {
            next.status = 'uncertain';
            const uncertain = new ApiError(
              502,
              'SEND_UNCERTAIN',
              'Подтверждение отправки не получено. Сообщение могло уйти. Проверьте чат в Telegram перед повторной отправкой.',
            );
            Object.assign(uncertain, { ambiguous: true, retryable: false });
            throw uncertain;
          }
          next.status = 'rejected';
          Object.assign(error, { ambiguous: false, retryable: true });
          throw error;
        }
      })();
      entry = next;
    }
    response.json(await entry.promise);
  });

  app.post('/api/messages/media', async (request, response) => {
    // Authentication and origin checks precede parsing or allocating an upload buffer.
    const session = requireSession(request);
    ensureAuthorized(session);
    if (!request.is('multipart/form-data'))
      throw new ApiError(
        415,
        'MULTIPART_REQUIRED',
        'Ожидается файл в формате multipart/form-data.',
      );
    if (activeUploads >= 4)
      throw new ApiError(
        429,
        'UPLOADS_BUSY',
        'Одновременно можно загружать не более четырёх файлов.',
      );
    if (Number(request.get('content-length')) > MAX_MEDIA_BYTES + 32_768)
      throw new ApiError(413, 'MEDIA_TOO_LARGE', 'Файл не должен превышать 16 МиБ.');
    activeUploads++;
    try {
      await new Promise<void>((resolve, reject) => {
        const interrupted = () =>
          reject(new ApiError(400, 'UPLOAD_INTERRUPTED', 'Загрузка файла прервана.'));
        request.once('aborted', interrupted);
        upload(request, response, (error) => {
          request.off('aborted', interrupted);
          if (error) reject(error);
          else resolve();
        });
      });
      if (session.abort.signal.aborted)
        throw new ApiError(401, 'AUTH_REQUIRED', 'Сессия завершилась. Подключите GREEN-API снова.');
      const payload = parse(mediaSchema, request.body);
      const file = request.file;
      if (!file || !file.size) throw new ApiError(400, 'FILE_REQUIRED', 'Выберите непустой файл.');
      const fileName = uploadedName(file.originalname);
      const inspected = inspectUpload(file.buffer, file.mimetype);
      const kind = inspected.kind;
      const hash = createHash('sha256')
        .update(
          JSON.stringify([
            'media',
            payload.chatId,
            payload.caption,
            kind,
            fileName,
            inspected.mimeType,
            file.size,
            payload.duration ?? null,
            createHash('sha256').update(file.buffer).digest('hex'),
          ]),
        )
        .digest('hex');
      let entry = session.sends.get(payload.clientId);
      if (entry && entry.hash !== hash)
        throw new ApiError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'Этот идентификатор отправки уже использован для другого сообщения.',
        );
      if (!entry || entry.status === 'rejected') {
        if (!entry && session.sends.size >= 2000)
          throw new ApiError(
            429,
            'SEND_LIMIT_REACHED',
            'Достигнут лимит сообщений сессии. Переподключитесь после завершения отправок.',
          );
        const next: SendEntry = {
          hash,
          chatId: payload.chatId,
          status: 'pending',
          createdAt: Date.now(),
          promise: Promise.resolve({ idMessage: '' }),
        };
        session.sends.set(payload.clientId, next);
        next.promise = (async () => {
          try {
            const form = new FormData();
            form.append('chatId', payload.chatId);
            form.append('fileName', fileName);
            if (payload.caption) form.append('caption', payload.caption);
            // Preserve browser codec/container. Changing a file extension does not transcode audio.
            form.append(
              'file',
              new Blob([new Uint8Array(file.buffer)], { type: inspected.mimeType }),
              fileName,
            );
            const result = await session.api.call<{ idMessage?: string; urlFile?: string }>(
              'sendFileByUpload',
              { form },
            );
            if (!result || typeof result.idMessage !== 'string' || !result.idMessage)
              throw new ApiError(
                502,
                'INVALID_PROVIDER_RESPONSE',
                'GREEN-API не подтвердил отправку файла.',
              );
            next.status = 'complete';
            next.idMessage = result.idMessage;
            const media = session.media.register(
              {
                kind,
                fileName,
                mimeType: inspected.mimeType,
                downloadUrl: typeof result.urlFile === 'string' ? result.urlFile : '',
              },
              payload.chatId,
              result.idMessage,
              { size: file.size, ...(payload.duration ? { duration: payload.duration } : {}) },
              true,
            );
            return { idMessage: result.idMessage, media };
          } catch (error) {
            if (!(error instanceof ApiError) || error.status >= 500) {
              next.status = 'uncertain';
              const uncertain = new ApiError(
                502,
                'SEND_UNCERTAIN',
                'Подтверждение отправки файла не получено. Файл мог уйти. Проверьте чат в Telegram перед повторной отправкой.',
              );
              Object.assign(uncertain, { ambiguous: true, retryable: false });
              throw uncertain;
            }
            next.status = 'rejected';
            Object.assign(error, { ambiguous: false, retryable: true });
            throw error;
          }
        })();
        entry = next;
      }
      const result = await entry.promise;
      if (!response.destroyed) response.json(result);
    } finally {
      // Retain only response metadata/idempotency state. Uploaded buffers are never cached or persisted.
      request.file = undefined;
      activeUploads--;
    }
  });

  app.get('/api/media/:id', async (request, response) => {
    const session = requireSession(request);
    if (!/^[A-Za-z0-9_-]{32}$/.test(String(request.params.id)))
      throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Вложение не найдено.');
    const record = session.media.get(String(request.params.id));
    const abort = new AbortController();
    const stop = () => abort.abort();
    session.abort.signal.addEventListener('abort', stop, { once: true });
    response.once('close', stop);
    let release: (() => void) | undefined;
    try {
      // Browser media elements may fan out together. Queue them instead of permanently breaking the fifth image.
      release = await acquireDownload(abort.signal);
      const bytes = await downloadMedia(record.source!, fetcher, abort.signal);
      if (response.destroyed) return;
      const { mimeType, kind } = inspectUpload(bytes, record.media.mimeType);
      response.set({
        'Content-Type': mimeType,
        'Content-Disposition': `${kind === 'document' ? 'attachment' : 'inline'}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(record.media.fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Accept-Ranges': 'bytes',
      });
      const range = request.get('range');
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        const start = match?.[1]
          ? Number(match[1])
          : Math.max(0, bytes.length - Number(match?.[2]));
        const end =
          match?.[1] && match?.[2]
            ? Math.min(Number(match[2]), bytes.length - 1)
            : bytes.length - 1;
        if (
          !match ||
          (!match[1] && !match[2]) ||
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start > end ||
          start >= bytes.length
        ) {
          response.set('Content-Range', `bytes */${bytes.length}`).status(416).end();
          return;
        }
        response
          .set('Content-Range', `bytes ${start}-${end}/${bytes.length}`)
          .status(206)
          .send(bytes.subarray(start, end + 1));
      } else response.send(bytes);
    } finally {
      session.abort.signal.removeEventListener('abort', stop);
      response.off('close', stop);
      release?.();
    }
  });

  app.get('/api/events', async (request, response) => {
    const session = requireSession(request);
    const raw = request.query.cursor ?? '0';
    if (typeof raw !== 'string' || !/^\d{1,16}$/.test(raw))
      throw new ApiError(400, 'INVALID_CURSOR', 'Некорректный курсор событий.');
    const cursor = Number(raw);
    if (!Number.isSafeInteger(cursor) || cursor > session.cursor)
      throw new ApiError(400, 'INVALID_CURSOR', 'Некорректный курсор событий.');
    const first = session.events[0]?.cursor ?? session.cursor + 1;
    if (cursor < first - 1) {
      response.status(409).json({
        error: {
          code: 'EVENTS_EXPIRED',
          message:
            'Часть событий уже вышла из локальной очереди. Откройте Telegram для проверки полной истории.',
        },
        cursor: session.cursor,
      });
      return;
    }
    if (cursor === session.cursor) {
      if (session.listeners.size >= 16)
        throw new ApiError(429, 'TOO_MANY_POLLERS', 'Слишком много открытых подключений к чату.');
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          session.listeners.delete(finish);
          response.off('close', finish);
          resolve();
        };
        const timer = setTimeout(finish, waitMs);
        timer.unref?.();
        session.listeners.add(finish);
        response.once('close', finish);
      });
    }
    if (response.destroyed) return;
    if (session.abort.signal.aborted)
      throw new ApiError(401, 'AUTH_REQUIRED', 'Сессия завершилась. Подключите GREEN-API снова.');
    response.json({
      cursor: session.cursor,
      events: session.events.filter((item) => item.cursor > cursor).map((item) => item.event),
    });
  });

  app.use('/api', (_request, _response, next) =>
    next(new ApiError(404, 'NOT_FOUND', 'Запрошенный API метод не найден.')),
  );
  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (response.headersSent || response.destroyed) return;
    if (error instanceof ApiError) {
      const flags = error as ApiError & { ambiguous?: boolean; retryable?: boolean };
      response.status(error.status).json({
        error: {
          code: error.code,
          message: error.message,
          ...(flags.ambiguous === undefined ? {} : { ambiguous: flags.ambiguous }),
          ...(flags.retryable === undefined ? {} : { retryable: flags.retryable }),
        },
      });
      return;
    }
    if (error instanceof multer.MulterError) {
      response.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
        error: {
          code: error.code === 'LIMIT_FILE_SIZE' ? 'MEDIA_TOO_LARGE' : 'INVALID_UPLOAD',
          message:
            error.code === 'LIMIT_FILE_SIZE'
              ? 'Файл не должен превышать 16 МиБ.'
              : 'Выберите один файл и проверьте параметры загрузки.',
        },
      });
      return;
    }
    const bodyError = error as { type?: string };
    if (bodyError?.type === 'entity.too.large') {
      response
        .status(413)
        .json({ error: { code: 'BODY_TOO_LARGE', message: 'Запрос слишком большой.' } });
      return;
    }
    if (bodyError?.type === 'entity.parse.failed') {
      response.status(400).json({ error: { code: 'INVALID_JSON', message: 'Некорректный JSON.' } });
      return;
    }
    response.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Произошла ошибка сервера. Попробуйте позже.' },
    });
  };
  app.use(errorHandler);

  return {
    app,
    close() {
      clearInterval(gc);
      for (const session of [...sessions.values()]) destroySession(session);
    },
  };
}
