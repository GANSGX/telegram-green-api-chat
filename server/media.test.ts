import { describe, expect, it, vi } from 'vitest';
import {
  allowedMediaUrl,
  downloadMedia,
  inspectUpload,
  MAX_MEDIA_BYTES,
  MediaRegistry,
  safeName,
} from './media.js';
import type { Fetch } from './green-api.js';

const apiUrl = 'https://4100.api.green-api.com';
const instanceId = '4100000000';
describe('private media boundaries', () => {
  it('allows only documented downloads for this exact region and instance', () => {
    for (const url of [
      `${apiUrl}/download/4100/file-name.png`,
      `https://mediaout-4100.storage.yandexcloud.net/${instanceId}/file.png`,
    ])
      expect(allowedMediaUrl(url, apiUrl, instanceId)).toBe(url);
    for (const url of [
      'http://4100.api.green-api.com/download/4100/file.png',
      'https://127.0.0.1/private',
      'https://4100.api.green-api.com.evil.test/download/4100/a.png',
      'https://4100.api.green-api.com@evil.test/download/4100/a.png',
      `${apiUrl}/waInstance${instanceId}/getSettings/token`,
      `${apiUrl}:443/download/4100/file.png`,
      `${apiUrl}/download/4200/file.png`,
      `${apiUrl}/download/4100/../file.png`,
      `${apiUrl}/download/4100/file%2Fname.png`,
      `${apiUrl}/download/4100/a.png?token=private`,
      `${apiUrl}/download/4100/a.png#fragment`,
      'https://mediaout-4100.storage.yandexcloud.net/another-instance/file.png',
      `https://mediaout-4200.storage.yandexcloud.net/${instanceId}/file.png`,
    ])
      expect(allowedMediaUrl(url, apiUrl, instanceId)).toBeUndefined();
  });

  it('does not believe active content disguised as image MIME and sanitizes filenames', () => {
    expect(inspectUpload(Buffer.from('<svg onload="alert(1)"></svg>'), 'image/png')).toEqual({
      mimeType: 'application/octet-stream',
      kind: 'document',
    });
    expect(
      inspectUpload(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2]), 'audio/webm;codecs=opus'),
    ).toEqual({ mimeType: 'audio/webm', kind: 'audio' });
    expect(inspectUpload(Buffer.from('OggSbinary'), 'application/octet-stream')).toEqual({
      mimeType: 'audio/ogg',
      kind: 'audio',
    });
    expect(safeName('../../a\r\n\u202efile.pdf')).toBe('afile.pdf');
  });

  it('keeps private source URLs outside DTOs and marks invalid links unavailable', () => {
    const registry = new MediaRegistry(apiUrl, instanceId);
    const media = registry.register(
      {
        kind: 'image',
        mimeType: 'image/png',
        fileName: 'photo.png',
        downloadUrl: `${apiUrl}/download/4100/photo.png`,
      },
      '777',
      '1',
    );
    expect(media.url).toMatch(/^\/api\/media\/[\w-]{32}$/);
    expect(JSON.stringify(media)).not.toContain('green-api');
    expect(
      registry.register(
        {
          kind: 'document',
          mimeType: 'text/html',
          fileName: 'test.html',
          downloadUrl: 'https://evil.test/payload',
        },
        '777',
        '2',
      ),
    ).toMatchObject({ kind: 'document', mimeType: 'application/octet-stream', unavailable: true });
    expect(
      registry.register(
        { kind: 'image', mimeType: 'image/png', fileName: 'photo.png', downloadUrl: '' },
        '777',
        '1',
      ),
    ).toEqual(media);
    registry.clear();
    expect(() => registry.get(media.id)).toThrow('недоступно');
  });

  it('bounds a chunked download even when Content-Length is missing and cancels its stream', async () => {
    const cancelled = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_MEDIA_BYTES));
          controller.enqueue(new Uint8Array(1));
        },
        cancel: cancelled,
      }),
    );
    const fetcher = vi.fn(async () => response);
    await expect(
      downloadMedia(`${apiUrl}/download/4100/file`, fetcher as Fetch, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE', status: 413 });
    expect(cancelled).toHaveBeenCalled();
    expect(fetcher.mock.calls[0]).toBeDefined();
  });

  it('rejects oversized advertised bodies and sanitizes redirected/network errors', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response('small', { headers: { 'content-length': String(MAX_MEDIA_BYTES + 1) } }),
    );
    await expect(
      downloadMedia('https://provider.test/a', fetcher as Fetch, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'MEDIA_TOO_LARGE' });
    const failed = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      expect(init?.credentials).toBe('omit');
      throw new Error('secret-token in redirect location');
    });
    await expect(
      downloadMedia('https://provider.test/a', failed as Fetch, new AbortController().signal),
    ).rejects.toMatchObject({ message: 'Не удалось загрузить вложение. Попробуйте позже.' });
  });
});
