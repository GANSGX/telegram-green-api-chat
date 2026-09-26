import { useState, type FormEvent } from 'react';
import {
  ArrowRight,
  CheckCheck,
  CircleAlert,
  ExternalLink,
  Eye,
  EyeOff,
  LoaderCircle,
  LockKeyhole,
  MessageCircle,
  Send,
  ShieldCheck,
} from 'lucide-react';
import type { Messenger } from '../lib/useMessenger';
import { Avatar, TelegramMark } from './ui';

export function LoginScreen({ messenger }: { messenger: Messenger }) {
  const [showToken, setShowToken] = useState(false);
  const [apiUrl, setApiUrl] = useState('https://4100.api.green-api.com');
  const [instance, setInstance] = useState('');
  const [token, setToken] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    await messenger.connect({
      apiUrl: apiUrl.trim(),
      idInstance: instance.trim(),
      apiTokenInstance: token.trim(),
    });
  }
  return (
    <main className="login-page">
      <header className="login-header">
        <div className="brand">
          <TelegramMark />
          <span>
            Telegram<span className="brand-divider"> / </span>
            <span className="green-word">GREEN-API</span>
          </span>
        </div>
        <a
          className="text-link"
          href="https://green-api.com/telegram/docs/before-start/"
          target="_blank"
          rel="noreferrer"
        >
          Как подключиться <ExternalLink size={14} />
        </a>
      </header>
      <div className="login-content">
        <section className="login-intro">
          <span className="eyebrow">ВАШ TELEGRAM. ВАШИ ДИАЛОГИ.</span>
          <h1>
            Разговор начинается
            <br />
            <span>с подключения.</span>
          </h1>
          <p className="intro-copy">
            Отправляйте сообщения и получайте ответы
            <br className="desktop-br" /> в привычном пространстве Telegram.
          </p>
          <div className="conversation-preview" aria-label="Пример переписки">
            <div className="preview-top">
              <Avatar name="Анна Смирнова" small />
              <div>
                <strong>Анна Смирнова</strong>
                <span>Пример диалога</span>
              </div>
              <MessageCircle size={19} />
            </div>
            <div className="preview-body">
              <div className="preview-bubble">
                Привет! На связи? <span>14·20</span>
              </div>
              <div className="preview-bubble outgoing">
                Да, всё работает ✨
                <span>
                  14·21 <CheckCheck size={15} />
                </span>
              </div>
              <div className="preview-bubble">
                Отлично, тогда до встречи!<span>14·21</span>
              </div>
            </div>
            <div className="preview-bottom">
              <span>Написать сообщение…</span>
              <Send size={18} />
            </div>
          </div>
          <div className="intro-foot">
            <ShieldCheck size={17} />
            <span>Токен хранится только в памяти сервера</span>
          </div>
        </section>
        <section className="login-card">
          <div className="card-kicker">
            <span className="green-api-logo">G</span> ПОДКЛЮЧЕНИЕ GREEN-API
          </div>
          <h2>Войти в Telegram</h2>
          <p className="card-copy">
            Введите данные Telegram-инстанса
            <br />
            из личного кабинета GREEN-API.
          </p>
          <form onSubmit={submit} className="login-form">
            <label>
              Адрес API
              <input
                name="apiUrl"
                type="url"
                autoComplete="url"
                required
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                placeholder="https://4100.api.green-api.com"
                spellCheck={false}
              />
            </label>
            <label>
              ID инстанса
              <input
                name="idInstance"
                inputMode="numeric"
                autoComplete="off"
                pattern="[0-9]+"
                required
                value={instance}
                onChange={(e) => setInstance(e.target.value)}
                placeholder="Например, 4100123456"
                spellCheck={false}
              />
            </label>
            <label>
              API-токен
              <span className="password-field">
                <input
                  name="apiTokenInstance"
                  type={showToken ? 'text' : 'password'}
                  autoComplete="off"
                  required
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="apiTokenInstance"
                  spellCheck={false}
                />
                <button
                  className="icon-button"
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  aria-label={showToken ? 'Скрыть токен' : 'Показать токен'}
                >
                  {showToken ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </span>
            </label>
            {messenger.error && (
              <div className="form-error" role="alert">
                <CircleAlert size={17} />
                <span>{messenger.error}</span>
              </div>
            )}
            <button
              className="primary-button"
              type="submit"
              disabled={messenger.isConnecting || !instance.trim() || !token.trim()}
            >
              {messenger.isConnecting ? (
                <>
                  <LoaderCircle size={18} className="spin" /> Подключаемся…
                </>
              ) : (
                <>
                  Подключиться <ArrowRight size={19} />
                </>
              )}
            </button>
          </form>
          <div className="or-divider">
            <span />
            или
            <span />
          </div>
          <button
            className="secondary-button demo-button"
            disabled={messenger.isConnecting}
            onClick={messenger.startDemo}
          >
            <MessageCircle size={18} /> Открыть демоверсию
          </button>
          <p className="demo-caption">Без аккаунта и отправки реальных сообщений</p>
          <div className="login-note">
            <LockKeyhole size={15} />
            <p>
              Инстанс должен быть авторизован в Telegram.
              <br />
              Данные доступа не сохраняются в браузере.
            </p>
          </div>
        </section>
      </div>
      <footer className="login-footer">
        <span>
          Telegram client <span className="footer-dot">·</span> React + GREEN-API
        </span>
        <span>Только текст. Всё необходимое для общения.</span>
      </footer>
    </main>
  );
}
