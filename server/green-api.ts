export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface Credentials {
  apiUrl: string;
  idInstance: string;
  apiTokenInstance: string;
}
export type Fetch = typeof globalThis.fetch;

export function providerError(status: number): ApiError {
  if (status === 401 || status === 403)
    return new ApiError(
      401,
      'PROVIDER_AUTH',
      'GREEN-API отклонил доступ. Проверьте ID инстанса и токен.',
    );
  if (status === 429)
    return new ApiError(
      429,
      'RATE_LIMITED',
      'Слишком много запросов. Подождите немного и попробуйте снова.',
    );
  if (status === 469)
    return new ApiError(
      429,
      'TELEGRAM_LIMITED',
      'Telegram временно ограничил поиск контактов. Попробуйте через несколько часов.',
    );
  if (status === 400)
    return new ApiError(
      400,
      'PROVIDER_REJECTED',
      'GREEN-API отклонил запрос. Проверьте данные и настройки инстанса.',
    );
  if (status === 404)
    return new ApiError(
      400,
      'INSTANCE_NOT_FOUND',
      'Инстанс не найден. Проверьте API URL и ID в кабинете GREEN-API.',
    );
  return new ApiError(
    502,
    'PROVIDER_UNAVAILABLE',
    'GREEN-API временно недоступен. Попробуйте позже.',
  );
}

export class GreenApi {
  constructor(
    private credentials: Credentials,
    private fetcher: Fetch,
    private signal: AbortSignal,
    private timeoutMs = 12_000,
  ) {}

  async call<T = Record<string, unknown>>(
    method: string,
    options: {
      body?: unknown;
      httpMethod?: 'GET' | 'POST' | 'DELETE';
      receiptId?: number;
      receiveTimeout?: number;
      form?: FormData;
    } = {},
  ): Promise<T> {
    const { apiUrl, idInstance, apiTokenInstance } = this.credentials;
    const suffix = options.receiptId === undefined ? '' : `/${options.receiptId}`;
    const query =
      options.receiveTimeout === undefined ? '' : `?receiveTimeout=${options.receiveTimeout}`;
    const url = `${apiUrl}/waInstance${idInstance}/${method}/${encodeURIComponent(apiTokenInstance)}${suffix}${query}`;
    const timeout = options.form
      ? Math.max(this.timeoutMs, 60_000)
      : options.receiveTimeout === undefined
        ? this.timeoutMs
        : (options.receiveTimeout + 5) * 1000;
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.signal.addEventListener('abort', abort, { once: true });
    if (this.signal.aborted) controller.abort();
    const timer = setTimeout(abort, timeout);
    timer.unref?.();
    try {
      const response = await this.fetcher(url, {
        method:
          options.httpMethod ?? (options.body === undefined && !options.form ? 'GET' : 'POST'),
        headers:
          options.body === undefined || options.form
            ? { Accept: 'application/json' }
            : { Accept: 'application/json', 'Content-Type': 'application/json' },
        // Native FormData creates its own boundary. Never set multipart Content-Type manually.
        body:
          options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
      });
      if (!response.ok) throw providerError(response.status);
      const raw = await response.text();
      if (raw.length > 1_000_000)
        throw new ApiError(
          502,
          'INVALID_PROVIDER_RESPONSE',
          'GREEN-API вернул слишком большой ответ.',
        );
      if (!raw.trim()) return null as T;
      try {
        return JSON.parse(raw) as T;
      } catch {
        throw new ApiError(
          502,
          'INVALID_PROVIDER_RESPONSE',
          'GREEN-API вернул некорректный ответ.',
        );
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // Never leak native fetch errors. They may include a URL containing the access token.
      throw new ApiError(
        502,
        this.signal.aborted ? 'SESSION_CLOSED' : 'PROVIDER_UNAVAILABLE',
        this.signal.aborted
          ? 'Сессия закрыта.'
          : 'Не удалось получить ответ GREEN-API. Проверьте соединение.',
      );
    } finally {
      clearTimeout(timer);
      this.signal.removeEventListener('abort', abort);
    }
  }
}
