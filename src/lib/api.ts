import type { Credentials, EventBatch, Session } from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly ambiguous: boolean;
  readonly retryable: boolean;
  readonly cursor?: number;
  constructor(
    message: string,
    options: {
      status?: number;
      code?: string;
      ambiguous?: boolean;
      retryable?: boolean;
      cursor?: number;
    } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status ?? 0;
    this.code = options.code;
    this.ambiguous = options.ambiguous ?? false;
    this.retryable = options.retryable ?? false;
    this.cursor = options.cursor;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export async function request<T>(
  path: string,
  options: RequestInit = {},
  ambiguousOnNetworkFailure = false,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ApiError(
      ambiguousOnNetworkFailure
        ? 'Нет подтверждения отправки. Проверьте Telegram перед повторной отправкой.'
        : 'Не удалось связаться с сервером. Проверьте соединение.',
      { ambiguous: ambiguousOnNetworkFailure },
    );
  }
  let data: unknown;
  const text = await response.text();
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError('Сервер вернул некорректный ответ', {
      status: response.status,
      ambiguous: ambiguousOnNetworkFailure,
    });
  }
  if (!response.ok) {
    const detail = isRecord(data) && isRecord(data.error) ? data.error : isRecord(data) ? data : {};
    const message =
      typeof detail.message === 'string'
        ? detail.message
        : typeof detail.error === 'string'
          ? detail.error
          : 'Не удалось выполнить запрос';
    throw new ApiError(message, {
      status: response.status,
      code: typeof detail.code === 'string' ? detail.code : undefined,
      ambiguous:
        detail.ambiguous === true ||
        (ambiguousOnNetworkFailure && response.status >= 500 && detail.ambiguous !== false),
      retryable: detail.retryable === true,
      cursor: isRecord(data) && typeof data.cursor === 'number' ? data.cursor : undefined,
    });
  }
  return data as T;
}

export const api = {
  session: (signal?: AbortSignal) => request<Session>('/api/session', { signal }),
  connect: (credentials: Credentials, signal?: AbortSignal) =>
    request<Session>('/api/session', { method: 'POST', body: JSON.stringify(credentials), signal }),
  logout: () => request<void>('/api/session', { method: 'DELETE' }),
  enableNotifications: (signal?: AbortSignal) =>
    request<Session>('/api/session/notifications', { method: 'POST', body: '{}', signal }),
  resolve: (recipient: string, signal?: AbortSignal) =>
    request<{ chatId: string; name: string }>('/api/chats/resolve', {
      method: 'POST',
      body: JSON.stringify({ recipient }),
      signal,
    }),
  send: (chatId: string, message: string, clientId: string, signal?: AbortSignal) =>
    request<{ idMessage: string }>(
      '/api/messages',
      { method: 'POST', body: JSON.stringify({ chatId, message, clientId }), signal },
      true,
    ),
  events: (cursor: number, signal?: AbortSignal) =>
    request<EventBatch>(`/api/events?cursor=${encodeURIComponent(cursor)}`, { signal }),
};
