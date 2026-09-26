import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from './api';
import {
  addChat,
  applyEvent,
  confirmMessage,
  emptyHistory,
  messageKey,
  nextStatus,
  selectChat as selectHistoryChat,
  upsertMessage,
  type StatusLedger,
} from './domain';
import { createDemoHistory, demoReply } from './demo';
import { clearHistory, loadHistory, saveHistory } from './storage';
import { attachmentValidationError, mediaKind } from './media';
import {
  MAX_MESSAGE_LENGTH,
  type Chat,
  type AttachmentOptions,
  type ConnectionState,
  type Credentials,
  type HistoryState,
  type Message,
  type MediaAttachment,
  type MessengerMode,
  type Session,
} from './types';

const loggedOut: Session = { authenticated: false };
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Произошла ошибка. Попробуйте ещё раз.';
const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError';

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (signal.aborted) done();
    else signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * UI contract
 * - messages includes all chats; activeMessages is sorted and scoped to activeChat.
 * - drafts survive chat switches and are scoped to this browser tab and instance.
 * - no API credentials enter browser storage. Logout clears cached chat history.
 * - actions report errors in `error`; connect/enableNotifications return success.
 * - only `failed` messages may be retried. `unknown` requires manual verification.
 * - demo is a separate, explicitly labelled mode and never sends network messages.
 */
export function useMessenger() {
  const [session, setSession] = useState<Session>(loggedOut);
  const [mode, setMode] = useState<MessengerMode>('login');
  const [history, setHistory] = useState<HistoryState>(emptyHistory);
  const [connection, setConnection] = useState<ConnectionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isCreatingChat, setIsCreatingChat] = useState(false);
  const [isEnablingNotifications, setIsEnablingNotifications] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const historyRef = useRef(history);
  const modeRef = useRef(mode);
  const sessionRef = useRef(session);
  const generation = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const demoTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const cursor = useRef(0);
  const ledger = useRef<StatusLedger>(new Map());
  const demoReplyIndex = useRef(0);
  const busyConnect = useRef(false);
  const busyResolve = useRef(false);
  const busyNotifications = useRef(false);
  const busyLogout = useRef(false);
  const sendInFlight = useRef(new Set<string>());
  const uploadInFlight = useRef(new Set<string>());
  const originalFiles = useRef(new Map<string, { file: File; options: AttachmentOptions }>());
  const localMediaUrls = useRef(new Set<string>());

  const updateHistory = useCallback(
    (change: HistoryState | ((previous: HistoryState) => HistoryState)) => {
      const next = typeof change === 'function' ? change(historyRef.current) : change;
      historyRef.current = next;
      setHistory(next);
    },
    [],
  );
  const updateSession = useCallback((next: Session) => {
    sessionRef.current = next;
    setSession(next);
  }, []);
  const updateMode = useCallback((next: MessengerMode) => {
    modeRef.current = next;
    setMode(next);
  }, []);
  const invalidate = useCallback(() => {
    generation.current += 1;
    controllers.current.forEach((controller) => controller.abort());
    controllers.current.clear();
    demoTimers.current.forEach(clearTimeout);
    demoTimers.current.clear();
    sendInFlight.current.clear();
    uploadInFlight.current.clear();
    originalFiles.current.clear();
    localMediaUrls.current.forEach((url) => URL.revokeObjectURL(url));
    localMediaUrls.current.clear();
    setIsUploading(false);
    ledger.current.clear();
    cursor.current = 0;
    busyResolve.current = false;
    busyNotifications.current = false;
    setIsCreatingChat(false);
    setIsEnablingNotifications(false);
  }, []);
  const controller = useCallback(() => {
    const next = new AbortController();
    controllers.current.add(next);
    return next;
  }, []);
  const activateLive = useCallback(
    (next: Session) => {
      updateSession(next);
      updateHistory(next.instanceId ? loadHistory(next.instanceId) : emptyHistory());
      updateMode('live');
      setConnection(next.state === 'authorized' ? 'connected' : 'reconnecting');
      setError(null);
    },
    [updateHistory, updateMode, updateSession],
  );

  useEffect(() => {
    const pending = controller();
    const epoch = generation.current;
    api
      .session(pending.signal)
      .then((next) => {
        if (generation.current === epoch && !pending.signal.aborted && next.authenticated)
          activateLive(next);
      })
      .catch((failure: unknown) => {
        if (
          generation.current === epoch &&
          !isAbort(failure) &&
          !(failure instanceof ApiError && failure.status === 401)
        )
          setError(errorMessage(failure));
      })
      .finally(() => {
        controllers.current.delete(pending);
        if (generation.current === epoch) setIsRestoring(false);
      });
    return invalidate;
  }, [activateLive, controller, invalidate]);

  useEffect(() => {
    if (mode !== 'live' || !session.instanceId) return;
    setStorageAvailable(saveHistory(session.instanceId, history));
  }, [mode, session.instanceId, history]);

  useEffect(() => {
    const visibleUrls = new Set(historyRef.current.messages.map((message) => message.media?.url));
    for (const url of localMediaUrls.current) {
      if (!visibleUrls.has(url)) {
        URL.revokeObjectURL(url);
        localMediaUrls.current.delete(url);
      }
    }
    for (const clientId of originalFiles.current.keys()) {
      const message = historyRef.current.messages.find((item) => item.clientId === clientId);
      if (!message || message.status === 'delivered' || message.status === 'read') {
        originalFiles.current.delete(clientId);
      }
    }
  }, [history.messages]);

  useEffect(() => {
    if (mode !== 'live' || !session.authenticated) return;
    const pending = controller();
    const epoch = generation.current;
    let failures = 0;
    let lastConnection: ConnectionState | undefined;
    const current = () => generation.current === epoch && !pending.signal.aborted;
    const run = async () => {
      while (current()) {
        try {
          const batch = await api.events(cursor.current, pending.signal);
          if (!current()) break;
          if (failures > 0)
            setConnection(
              lastConnection ??
                (sessionRef.current.state === 'authorized' ? 'connected' : 'reconnecting'),
            );
          failures = 0;
          cursor.current = batch.cursor;
          let refreshSession = false;
          for (const event of batch.events) {
            if (event.kind === 'connection') {
              setConnection(event.state);
              if (event.message) setError(event.message);
              if (lastConnection !== event.state) refreshSession = true;
              lastConnection = event.state;
            } else updateHistory((previous) => applyEvent(previous, event, ledger.current));
          }
          if (refreshSession) {
            const fresh = await api.session(pending.signal);
            if (current()) updateSession(fresh);
          }
          // The BFF normally long-polls. Bound empty immediate replies too.
          if (!batch.events.length) await pause(300, pending.signal);
        } catch (failure) {
          if (!current() || isAbort(failure)) break;
          if (
            failure instanceof ApiError &&
            failure.code === 'EVENTS_EXPIRED' &&
            typeof failure.cursor === 'number'
          ) {
            cursor.current = failure.cursor;
            setError(
              'Соединение долго отсутствовало. Часть сообщений могла не сохраниться здесь. Проверьте историю в Telegram.',
            );
            continue;
          }
          if (failure instanceof ApiError && failure.status === 401) {
            invalidate();
            setConnection('unauthorized');
            updateSession(loggedOut);
            updateMode('login');
            setError('Сессия завершилась. Подключите аккаунт снова.');
            break;
          }
          failures += 1;
          setConnection('reconnecting');
          if (failures === 1) setError(errorMessage(failure));
          await pause(
            Math.min(20_000, 1000 * 2 ** Math.min(failures - 1, 5)) + Math.random() * 500,
            pending.signal,
          );
        }
      }
    };
    void run();
    return () => {
      pending.abort();
      controllers.current.delete(pending);
    };
  }, [
    mode,
    session.authenticated,
    session.instanceId,
    controller,
    invalidate,
    updateHistory,
    updateMode,
    updateSession,
  ]);

  const connect = useCallback(
    async (credentials: Credentials): Promise<boolean> => {
      if (busyConnect.current || busyLogout.current || modeRef.current === 'live') return false;
      busyConnect.current = true;
      invalidate();
      const epoch = generation.current;
      const pending = controller();
      setIsConnecting(true);
      setError(null);
      try {
        const next = await api.connect(credentials, pending.signal);
        if (epoch !== generation.current) return false;
        if (!next.authenticated) throw new Error('Не удалось подтвердить доступ к аккаунту');
        activateLive(next);
        setIsRestoring(false);
        return true;
      } catch (failure) {
        if (epoch === generation.current && !isAbort(failure)) setError(errorMessage(failure));
        return false;
      } finally {
        controllers.current.delete(pending);
        if (epoch === generation.current) {
          busyConnect.current = false;
          setIsConnecting(false);
        }
      }
    },
    [activateLive, controller, invalidate],
  );

  const startDemo = useCallback(() => {
    if (busyConnect.current || busyLogout.current || modeRef.current === 'live') return;
    invalidate();
    busyConnect.current = false;
    setIsConnecting(false);
    updateSession(loggedOut);
    updateHistory(createDemoHistory());
    updateMode('demo');
    setConnection('connected');
    setError(null);
    setIsRestoring(false);
    demoReplyIndex.current = 0;
  }, [invalidate, updateHistory, updateMode, updateSession]);

  const logout = useCallback(async () => {
    if (busyLogout.current) return;
    busyLogout.current = true;
    setIsLoggingOut(true);
    const wasLive = modeRef.current === 'live';
    const instanceId = sessionRef.current.instanceId;
    setError(null);
    try {
      if (wasLive) await api.logout();
      invalidate();
      busyConnect.current = false;
      setIsConnecting(false);
      if (instanceId) clearHistory(instanceId);
      updateSession(loggedOut);
      updateHistory(emptyHistory());
      updateMode('login');
      setConnection('idle');
      setIsRestoring(false);
    } catch (failure) {
      setError(
        'Не удалось подтвердить выход. Попробуйте отключиться ещё раз. ' + errorMessage(failure),
      );
    } finally {
      busyLogout.current = false;
      setIsLoggingOut(false);
    }
  }, [invalidate, updateHistory, updateMode, updateSession]);

  const selectChat = useCallback(
    (chatId: string) => updateHistory((previous) => selectHistoryChat(previous, chatId)),
    [updateHistory],
  );
  const setDraft = useCallback(
    (text: string) =>
      updateHistory((previous) =>
        previous.activeChatId
          ? { ...previous, drafts: { ...previous.drafts, [previous.activeChatId]: text } }
          : previous,
      ),
    [updateHistory],
  );

  const createChat = useCallback(
    async (recipient: string, name?: string): Promise<Chat | null> => {
      const normalized = recipient.trim();
      if (!normalized || modeRef.current === 'login' || busyResolve.current || busyLogout.current)
        return null;
      if (
        !/^@[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(normalized) &&
        !/^\+?[\d\s()-]{5,25}$/.test(normalized)
      ) {
        setError('Введите @username или номер телефона в международном формате');
        return null;
      }
      busyResolve.current = true;
      setIsCreatingChat(true);
      setError(null);
      const epoch = generation.current;
      const pending = controller();
      try {
        const resolved =
          modeRef.current === 'demo'
            ? { chatId: `demo-${normalized.replace(/[^\w]/g, '').toLowerCase()}`, name: normalized }
            : await api.resolve(normalized, pending.signal);
        if (epoch !== generation.current) return null;
        const chat: Chat = {
          id: resolved.chatId,
          name: name?.trim() || resolved.name || normalized,
          recipient: normalized,
          unread: 0,
        };
        updateHistory((previous) => addChat(previous, chat));
        return chat;
      } catch (failure) {
        if (epoch === generation.current && !isAbort(failure)) setError(errorMessage(failure));
        return null;
      } finally {
        controllers.current.delete(pending);
        if (epoch === generation.current) {
          busyResolve.current = false;
          setIsCreatingChat(false);
        }
      }
    },
    [controller, updateHistory],
  );

  const scheduleDemo = useCallback(
    (message: Message, epoch: number) => {
      const schedule = (delay: number, action: () => void) => {
        const timer = setTimeout(() => {
          demoTimers.current.delete(timer);
          if (epoch === generation.current) action();
        }, delay);
        demoTimers.current.add(timer);
      };
      schedule(450, () =>
        updateHistory((previous) => ({
          ...previous,
          messages: previous.messages.map((item) =>
            item.id === message.id ? { ...item, status: 'delivered' } : item,
          ),
        })),
      );
      schedule(1000, () =>
        updateHistory((previous) => ({
          ...previous,
          messages: previous.messages.map((item) =>
            item.id === message.id ? { ...item, status: 'read' } : item,
          ),
        })),
      );
      const reply = demoReply(demoReplyIndex.current++);
      schedule(1600, () =>
        updateHistory((previous) =>
          applyEvent(previous, {
            kind: 'message',
            id: crypto.randomUUID(),
            chatId: message.chatId,
            senderName: previous.chats.find((chat) => chat.id === message.chatId)?.name,
            text: reply,
            timestamp: Date.now(),
            outgoing: false,
          }),
        ),
      );
    },
    [updateHistory],
  );

  const dispatchMessage = useCallback(
    async (message: Message) => {
      const clientId = message.clientId!;
      if (sendInFlight.current.has(clientId)) return;
      const original = message.media ? originalFiles.current.get(clientId) : undefined;
      if (message.media && !original) {
        const text = 'Исходный файл больше недоступен. Выберите его заново, чтобы отправить.';
        setError(text);
        updateHistory((previous) => ({
          ...previous,
          messages: previous.messages.map((item) =>
            item.clientId === clientId ? { ...item, status: 'failed', error: text } : item,
          ),
        }));
        return;
      }
      sendInFlight.current.add(clientId);
      const epoch = generation.current;
      if (modeRef.current === 'demo') {
        updateHistory((previous) => confirmMessage(previous, clientId, message.id));
        scheduleDemo(message, epoch);
        sendInFlight.current.delete(clientId);
        return;
      }
      const pending = controller();
      if (original) {
        uploadInFlight.current.add(clientId);
        setIsUploading(true);
      }
      try {
        const response: { idMessage: string; media?: MediaAttachment } = original
          ? await api.sendMedia(
              message.chatId,
              original.file,
              clientId,
              original.options,
              pending.signal,
            )
          : await api.send(message.chatId, message.text, clientId, pending.signal);
        if (epoch !== generation.current) return;
        updateHistory((previous) => {
          const confirmed = confirmMessage(previous, clientId, response.idMessage, response.media);
          const earlierStatus = ledger.current.get(messageKey(message.chatId, response.idMessage));
          return earlierStatus && earlierStatus.status !== 'sending'
            ? applyEvent(
                confirmed,
                {
                  kind: 'status',
                  id: response.idMessage,
                  chatId: message.chatId,
                  status: earlierStatus.status,
                  description: earlierStatus.description,
                },
                ledger.current,
              )
            : confirmed;
        });
      } catch (failure) {
        if (epoch !== generation.current || isAbort(failure)) return;
        const ambiguous = !(failure instanceof ApiError) || failure.ambiguous;
        const text = errorMessage(failure);
        updateHistory((previous) => ({
          ...previous,
          messages: previous.messages.map((item) => {
            if (item.clientId !== clientId) return item;
            const status = nextStatus(item.status, ambiguous ? 'unknown' : 'failed');
            return {
              ...item,
              status,
              error: status === 'failed' || status === 'unknown' ? text : undefined,
            };
          }),
        }));
        setError(text);
        if (failure instanceof ApiError && failure.status === 401) setConnection('unauthorized');
      } finally {
        controllers.current.delete(pending);
        sendInFlight.current.delete(clientId);
        if (epoch === generation.current) {
          uploadInFlight.current.delete(clientId);
          setIsUploading(uploadInFlight.current.size > 0);
        }
      }
    },
    [controller, scheduleDemo, updateHistory],
  );

  const sendAttachment = useCallback(
    async (file: File, options: AttachmentOptions = {}): Promise<void> => {
      const chatId = historyRef.current.activeChatId;
      if (!chatId || modeRef.current === 'login' || busyLogout.current) return;
      const validationError = attachmentValidationError(file, options);
      if (validationError) {
        setError(validationError);
        return;
      }
      const id = crypto.randomUUID();
      let url: string;
      try {
        url = URL.createObjectURL(file);
      } catch {
        setError('Не удалось открыть файл. Выберите его ещё раз.');
        return;
      }
      localMediaUrls.current.add(url);
      originalFiles.current.set(id, { file, options: { ...options } });
      const message: Message = {
        id,
        clientId: id,
        chatId,
        text: options.caption ?? '',
        timestamp: Date.now(),
        outgoing: true,
        status: 'sending',
        media: {
          id,
          kind: mediaKind(file.type),
          fileName: file.name || 'Файл',
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          url,
        },
      };
      setError(null);
      updateHistory((previous) => ({
        ...previous,
        messages: upsertMessage(previous.messages, message),
        drafts:
          options.caption !== undefined && previous.drafts[chatId] === options.caption
            ? { ...previous.drafts, [chatId]: '' }
            : previous.drafts,
      }));
      await dispatchMessage(message);
    },
    [dispatchMessage, updateHistory],
  );

  const sendMessage = useCallback(
    async (text?: string) => {
      const chatId = historyRef.current.activeChatId;
      if (!chatId || modeRef.current === 'login' || busyLogout.current) return;
      const messageText = (text ?? historyRef.current.drafts[chatId] ?? '').trim();
      if (!messageText) return;
      if (messageText.length > MAX_MESSAGE_LENGTH) {
        setError('Сообщение может содержать не больше 4096 символов');
        return;
      }
      const id = crypto.randomUUID();
      const message: Message = {
        id,
        clientId: id,
        chatId,
        text: messageText,
        timestamp: Date.now(),
        outgoing: true,
        status: 'sending',
      };
      setError(null);
      updateHistory((previous) => ({
        ...previous,
        messages: upsertMessage(previous.messages, message),
        drafts: { ...previous.drafts, [chatId]: '' },
      }));
      await dispatchMessage(message);
    },
    [dispatchMessage, updateHistory],
  );

  const retryMessage = useCallback(
    async (id: string) => {
      const message = historyRef.current.messages.find((item) => item.id === id);
      if (
        !message ||
        message.status !== 'failed' ||
        !message.clientId ||
        modeRef.current === 'login' ||
        busyLogout.current
      )
        return;
      const original = message.media ? originalFiles.current.get(message.clientId) : undefined;
      if (message.media && !original) {
        const text = 'Исходный файл больше недоступен. Выберите его заново, чтобы отправить.';
        setError(text);
        updateHistory((previous) => ({
          ...previous,
          messages: previous.messages.map((item) =>
            item === message ? { ...item, error: text } : item,
          ),
        }));
        return;
      }
      const next: Message = {
        ...message,
        id: crypto.randomUUID(),
        clientId: crypto.randomUUID(),
        status: 'sending',
        error: undefined,
      };
      if (original) {
        originalFiles.current.set(next.clientId!, original);
        originalFiles.current.delete(message.clientId);
      }
      updateHistory((previous) => ({
        ...previous,
        messages: previous.messages.map((item) => (item === message ? next : item)),
      }));
      await dispatchMessage(next);
    },
    [dispatchMessage, updateHistory],
  );

  const enableNotifications = useCallback(async (): Promise<boolean> => {
    if (modeRef.current !== 'live' || busyNotifications.current || busyLogout.current) return false;
    busyNotifications.current = true;
    setIsEnablingNotifications(true);
    setError(null);
    const epoch = generation.current;
    const pending = controller();
    try {
      const next = await api.enableNotifications(pending.signal);
      if (epoch !== generation.current) return false;
      updateSession(next);
      setConnection('reconnecting');
      return true;
    } catch (failure) {
      if (epoch === generation.current && !isAbort(failure)) setError(errorMessage(failure));
      return false;
    } finally {
      controllers.current.delete(pending);
      if (epoch === generation.current) {
        busyNotifications.current = false;
        setIsEnablingNotifications(false);
      }
    }
  }, [controller, updateSession]);

  const activeChat = useMemo(
    () => history.chats.find((chat) => chat.id === history.activeChatId) ?? null,
    [history.chats, history.activeChatId],
  );
  const activeMessages = useMemo(
    () => history.messages.filter((message) => message.chatId === history.activeChatId),
    [history.messages, history.activeChatId],
  );
  return {
    session,
    mode,
    chats: history.chats,
    messages: history.messages,
    activeChatId: history.activeChatId,
    activeChat,
    activeMessages,
    connection,
    error,
    isRestoring,
    isConnecting,
    isCreatingChat,
    isEnablingNotifications,
    isLoggingOut,
    isUploading,
    storageAvailable,
    drafts: history.drafts,
    draft: history.activeChatId ? (history.drafts[history.activeChatId] ?? '') : '',
    connect,
    startDemo,
    logout,
    selectChat,
    createChat,
    sendMessage,
    sendAttachment,
    retryMessage,
    enableNotifications,
    setDraft,
    clearError: () => setError(null),
  };
}

export type Messenger = ReturnType<typeof useMessenger>;
