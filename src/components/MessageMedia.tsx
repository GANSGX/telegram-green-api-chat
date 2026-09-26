import { useRef, useState } from 'react';
import { Download, FileText, Pause, Play } from 'lucide-react';
import type { MediaAttachment } from '../lib/types';

export const formatBytes = (bytes?: number) =>
  bytes === undefined
    ? ''
    : bytes < 1024
      ? `${bytes} Б`
      : bytes < 1024 * 1024
        ? `${(bytes / 1024).toFixed(0)} КБ`
        : `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
export const formatDuration = (value: number) =>
  `${Math.floor(value / 60)}·${String(Math.floor(value % 60)).padStart(2, '0')}`;

export function MessageMedia({ media }: { media: MediaAttachment }) {
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(media.duration || 0);
  const [position, setPosition] = useState(0);
  const audio = useRef<HTMLAudioElement>(null);
  // Only BFF paths or this page's locally created preview blobs are displayed.
  const url =
    media.url && (/^\/api\/media\/[A-Za-z0-9_-]+$/.test(media.url) || media.url.startsWith('blob:'))
      ? media.url
      : '';
  async function toggleAudio() {
    if (!audio.current) return;
    if (playing) audio.current.pause();
    else {
      try {
        await audio.current.play();
      } catch {
        setFailed(true);
      }
    }
  }
  if (!url || failed)
    return (
      <div className="media-unavailable">
        <FileText size={25} />
        <div>
          <strong>{media.fileName}</strong>
          <span>
            {url
              ? 'Не удалось открыть предпросмотр.'
              : 'Файл недоступен в этой сессии. Откройте Telegram.'}
          </span>
          {url && (
            <div className="media-recovery">
              <button onClick={() => setFailed(false)}>Повторить</button>
              <a href={url} download={media.fileName}>
                Скачать файл
              </a>
            </div>
          )}
        </div>
      </div>
    );
  if (media.kind === 'image' && /^image\/(jpeg|png|webp|gif|avif)$/.test(media.mimeType))
    return (
      <a className="image-attachment" href={url} target="_blank" rel="noreferrer">
        <img src={url} alt={media.fileName} onError={() => setFailed(true)} loading="lazy" />
      </a>
    );
  if (media.kind === 'video')
    return (
      <video
        className="video-attachment"
        src={url}
        controls
        preload="metadata"
        onError={() => setFailed(true)}
        aria-label={media.fileName}
      />
    );
  if (media.kind === 'audio')
    return (
      <div className="audio-attachment">
        <audio
          ref={audio}
          src={url}
          preload="none"
          onLoadedMetadata={() => {
            const value = audio.current?.duration;
            if (value && Number.isFinite(value)) setDuration(value);
          }}
          onTimeUpdate={() => setPosition(audio.current?.currentTime || 0)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setPosition(0);
          }}
          onError={() => setFailed(true)}
        />
        <button
          className="audio-play"
          aria-label={playing ? 'Приостановить аудио' : 'Воспроизвести аудио'}
          onClick={() => void toggleAudio()}
        >
          {playing ? (
            <Pause size={21} fill="currentColor" />
          ) : (
            <Play size={21} fill="currentColor" />
          )}
        </button>
        <div className="audio-body">
          {media.kind === 'audio' && <strong>{media.fileName}</strong>}
          <input
            type="range"
            min={0}
            max={duration || 1}
            value={position}
            step={0.1}
            disabled={!duration}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (audio.current) audio.current.currentTime = value;
              setPosition(value);
            }}
            aria-label="Позиция аудио"
          />
          <span>
            {formatDuration(playing ? position : duration)}
            {media.size ? ` · ${formatBytes(media.size)}` : ''}
          </span>
        </div>
        <a
          className="media-download"
          href={url}
          download={media.fileName}
          aria-label={`Скачать ${media.fileName}`}
        >
          <Download size={19} />
        </a>
      </div>
    );
  return (
    <a className="file-attachment" href={url} download={media.fileName}>
      <span className="file-icon">
        <FileText size={26} />
      </span>
      <span className="file-body">
        <strong>{media.fileName}</strong>
        <span>{formatBytes(media.size) || 'Скачать файл'}</span>
      </span>
      <Download size={21} />
    </a>
  );
}
