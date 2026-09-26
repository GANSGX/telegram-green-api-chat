import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { LogOut, Menu, MessageCircle, Pencil, Plus, Search, Settings2, X } from 'lucide-react';
import clsx from 'clsx';
import type { Messenger } from '../lib/useMessenger';
import { Avatar, MessageStatus, time } from './ui';

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

  function openNewChat() {
    messenger.clearError();
    onNewChat();
  }

  return (
    <aside className="sidebar" aria-label="Список чатов">
      <header className="sidebar-header">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="icon-button sidebar-menu-trigger" aria-label="Главное меню">
              <Menu size={24} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="sidebar-menu-content" sideOffset={8} align="start">
              <DropdownMenu.Item className="sidebar-menu-item" onSelect={openNewChat}>
                <Plus size={21} /> Новый чат
              </DropdownMenu.Item>
              <DropdownMenu.Item className="sidebar-menu-item" onSelect={onSettings}>
                <Settings2 size={21} /> Подключение
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="sidebar-menu-separator" />
              <DropdownMenu.Item
                className="sidebar-menu-item"
                disabled={messenger.isLoggingOut}
                onSelect={() => void messenger.logout()}
              >
                <LogOut size={21} />
                {messenger.mode === 'demo' ? 'Выйти из демоверсии' : 'Выйти'}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <div className="search-field">
          <Search size={22} />
          <input
            aria-label="Поиск чатов"
            placeholder="Поиск"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          {query && (
            <button
              className="icon-button"
              aria-label="Очистить поиск"
              onClick={() => onQueryChange('')}
            >
              <X size={18} />
            </button>
          )}
          <button
            className="search-profile"
            aria-label="Настройки подключения"
            onClick={onSettings}
          >
            Я
          </button>
        </div>
      </header>
      <nav className="chat-list" aria-label="Диалоги">
        {filteredChats.map((chat) => {
          const last = messenger.messages.filter((message) => message.chatId === chat.id).at(-1);
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
                  {last && (
                    <span className="chat-item-meta">
                      {last.outgoing && <MessageStatus status={last.status} />}
                      <time>{time(last.timestamp)}</time>
                    </span>
                  )}
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
                        {last.text ||
                          (last.media?.kind === 'image'
                            ? 'Фото'
                            : last.media?.kind === 'video'
                              ? 'Видео'
                              : last.media?.fileName || 'Файл')}
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
      {messenger.mode === 'demo' && (
        <span className="sidebar-demo-label">Демо · без реальной отправки</span>
      )}
      <button className="sidebar-compose" aria-label="Новый чат" onClick={openNewChat}>
        <Pencil size={25} />
      </button>
    </aside>
  );
}
