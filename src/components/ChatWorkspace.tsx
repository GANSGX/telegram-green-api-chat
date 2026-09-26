import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  CircleAlert,
  Info,
  LoaderCircle,
  LockKeyhole,
  Plus,
  Send,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import type { Messenger } from '../lib/useMessenger';
import { Avatar, TelegramMark, MessageStatus, time, day } from './ui';

interface ChatWorkspaceProps {
  messenger: Messenger;
  newChatOpen: boolean;
  onBack: () => void;
  onSettings: () => void;
  onNewChat: () => void;
}

export function ChatWorkspace({
  messenger,
  newChatOpen,
  onBack,
  onSettings,
  onNewChat,
}: ChatWorkspaceProps) {
  const [notificationsBusy, setNotificationsBusy] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const prevChat = useRef<string | null>(null);
  const active = messenger.activeChat;
  const lastMessage = messenger.activeMessages.at(-1);
  useEffect(() => {
    const switched = prevChat.current !== messenger.activeChatId;
    if (switched || atBottom || lastMessage?.outgoing)
      listRef.current?.scrollTo({
        top: listRef.current.scrollHeight,
        behavior: switched ? 'instant' : 'smooth',
      });
    prevChat.current = messenger.activeChatId;
  }, [messenger.activeChatId, lastMessage?.id, lastMessage?.status]);
  useEffect(() => {
    if (composerRef.current) {
      composerRef.current.style.height = 'auto';
      composerRef.current.style.height = `${Math.min(composerRef.current.scrollHeight, 160)}px`;
    }
  }, [messenger.draft]);
  async function send() {
    if (!messenger.draft.trim() || messenger.draft.length > 4096) return;
    await messenger.sendMessage(messenger.draft);
    composerRef.current?.focus();
  }
  async function enableNotifications() {
    setNotificationsBusy(true);
    try {
      await messenger.enableNotifications();
    } finally {
      setNotificationsBusy(false);
    }
  }
  return (
    <section className="chat-workspace" aria-label="Переписка">
      {messenger.mode === 'demo' && (
        <div className="demo-banner">
          <span>
            <Info size={15} /> Демо{' '}
            <span className="demo-banner-detail">· Сообщения остаются в этом браузере</span>
          </span>
          <button disabled={messenger.isLoggingOut} onClick={() => void messenger.logout()}>
            Подключить аккаунт <ArrowRight size={14} />
          </button>
        </div>
      )}
      {messenger.mode === 'live' && messenger.connection !== 'connected' && (
        <div className="connection-banner" role="status">
          <LoaderCircle size={16} className="spin" />
          {messenger.connection === 'unauthorized'
            ? 'Проверьте авторизацию инстанса в GREEN-API'
            : 'Восстанавливаем соединение…'}
        </div>
      )}
      {messenger.mode === 'live' && messenger.session?.notificationsEnabled === false && (
        <div className="notification-banner">
          <span>
            <Info size={17} /> Для получения ответов включите уведомления инстанса. Применение
            занимает до 5 минут.
          </span>
          <button onClick={enableNotifications} disabled={notificationsBusy}>
            {notificationsBusy ? 'Настраиваем…' : 'Включить'}
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
            <X size={17} />
          </button>
        </div>
      )}
      {active ? (
        <>
          <header className="chat-header">
            <button
              className="icon-button mobile-back"
              aria-label="Назад к чатам"
              onClick={() => onBack()}
            >
              <ArrowLeft size={22} />
            </button>
            <Avatar name={active.name} small />
            <div className="chat-heading">
              <h1>{active.name}</h1>
              <p>
                {messenger.mode === 'demo'
                  ? 'Демонстрационный диалог'
                  : active.recipient || 'Личный чат Telegram'}
              </p>
            </div>
            <button
              className="icon-button"
              aria-label="Информация о подключении"
              onClick={() => onSettings()}
            >
              <Info size={21} />
            </button>
          </header>
          <div
            ref={listRef}
            className="message-list"
            role="log"
            aria-label={`Сообщения с ${active.name}`}
            aria-live="polite"
            aria-relevant="additions"
            onScroll={() => {
              const el = listRef.current;
              if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 130);
            }}
          >
            <div className="message-column">
              {messenger.activeMessages.length === 0 && (
                <div className="conversation-empty">
                  <span className="empty-icon">
                    <Send size={30} />
                  </span>
                  <h2>Скажите «Привет»</h2>
                  <p>Это начало вашего разговора с {active.name}.</p>
                </div>
              )}
              {messenger.activeMessages.map((message, index, all) => (
                <div key={message.clientId || message.id}>
                  {(index === 0 || day(message.timestamp) !== day(all[index - 1].timestamp)) && (
                    <div className="date-divider">
                      <span>{day(message.timestamp)}</span>
                    </div>
                  )}
                  <div className={clsx('message-row', message.outgoing && 'outgoing')}>
                    <div
                      className={clsx(
                        'message-bubble',
                        (message.status === 'failed' || message.status === 'unknown') &&
                          'message-problem',
                      )}
                    >
                      <p>{message.text}</p>
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
                          <span>
                            Нет подтверждения. Проверьте Telegram перед повторной отправкой.
                          </span>
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
              <ChevronDown size={23} />
            </button>
          )}
          <div className="composer-area">
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <textarea
                ref={composerRef}
                aria-label="Сообщение"
                placeholder="Написать сообщение…"
                rows={1}
                value={messenger.draft}
                onChange={(e) => messenger.setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <button
                className="send-button"
                aria-label="Отправить сообщение"
                disabled={!messenger.draft.trim() || messenger.draft.length > 4096}
                type="submit"
              >
                <Send size={22} />
              </button>
            </form>
            <div className="composer-hint">
              <span>
                Enter — отправить <span>·</span> Shift + Enter — новая строка
              </span>
              {messenger.draft.length > 3800 ? (
                <span className={messenger.draft.length > 4096 ? 'over-limit' : ''}>
                  {messenger.draft.length} / 4096
                </span>
              ) : (
                <span>
                  <LockKeyhole size={11} /> Через GREEN-API
                </span>
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="workspace-empty">
          <TelegramMark large />
          <h1>Ваши разговоры здесь</h1>
          <p>
            Выберите диалог или начните новый,
            <br />
            чтобы отправить сообщение в Telegram.
          </p>
          <button className="primary-button" onClick={() => onNewChat()}>
            <Plus size={18} /> Начать разговор
          </button>
        </div>
      )}
    </section>
  );
}
