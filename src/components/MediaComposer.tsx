import { useEffect, useRef, useState } from 'react';
import { FileText, ImagePlus, LoaderCircle, Mic, Paperclip, Send, Smile, X } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import clsx from 'clsx';
import type { Messenger } from '../lib/useMessenger';
import { Modal } from './ui';
import { formatBytes } from './MessageMedia';

const emoji = [
  '😀',
  '😊',
  '😂',
  '❤️',
  '👍',
  '🔥',
  '🎉',
  '✨',
  '👋',
  '🙏',
  '😎',
  '🤔',
  '🥰',
  '🙌',
  '👌',
  '💜',
  '🚀',
  '✅',
  '☕',
  '🙂',
  '😁',
  '😍',
  '🥳',
  '💬',
];
interface AttachmentDraft {
  file: File;
  chatId: string;
}

export function MediaComposer({ messenger }: { messenger: Messenger }) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<AttachmentDraft | null>(null);
  const [preview, setPreview] = useState('');
  const [caption, setCaption] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const el = textarea.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
    }
  }, [messenger.draft, messenger.activeChatId]);
  useEffect(() => {
    setDraft(null);
    setCaption('');
    setError(null);
  }, [messenger.activeChatId]);
  useEffect(() => {
    if (!draft) {
      setPreview('');
      return;
    }
    const url = URL.createObjectURL(draft.file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [draft]);
  function pick(accept: string) {
    const el = fileInput.current;
    if (!el) return;
    el.accept = accept;
    el.value = '';
    el.click();
  }
  function choose(file?: File) {
    if (!file || !messenger.activeChatId) return;
    if (file.size > 16 * 1024 * 1024) {
      setError('Размер файла не должен превышать 16 МБ.');
      return;
    }
    if (!file.size) {
      setError('Этот файл пустой. Выберите другой.');
      return;
    }
    setError(null);
    setCaption('');
    setDraft({ file, chatId: messenger.activeChatId });
  }
  async function sendText() {
    if (!messenger.draft.trim() || messenger.draft.length > 4096) return;
    await messenger.sendMessage(messenger.draft);
    textarea.current?.focus();
  }
  async function sendAttachment() {
    if (
      !draft ||
      draft.chatId !== messenger.activeChatId ||
      caption.length > 1024 ||
      messenger.isUploading
    )
      return;
    const pending = draft;
    setDraft(null);
    setCaption('');
    await messenger.sendAttachment(pending.file, { caption: caption.trim() });
  }
  function insertEmoji(value: string) {
    const el = textarea.current;
    const from = el?.selectionStart ?? messenger.draft.length;
    const to = el?.selectionEnd ?? from;
    messenger.setDraft(messenger.draft.slice(0, from) + value + messenger.draft.slice(to));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(from + value.length, from + value.length);
    });
  }
  return (
    <div className="composer-area">
      {error && (
        <div className="composer-error" role="alert">
          <span>{error}</span>
          <button
            className="icon-button"
            aria-label="Закрыть ошибку вложения"
            onClick={() => {
              setError(null);
            }}
          >
            <X size={18} />
          </button>
        </div>
      )}
      <input
        type="file"
        ref={fileInput}
        className="file-input"
        aria-label="Выбрать вложение"
        onChange={(event) => choose(event.target.files?.[0])}
      />
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void sendText();
        }}
      >
        <div className="composer-input">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="icon-button"
                aria-label="Прикрепить файл"
                disabled={messenger.isUploading}
              >
                <Paperclip size={25} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                side="top"
                align="start"
                sideOffset={10}
                className="sidebar-menu-content"
              >
                <DropdownMenu.Item
                  className="sidebar-menu-item"
                  onSelect={() => pick('image/*,video/*')}
                >
                  <ImagePlus size={23} />
                  Фото или видео
                </DropdownMenu.Item>
                <DropdownMenu.Item className="sidebar-menu-item" onSelect={() => pick('')}>
                  <FileText size={23} />
                  Файл
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <textarea
            ref={textarea}
            aria-label="Сообщение"
            placeholder="Сообщение"
            rows={1}
            value={messenger.draft}
            onChange={(event) => messenger.setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void sendText();
              }
            }}
          />
          <Popover.Root>
            <Popover.Trigger asChild>
              <button className="icon-button" type="button" aria-label="Эмодзи">
                <Smile size={24} />
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                className="emoji-popover"
                side="top"
                align="end"
                sideOffset={12}
                aria-label="Выбор эмодзи"
                onCloseAutoFocus={(event) => event.preventDefault()}
              >
                <div className="emoji-grid">
                  {emoji.map((value) => (
                    <button
                      type="button"
                      key={value}
                      onClick={() => insertEmoji(value)}
                      aria-label={`Вставить ${value}`}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        </div>
        {messenger.isUploading ? (
          <button className="send-button" disabled aria-label="Загрузка файла">
            <LoaderCircle className="spin" size={24} />
          </button>
        ) : messenger.draft.trim() ? (
          <button
            className="send-button"
            aria-label="Отправить сообщение"
            disabled={messenger.draft.length > 4096}
            type="submit"
          >
            <Send size={25} fill="currentColor" strokeWidth={1.5} />
          </button>
        ) : (
          <button
            className="send-button voice-button"
            type="button"
            aria-label="Запись голосовых отключена"
            title="Запись голосовых отключена"
            disabled
          >
            <Mic size={27} />
          </button>
        )}
      </form>
      {messenger.draft.length > 3800 && (
        <div
          className={clsx('composer-limit', messenger.draft.length > 4096 && 'over-limit')}
          role="status"
        >
          {messenger.draft.length} / 4096
        </div>
      )}
      <Modal
        open={Boolean(draft)}
        onOpenChange={(open) => {
          if (!open) setDraft(null);
        }}
        title={draft?.file.type.startsWith('image/') ? 'Отправить фото' : 'Отправить файл'}
        description={`${draft?.file.name || ''} · ${formatBytes(draft?.file.size)}`}
      >
        {draft && (
          <form
            className="attachment-form"
            onSubmit={(event) => {
              event.preventDefault();
              void sendAttachment();
            }}
          >
            {draft.file.type.startsWith('audio/') ? (
              <audio className="attachment-audio-preview" src={preview} controls />
            ) : /^image\/(jpeg|png|webp|gif|avif)$/.test(draft.file.type) ? (
              <img className="attachment-image-preview" src={preview} alt="Предпросмотр вложения" />
            ) : draft.file.type.startsWith('video/') ? (
              <video className="attachment-video-preview" src={preview} controls />
            ) : (
              <div className="attachment-file-preview">
                <FileText size={45} />
                <span>{draft.file.name}</span>
              </div>
            )}
            <label>
              Подпись
              <textarea
                value={caption}
                onChange={(event) => setCaption(event.target.value)}
                placeholder="Добавить подпись…"
                rows={2}
                maxLength={1024}
              />
            </label>
            <div className="attachment-footer">
              <span>{caption.length} / 1024</span>
              <button type="submit" className="primary-button" disabled={messenger.isUploading}>
                Отправить
                <Send size={19} />
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
