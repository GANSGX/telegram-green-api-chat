import type { ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Bookmark, Check, CheckCheck, CircleAlert, Clock3, X } from 'lucide-react';
import clsx from 'clsx';
import type { Message } from '../lib/types';

export const time = (timestamp: number) =>
  new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(timestamp);
export const day = (timestamp: number) =>
  new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long' }).format(timestamp);
function initials(name: string) {
  return (
    name
      .replace(/^@/, '')
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase() || 'T'
  );
}
export function Avatar({ name, small = false }: { name: string; small?: boolean }) {
  const hue = [...name].reduce((n, c) => n + c.charCodeAt(0), 0) % 5;
  return (
    <span
      className={clsx(
        'avatar',
        `avatar-${hue}`,
        small && 'avatar-small',
        name === 'Избранное' && 'avatar-saved',
      )}
      aria-hidden="true"
    >
      {name === 'Избранное' ? (
        <Bookmark size={small ? 23 : 28} fill="currentColor" strokeWidth={1.5} />
      ) : (
        initials(name)
      )}
    </span>
  );
}
export function TelegramMark({ large = false }: { large?: boolean }) {
  return (
    <span className={clsx('telegram-mark', large && 'large')}>
      <img src="/telegram-logo.svg" alt="" width={large ? 120 : 42} height={large ? 120 : 42} />
    </span>
  );
}
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal-content">
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description>{description}</Dialog.Description>
          <Dialog.Close className="icon-button modal-close" aria-label="Закрыть">
            <X size={20} />
          </Dialog.Close>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function MessageStatus({ status }: { status: Message['status'] }) {
  const labels = {
    sending: 'Отправляется',
    sent: 'Принято GREEN-API',
    delivered: 'Доставлено',
    read: 'Прочитано',
    failed: 'Не отправлено',
    unknown: 'Результат отправки неизвестен',
  };
  return (
    <span
      className={clsx('message-status', status)}
      title={labels[status]}
      aria-label={labels[status]}
    >
      {status === 'sending' ? (
        <Clock3 size={13} />
      ) : status === 'failed' || status === 'unknown' ? (
        <CircleAlert size={14} />
      ) : status === 'sent' ? (
        <Check size={15} />
      ) : (
        <CheckCheck size={17} />
      )}
    </span>
  );
}
