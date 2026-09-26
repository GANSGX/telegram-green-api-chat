import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Info,
  LoaderCircle,
  MoreVertical,
  Phone,
  Search,
  X,
} from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import clsx from 'clsx';
import type { Messenger } from '../lib/useMessenger';
import { Avatar, MessageStatus, time, day } from './ui';
import { MediaComposer } from './MediaComposer';
import { MessageMedia } from './MessageMedia';

interface ChatWorkspaceProps {
  messenger: Messenger;
  newChatOpen: boolean;
  onBack: () => void;
  onSettings: () => void;
  onNewChat: () => void;
}
function highlightedText(text: string, query: string): ReactNode {
  if (!query.trim()) return text;
  const lower = text.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase().trim();
  const parts: ReactNode[] = [];
  let start = 0;
  let found = lower.indexOf(needle);
  while (found !== -1) {
    parts.push(text.slice(start, found));
    parts.push(<mark key={found}>{text.slice(found, found + needle.length)}</mark>);
    start = found + needle.length;
    found = lower.indexOf(needle, start);
  }
  parts.push(text.slice(start));
  return parts;
}
export function ChatWorkspace({ messenger, newChatOpen, onBack, onSettings }: ChatWorkspaceProps) {
  const [atBottom, setAtBottom] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const previousChat = useRef<string | null>(null);
  const nearBottom = useRef(true);
  const messages = messenger.activeMessages;
  const active = messenger.activeChat;
  const last = messages.at(-1);
  const matches = search.trim()
    ? messages.filter((message) =>
        message.text.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
      )
    : [];
  useEffect(() => {
    const switched = previousChat.current !== messenger.activeChatId;
    if (switched || nearBottom.current || last?.outgoing) {
      listRef.current?.scrollTo({
        top: listRef.current.scrollHeight,
        behavior: switched ? 'instant' : 'smooth',
      });
    }
    if (switched) {
      setSearchOpen(false);
      setSearch('');
      setMatchIndex(0);
    }
    previousChat.current = messenger.activeChatId;
  }, [messenger.activeChatId, last?.id, last?.status]);
  function jumpToMatch(index: number) {
    if (!matches.length) return;
    const normalized = (index + matches.length) % matches.length;
    setMatchIndex(normalized);
    const target = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [],
    ).find((element) => element.dataset.messageId === matches[normalized].id);
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  return (
    <section className="chat-workspace" aria-label="Переписка">
      <div className="chat-notices">
        {messenger.mode === 'live' && messenger.connection !== 'connected' && (
          <div className="connection-banner" role="status">
            <LoaderCircle className="spin" size={17} />
            {messenger.connection === 'unauthorized'
              ? 'Проверьте авторизацию Telegram в GREEN-API'
              : 'Соединение с GREEN-API…'}
          </div>
        )}
        {messenger.mode === 'live' && messenger.session?.notificationsEnabled === false && (
          <div className="notification-banner">
            <span>
              Для получения ответов включите уведомления. Применение может занять до 5 минут.
            </span>
            <button
              onClick={() => void messenger.enableNotifications()}
              disabled={messenger.isEnablingNotifications}
            >
              {messenger.isEnablingNotifications ? 'Настраиваем…' : 'Включить'}
            </button>
          </div>
        )}
        {messenger.error && !newChatOpen && (
          <div className="error-banner" role="alert">
            <CircleAlert size={17} />
            <span>{messenger.error}</span>
            <button
              className="icon-button"
              onClick={messenger.clearError}
              aria-label="Закрыть сообщение об ошибке"
            >
              <X size={19} />
            </button>
          </div>
        )}
      </div>
      {active ? (
        <>
          <header className="chat-header">
            <button className="icon-button mobile-back" aria-label="Назад к чатам" onClick={onBack}>
              <ArrowLeft size={25} />
            </button>
            <Avatar name={active.name} small />
            <button
              className="chat-heading"
              onClick={onSettings}
              aria-label="Информация о подключении"
            >
              <h1>{active.name}</h1>
              <p>
                {messenger.mode === 'demo'
                  ? 'демонстрационный диалог'
                  : active.recipient || 'Telegram'}
              </p>
            </button>
            <button
              className="icon-button"
              aria-label="Поиск в переписке"
              onClick={() => setSearchOpen(!searchOpen)}
            >
              <Search size={24} />
            </button>
            <button
              className="icon-button unsupported-control"
              disabled
              aria-label="Звонки не поддерживаются"
              title="Звонки не поддерживаются"
            >
              <Phone size={24} />
            </button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button className="icon-button" aria-label="Меню чата">
                  <MoreVertical size={24} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="sidebar-menu-content" sideOffset={9} align="end">
                  <DropdownMenu.Item
                    className="sidebar-menu-item"
                    onSelect={() => setSearchOpen(true)}
                  >
                    <Search size={21} />
                    Поиск сообщений
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className="sidebar-menu-item" onSelect={onSettings}>
                    <Info size={21} />
                    Подключение
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </header>
          {searchOpen && (
            <form
              className="message-search"
              onSubmit={(e) => {
                e.preventDefault();
                jumpToMatch(matchIndex);
              }}
            >
              <Search size={21} />
              <input
                aria-label="Поиск сообщений"
                placeholder="Поиск сообщений"
                autoFocus
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setMatchIndex(0);
                }}
              />
              <span aria-live="polite">
                {search ? `${matches.length ? matchIndex + 1 : 0} из ${matches.length}` : ''}
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label="Предыдущее совпадение"
                disabled={!matches.length}
                onClick={() => jumpToMatch(matchIndex - 1)}
              >
                <ChevronUp size={21} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Следующее совпадение"
                disabled={!matches.length}
                onClick={() => jumpToMatch(matchIndex + 1)}
              >
                <ChevronDown size={21} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Закрыть поиск сообщений"
                onClick={() => {
                  setSearchOpen(false);
                  setSearch('');
                }}
              >
                <X size={21} />
              </button>
            </form>
          )}
          <div
            ref={listRef}
            className="message-list"
            role="log"
            aria-label={`Сообщения с ${active.name}`}
            aria-live="polite"
            aria-relevant="additions"
            onScroll={() => {
              const el = listRef.current;
              if (el) {
                nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
                setAtBottom(nearBottom.current);
              }
            }}
          >
            <div className="message-column">
              {messages.length === 0 && (
                <div className="conversation-empty">
                  <span>Сообщений пока нет</span>
                </div>
              )}
              {messages.map((message, index, all) => (
                <div key={message.clientId || message.id} data-message-id={message.id}>
                  {(index === 0 || day(message.timestamp) !== day(all[index - 1].timestamp)) && (
                    <div className="date-divider">
                      <span>{day(message.timestamp)}</span>
                    </div>
                  )}
                  <div className={clsx('message-row', message.outgoing && 'outgoing')}>
                    <div
                      className={clsx(
                        'message-bubble',
                        message.media && 'has-media',
                        (message.status === 'failed' || message.status === 'unknown') &&
                          'message-problem',
                      )}
                    >
                      {message.media && (
                        <MessageMedia key={message.media.url} media={message.media} />
                      )}
                      <p className={!message.text ? 'media-caption-empty' : undefined}>
                        {highlightedText(message.text, search)}
                        <span className="message-meta-spacer" aria-hidden="true" />
                      </p>
                      <span className="message-meta">
                        <time dateTime={new Date(message.timestamp).toISOString()}>
                          {time(message.timestamp)}
                        </time>
                        {message.outgoing && <MessageStatus status={message.status} />}
                      </span>
                      {message.status === 'failed' && (
                        <div className="send-problem">
                          <span>{message.error || 'Не удалось отправить'}</span>
                          <button onClick={() => void messenger.retryMessage(message.id)}>
                            Повторить
                          </button>
                        </div>
                      )}
                      {message.status === 'unknown' && (
                        <div className="send-problem">
                          Нет подтверждения. Проверьте Telegram перед повторной отправкой.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          {!atBottom && (
            <button
              className="scroll-bottom icon-button"
              aria-label="К последним сообщениям"
              onClick={() =>
                listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
              }
            >
              <ChevronDown size={24} />
            </button>
          )}
          <MediaComposer messenger={messenger} />
        </>
      ) : (
        <div className="workspace-empty" aria-label="Выберите чат или создайте новый" />
      )}
    </section>
  );
}
