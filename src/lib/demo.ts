import type { HistoryState, Message } from './types';

/** All demo data is fictional and stays in the browser. */
export function createDemoHistory(): HistoryState {
  const now = Date.now();
  const message = (
    id: string,
    chatId: string,
    text: string,
    minutesAgo: number,
    outgoing = false,
  ): Message => ({
    id,
    chatId,
    text,
    timestamp: now - minutesAgo * 60_000,
    outgoing,
    status: outgoing ? 'read' : 'delivered',
  });
  return {
    chats: [
      { id: 'demo-maria', name: 'Мария Волкова', recipient: '@maria_demo', unread: 0 },
      { id: 'demo-design', name: 'Команда продукта', recipient: '@product_demo', unread: 2 },
      { id: 'demo-alex', name: 'Алексей Смирнов', recipient: '@alex_demo', unread: 0 },
      { id: 'demo-anna', name: 'Анна Белова', recipient: '@anna_demo', unread: 0 },
      { id: 'demo-notes', name: 'Избранное', unread: 0 },
    ],
    messages: [
      message('d1', 'demo-maria', 'Привет! Как продвигается новый интерфейс?', 32),
      message(
        'd2',
        'demo-maria',
        'Привет! Уже можно попробовать. Сделали акцент на самом важном — общении.',
        31,
        true,
      ),
      message(
        'd3',
        'demo-maria',
        'Очень нравится, когда ничего не отвлекает. А сообщения приходят в реальном времени?',
        29,
      ),
      message(
        'd4',
        'demo-maria',
        'Да. Подключаешь свой Telegram через GREEN-API и переписываешься прямо здесь.',
        27,
        true,
      ),
      message('d5', 'demo-maria', 'Отлично ✨\nНапиши мне что-нибудь, проверим вместе.', 2),
      message('d6', 'demo-design', 'Сегодня проверяем новый сценарий общения.', 55),
      message('d7', 'demo-design', 'Макеты и все состояния готовы 🙌', 18),
      message('d8', 'demo-alex', 'Спасибо, посмотрю вечером', 75),
      message('d9', 'demo-anna', 'Договорились, на связи!', 120),
      message('d10', 'demo-notes', 'Идеи начинаются с одного сообщения.', 240, true),
    ].sort((a, b) => a.timestamp - b.timestamp),
    activeChatId: 'demo-maria',
    drafts: {},
  };
}

const replies = [
  'Сообщение получила! Всё работает ✨',
  'Да, вижу. Здорово, что можно спокойно обсудить всё в одном месте.',
  'Отлично, договорились. Остаёмся на связи 🙌',
  'Спасибо! Это автоматический ответ в деморежиме. В реальном чате здесь появится ответ собеседника.',
];
export const demoReply = (index: number): string => replies[index % replies.length];
