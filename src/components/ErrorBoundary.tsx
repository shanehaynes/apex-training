import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last-resort catch for render/lifecycle throws — without it any render error
 * white-screens the whole app. Recovery is a full reload: safest option, and
 * all durable state lives server-side or in localStorage anyway.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[apex] Render error:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="auth-screen" role="alert">
        <div className="auth-card">
          <h1 className="error-boundary__title">Something went wrong</h1>
          <p className="error-boundary__body">
            The app hit an unexpected error. Your training data is safe —
            reloading should bring everything back.
          </p>
          <button className="auth-submit" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
