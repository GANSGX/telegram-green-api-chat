import type { FormEvent } from 'react';
import { ArrowRight, CircleAlert, LoaderCircle } from 'lucide-react';
import type { Messenger } from '../lib/useMessenger';
import { Modal } from './ui';

interface NewChatDialogProps {
  messenger: Messenger;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recipient: string;
  onRecipientChange: (value: string) => void;
  contactName: string;
  onContactNameChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}

export function NewChatDialog({
  messenger,
  open,
  onOpenChange,
  recipient,
  onRecipientChange,
  contactName,
  onContactNameChange,
  onSubmit,
}: NewChatDialogProps) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Новый чат"
      description="Найдите получателя в Telegram по номеру телефона или имени пользователя."
    >
      <form onSubmit={onSubmit} className="modal-form">
        <label>
          Номер телефона или @username
          <input
            autoFocus
            value={recipient}
            onChange={(e) => onRecipientChange(e.target.value)}
            placeholder="+7 999 123-45-67 или @username"
            required
            autoComplete="off"
          />
        </label>
        <label>
          Имя контакта <span className="optional">необязательно</span>
          <input
            value={contactName}
            onChange={(e) => onContactNameChange(e.target.value)}
            placeholder="Как отображать в списке чатов"
            maxLength={80}
          />
        </label>
        <p className="field-help">
          Если номер скрыт настройками приватности, используйте @username.
        </p>
        {messenger.error && (
          <div className="form-error" role="alert">
            <CircleAlert size={17} />
            <span>{messenger.error}</span>
          </div>
        )}
        <button
          className="primary-button"
          type="submit"
          disabled={!recipient.trim() || messenger.isCreatingChat}
        >
          {messenger.isCreatingChat ? (
            <>
              <LoaderCircle className="spin" size={18} /> Ищем получателя…
            </>
          ) : (
            <>
              Открыть чат <ArrowRight size={18} />
            </>
          )}
        </button>
      </form>
    </Modal>
  );
}
