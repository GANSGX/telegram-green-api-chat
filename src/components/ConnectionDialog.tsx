import { ExternalLink, LogOut } from 'lucide-react';
import type { Messenger } from '../lib/useMessenger';
import { Modal } from './ui';

interface ConnectionDialogProps {
  messenger: Messenger;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ConnectionDialog({ messenger, open, onOpenChange }: ConnectionDialogProps) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Подключение"
      description={
        messenger.mode === 'demo'
          ? 'Вы тестируете интерфейс в демонстрационном режиме.'
          : 'Telegram подключён через ваш инстанс GREEN-API.'
      }
    >
      <div className="settings-details">
        <div>
          <span>Режим</span>
          <strong>{messenger.mode === 'demo' ? 'Демонстрация' : 'Telegram'}</strong>
        </div>
        {messenger.mode === 'live' && (
          <>
            <div>
              <span>Инстанс</span>
              <strong>{messenger.session?.instanceId}</strong>
            </div>
            <div>
              <span>Соединение</span>
              <strong>{messenger.connection === 'connected' ? 'Установлено' : 'Ожидание'}</strong>
            </div>
            <div>
              <span>Входящие сообщения</span>
              <strong>{messenger.session?.notificationsEnabled ? 'Включены' : 'Отключены'}</strong>
            </div>
          </>
        )}
      </div>
      <p className="settings-note">
        История доступна в текущей вкладке браузера. При выходе история и данные подключения
        удаляются. Отправленные сообщения остаются в Telegram.
      </p>
      <a
        className="text-link"
        href="https://green-api.com/telegram/docs/before-start/"
        target="_blank"
        rel="noreferrer"
      >
        Документация GREEN-API <ExternalLink size={14} />
      </a>
      <button
        className="secondary-button disconnect-button"
        disabled={messenger.isLoggingOut}
        onClick={() => {
          onOpenChange(false);
          void messenger.logout();
        }}
      >
        <LogOut size={17} />
        {messenger.mode === 'demo' ? 'Выйти из демоверсии' : 'Отключиться'}
      </button>
    </Modal>
  );
}
