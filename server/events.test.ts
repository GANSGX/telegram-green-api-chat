import { describe, expect, it } from 'vitest';
import { normalizeNotification } from './events.js';

const envelope = {
  typeWebhook: 'incomingMessageReceived',
  instanceData: { idInstance: 4100000000, typeInstance: 'telegram' },
  idMessage: '123',
  timestamp: 1750000000,
  senderData: { chatId: '-100123456789', sender: '777', chatName: 'Команда' },
  messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: 'Привет 👋' } },
};

describe('GREEN-API Telegram event normalization', () => {
  it('routes a group message by chatId instead of sender and converts seconds to milliseconds', () => {
    expect(normalizeNotification(envelope, '4100000000')).toEqual({
      kind: 'message',
      id: '123',
      chatId: '-100123456789',
      senderName: 'Команда',
      text: 'Привет 👋',
      timestamp: 1750000000000,
      outgoing: false,
    });
  });
  it('accepts extended text and outgoing API echoes', () => {
    expect(
      normalizeNotification(
        {
          ...envelope,
          typeWebhook: 'outgoingAPIMessageReceived',
          messageData: {
            typeMessage: 'extendedTextMessage',
            extendedTextMessageData: { text: 'https://example.com' },
          },
        },
        '4100000000',
      ),
    ).toMatchObject({ outgoing: true, text: 'https://example.com' });
  });
  it('maps noAccount to a failed delivery and ignores unsupported status values', () => {
    const status = {
      typeWebhook: 'outgoingMessageStatus',
      chatId: '777',
      idMessage: '123',
      status: 'noAccount',
    };
    expect(normalizeNotification(status, '4100000000')).toEqual({
      kind: 'status',
      chatId: '777',
      id: '123',
      status: 'failed',
    });
    expect(normalizeNotification({ ...status, status: 'invented' }, '4100000000')).toBeNull();
  });
  it('ignores malformed, foreign-instance, and unsupported media events without crashing', () => {
    for (const input of [
      null,
      'invalid',
      [],
      { ...envelope, senderData: undefined },
      { ...envelope, messageData: { typeMessage: 'imageMessage' } },
      { ...envelope, timestamp: NaN },
    ]) {
      expect(normalizeNotification(input, '4100000000')).toBeNull();
    }
    expect(normalizeNotification(envelope, '4100000001')).toBeNull();
  });
});
