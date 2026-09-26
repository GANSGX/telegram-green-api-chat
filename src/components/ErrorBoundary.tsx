import { Component, type ErrorInfo, type ReactNode } from 'react';
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    /* Intentionally do not log conversation data. */
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="restoring">
        <h1>Не удалось открыть приложение</h1>
        <p>Попробуйте перезагрузить страницу.</p>
        <button
          className="primary-button"
          style={{ width: 'auto' }}
          onClick={() => window.location.reload()}
        >
          Перезагрузить
        </button>
      </main>
    );
  }
}
