import {
  MAX_CAPTION_LENGTH,
  MAX_FILE_SIZE,
  type AttachmentOptions,
  type MediaAttachment,
} from './types';

const mediaKinds = new Set(['image', 'video', 'audio', 'document']);
const previewImageTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
]);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Persist metadata only. Never retain blob, data, provider URLs, queries, or tokens. */
export function persistentMedia(value: unknown): MediaAttachment | undefined {
  if (
    !record(value) ||
    typeof value.id !== 'string' ||
    value.id.length > 200 ||
    typeof value.kind !== 'string' ||
    !mediaKinds.has(value.kind) ||
    typeof value.fileName !== 'string' ||
    value.fileName.length > 500 ||
    typeof value.mimeType !== 'string' ||
    value.mimeType.length > 200
  )
    return undefined;
  return {
    id: value.id,
    kind: value.kind as MediaAttachment['kind'],
    fileName: value.fileName,
    mimeType: value.mimeType,
    size:
      typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0
        ? value.size
        : undefined,
    duration:
      typeof value.duration === 'number' && Number.isFinite(value.duration) && value.duration >= 0
        ? value.duration
        : undefined,
    url:
      typeof value.url === 'string' && /^\/api\/media\/[A-Za-z0-9_-]{1,200}$/.test(value.url)
        ? value.url
        : '',
    ...(value.unavailable === true ? { unavailable: true as const } : {}),
  };
}

export function mediaKind(mimeType: string): MediaAttachment['kind'] {
  // Local blob previews must never open active SVG/HTML documents at the app origin.
  if (previewImageTypes.has(mimeType)) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'document';
}

export function attachmentValidationError(
  file: Pick<File, 'size'>,
  options: AttachmentOptions,
): string | null {
  if (file.size === 0) return 'Файл пустой. Выберите другой файл.';
  if (file.size > MAX_FILE_SIZE) return 'Файл слишком большой. Максимальный размер — 16 МБ.';
  if ((options.caption?.length ?? 0) > MAX_CAPTION_LENGTH)
    return 'Подпись может содержать не больше 1024 символов.';
  return null;
}
