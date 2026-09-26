import { randomBytes } from 'node:crypto';
import { ApiError, type Fetch } from './green-api.js';

export const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
export type MediaKind = 'image' | 'video' | 'audio' | 'document';
export type Media = {
  id: string;
  kind: MediaKind;
  fileName: string;
  mimeType: string;
  size?: number;
  duration?: number;
  url: string;
  unavailable?: boolean;
};
export type IncomingMedia = {
  kind: MediaKind;
  fileName: string;
  mimeType: string;
  downloadUrl: string;
};

const displayable = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'video/mp4',
  'video/webm',
  'audio/ogg',
  'audio/webm',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/flac',
]);
export function safeName(value: string): string {
  const name = value
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim();
  return Buffer.from(name?.slice(0, 180) || 'attachment.bin').toString('utf8');
}
/** Browsers send UTF-8 multipart filename bytes; Busboy's legacy parameter default is latin1. */
export function uploadedName(value: string): string {
  if ([...value].every((character) => character.charCodeAt(0) <= 255)) {
    try {
      value = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'latin1'));
    } catch {
      /* An already-decoded Latin filename should be preserved. */
    }
  }
  return safeName(value);
}
export function safeMime(value: string): string {
  const mime = value.toLowerCase().split(';')[0].trim();
  if (mime === 'image/jpg') return 'image/jpeg';
  return displayable.has(mime) || mime === 'application/pdf' ? mime : 'application/octet-stream';
}
export function kindForMime(mime: string): MediaKind {
  return mime.startsWith('image/')
    ? 'image'
    : mime.startsWith('video/')
      ? 'video'
      : mime.startsWith('audio/')
        ? 'audio'
        : 'document';
}

/** Only byte-recognized media is rendered inline. Client MIME and extensions are not authority. */
export function inspectUpload(
  bytes: Buffer,
  claimedMime: string,
): { mimeType: string; kind: MediaKind } {
  const prefix = bytes.subarray(0, 16);
  const ascii = prefix.toString('ascii');
  const claim = safeMime(claimedMime);
  let mimeType = 'application/octet-stream';
  if (prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    mimeType = 'image/png';
  else if (prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255) mimeType = 'image/jpeg';
  else if (/^GIF8[79]a/.test(ascii)) mimeType = 'image/gif';
  else if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') mimeType = 'image/webp';
  else if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') mimeType = 'audio/wav';
  else if (ascii.startsWith('OggS')) mimeType = 'audio/ogg';
  else if (ascii.startsWith('fLaC')) mimeType = 'audio/flac';
  else if (ascii.startsWith('ID3') || (prefix[0] === 255 && (prefix[1] & 0xe0) === 0xe0))
    mimeType = 'audio/mpeg';
  else if (prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))
    mimeType = claim === 'audio/webm' ? claim : 'video/webm';
  else if (ascii.slice(4, 8) === 'ftyp')
    mimeType = /avif|avis/.test(ascii.slice(8, 16))
      ? 'image/avif'
      : claim === 'audio/mp4'
        ? claim
        : 'video/mp4';
  else if (ascii.startsWith('%PDF-')) mimeType = 'application/pdf';
  return { mimeType, kind: kindForMime(mimeType) };
}

/** Documented Telegram API download paths and per-instance upload object storage only. */
export function allowedMediaUrl(
  value: string,
  apiUrl: string,
  instanceId: string,
): string | undefined {
  if (value.length > 2048 || /[\u0000-\u0020\\]/.test(value)) return;
  try {
    const url = new URL(value);
    const api = new URL(apiUrl);
    const region = api.hostname.split('.')[0];
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    )
      return;
    // Canonical comparison rejects disguised explicit ports and encoded path separators.
    if (url.href !== value) return;
    if (
      url.origin === api.origin &&
      new RegExp(`^/download/${region}/[A-Za-z0-9._-]+$`).test(url.pathname)
    )
      return url.href;
    if (
      url.hostname === `mediaout-${region}.storage.yandexcloud.net` &&
      new RegExp(`^/${instanceId}/[A-Za-z0-9._-]+$`).test(url.pathname)
    )
      return url.href;
  } catch {
    /* Untrusted URLs never reach fetch. */
  }
}

type StoredMedia = { media: Media; source?: string; createdAt: number };
export class MediaRegistry {
  private records = new Map<string, StoredMedia>();
  private messages = new Map<string, string>();
  constructor(
    private apiUrl: string,
    private instanceId: string,
  ) {}

  register(
    input: IncomingMedia,
    chatId: string,
    messageId: string,
    extra: { size?: number; duration?: number } = {},
    replace = false,
  ): Media {
    const key = `${chatId}\0${messageId}`;
    const known = this.messages.get(key);
    const existing = known && this.records.get(known);
    const source = allowedMediaUrl(input.downloadUrl, this.apiUrl, this.instanceId);
    if (existing && !replace) {
      if (!existing.source && source) {
        existing.source = source;
        delete existing.media.unavailable;
        existing.createdAt = Date.now();
      }
      return existing.media;
    }
    const id = existing ? existing.media.id : randomBytes(24).toString('base64url');
    const mimeType = safeMime(input.mimeType);
    const media: Media = {
      id,
      kind: mimeType === 'application/octet-stream' ? 'document' : input.kind,
      fileName: safeName(input.fileName),
      mimeType,
      ...extra,
      url: `/api/media/${id}`,
      ...(!source ? { unavailable: true } : {}),
    };
    this.records.set(id, { media, source, createdAt: Date.now() });
    this.messages.set(key, id);
    if (this.records.size > 1024) {
      const oldest = this.records.keys().next().value!;
      this.records.delete(oldest);
      for (const [message, mediaId] of this.messages)
        if (mediaId === oldest) this.messages.delete(message);
    }
    return media;
  }

  get(id: string): StoredMedia {
    const record = this.records.get(id);
    if (!record) throw new ApiError(404, 'MEDIA_NOT_FOUND', 'Вложение недоступно в этой сессии.');
    if (!record.source || Date.now() - record.createdAt > 24 * 60 * 60_000)
      throw new ApiError(
        410,
        'MEDIA_UNAVAILABLE',
        'Ссылка на вложение недоступна или истекла. Откройте сообщение в Telegram.',
      );
    return record;
  }
  clear() {
    this.records.clear();
    this.messages.clear();
  }
}

export async function downloadMedia(
  source: string,
  fetcher: Fetch,
  signal: AbortSignal,
): Promise<Buffer> {
  const abort = new AbortController();
  const stop = () => abort.abort();
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  const timer = setTimeout(stop, 60_000);
  timer.unref?.();
  try {
    const response = await fetcher(source, {
      signal: abort.signal,
      redirect: 'error',
      credentials: 'omit',
      headers: { Accept: '*/*' },
    });
    if (!response.ok || !response.body)
      throw new ApiError(
        410,
        'MEDIA_UNAVAILABLE',
        'Не удалось загрузить вложение. Ссылка могла истечь.',
      );
    const length = Number(response.headers.get('content-length'));
    if (length > MAX_MEDIA_BYTES) {
      await response.body.cancel();
      throw new ApiError(
        413,
        'MEDIA_TOO_LARGE',
        'Вложение превышает лимит 16 МиБ. Откройте его в Telegram.',
      );
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > MAX_MEDIA_BYTES)
          throw new ApiError(
            413,
            'MEDIA_TOO_LARGE',
            'Вложение превышает лимит 16 МиБ. Откройте его в Telegram.',
          );
        chunks.push(Buffer.from(item.value));
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      502,
      'MEDIA_UNAVAILABLE',
      'Не удалось загрузить вложение. Попробуйте позже.',
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  }
}
