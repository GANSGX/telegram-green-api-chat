import { useState, type FormEvent } from 'react';
import { CircleAlert, Eye, EyeOff, LoaderCircle } from 'lucide-react';
import type { Messenger } from '../lib/useMessenger';
import { TelegramMark } from './ui';

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
      <section className="login-content" aria-labelledby="login-heading">
        <TelegramMark large />
        <h1 id="login-heading" className="login-heading">
          Telegram
        </h1>
        <p className="login-description">
          Для подключения введите данные вашего Telegram-инстанса GREEN-API.
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
              onChange={(event) => setApiUrl(event.target.value)}
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
              onChange={(event) => setInstance(event.target.value)}
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
                onChange={(event) => setToken(event.target.value)}
                placeholder="apiTokenInstance"
                spellCheck={false}
              />
              <button
                className="icon-button"
                type="button"
                onClick={() => setShowToken(!showToken)}
                aria-label={showToken ? 'Скрыть токен' : 'Показать токен'}
              >
                {showToken ? <EyeOff size={20} /> : <Eye size={20} />}
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
                <LoaderCircle size={20} className="spin" /> Подключаемся…
              </>
            ) : (
              'Подключиться'
            )}
          </button>
        </form>
        <button
          className="demo-button"
          disabled={messenger.isConnecting}
          onClick={messenger.startDemo}
        >
          Открыть демоверсию
        </button>
        <a
          className="login-help"
          href="https://green-api.com/telegram/docs/before-start/"
          target="_blank"
          rel="noreferrer"
        >
          Как подключить Telegram
        </a>
      </section>
    </main>
  );
}
