import { LogOut, MessageCircle, Plus, Search, Settings2, ShieldCheck, X } from 'lucide-react';
import clsx from 'clsx';
import type { Messenger } from '../lib/useMessenger';
import { Avatar, TelegramMark, time } from './ui';

interface SidebarProps {
  messenger: Messenger;
  query: string;
  onQueryChange: (query: string) => void;
  onSettings: () => void;
  onNewChat: () => void;
  onOpenChat: () => void;
}

export function Sidebar({
  messenger,
  query,
  onQueryChange,
  onSettings,
  onNewChat,
  onOpenChat,
}: SidebarProps) {
  const filteredChats = messenger.chats.filter((chat) =>
    `${chat.name} ${chat.recipient || ''} ${chat.id}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <aside className="sidebar" aria-label="Список чатов">
      <header className="sidebar-header">
        <div className="brand">
          <TelegramMark />
          <span>Telegram</span>
        </div>
        <button
          className="icon-button"
          onClick={() => onSettings()}
          aria-label="Настройки подключения"
        >
          <Settings2 size={21} />
        </button>
      </header>
      <div className="sidebar-tools">
        <div className="search-field">
          <Search size={19} />
          <input
            aria-label="Поиск чатов"
            placeholder="Поиск"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
          />
          {query && (
            <button
              className="icon-button"
              aria-label="Очистить поиск"
              onClick={() => onQueryChange('')}
            >
              <X size={16} />
            </button>
          )}
        </div>
        <button
          className="new-chat-button"
          onClick={() => {
            messenger.clearError();
            onNewChat();
          }}
        >
          <Plus size={18} /> Новый чат
        </button>
      </div>
      <div className="chats-heading">
        <span>Все сообщения</span>
        <span>{messenger.chats.length}</span>
      </div>
      <nav className="chat-list" aria-label="Диалоги">
        {filteredChats.map((chat) => {
          const last = messenger.messages.filter((m) => m.chatId === chat.id).at(-1);
          return (
            <button
              key={chat.id}
              className={clsx('chat-item', chat.id === messenger.activeChatId && 'active')}
              onClick={() => {
                messenger.selectChat(chat.id);
                onOpenChat();
              }}
              aria-current={chat.id === messenger.activeChatId ? 'true' : undefined}
            >
              <Avatar name={chat.name} />
              <span className="chat-item-body">
                <span className="chat-item-top">
                  <strong>{chat.name}</strong>
                  {last && <time>{time(last.timestamp)}</time>}
                </span>
                <span className="chat-item-bottom">
                  <span className="chat-preview">
                    {messenger.drafts[chat.id] ? (
                      <>
                        <em>Черновик</em> {messenger.drafts[chat.id]}
                      </>
                    ) : last ? (
                      <>
                        {last.outgoing && <span>Вы · </span>}
                        {last.text}
                      </>
                    ) : (
                      'Начните разговор'
                    )}
                  </span>
                  {chat.unread > 0 && (
                    <span className="unread-badge">{chat.unread > 99 ? '99+' : chat.unread}</span>
                  )}
                </span>
              </span>
            </button>
          );
        })}
        {filteredChats.length === 0 && (
          <div className="sidebar-empty">
            <MessageCircle size={27} />
            <strong>{query ? 'Ничего не найдено' : 'Пока нет диалогов'}</strong>
            <p>
              {query ? 'Попробуйте другое имя или номер' : 'Создайте чат, чтобы написать первым'}
            </p>
          </div>
        )}
      </nav>
      <footer className="sidebar-footer">
        <span className="account-icon">
          <ShieldCheck size={20} />
        </span>
        <div>
          <strong>{messenger.mode === 'demo' ? 'Демонстрация' : 'GREEN-API подключён'}</strong>
          <span>
            {messenger.mode === 'demo'
              ? 'Без реальной отправки'
              : `Инстанс ${messenger.session?.instanceId || ''}`}
          </span>
        </div>
        <button
          className="icon-button"
          disabled={messenger.isLoggingOut}
          onClick={() => void messenger.logout()}
          aria-label={messenger.mode === 'demo' ? 'Выйти из демоверсии' : 'Отключиться'}
        >
          <LogOut size={19} />
        </button>
      </footer>
    </aside>
  );
}
