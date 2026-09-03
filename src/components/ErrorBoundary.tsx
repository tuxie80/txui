import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { error: Error | null; info: string }

/**
 * Top-level error boundary — a render/lifecycle exception would otherwise
 * leave the WKWebView showing a frozen, unresponsive tree. This surfaces the
 * actual error (copyable) and a Reload button instead.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ error, info: info.componentStack ?? '' });
    // also to the console for devtools
    console.error('Uncaught render error:', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const text = `${this.state.error.message}\n\n${this.state.error.stack ?? ''}\n\n${this.state.info}`;
    return (
      <div style={{ padding: 24, fontFamily: 'monospace', color: 'var(--text)', overflow: 'auto', height: '100vh' }}>
        <h2 style={{ color: 'var(--red)' }}>Something broke while rendering</h2>
        <p style={{ color: 'var(--text2)' }}>The UI hit an exception. Copy this and reload:</p>
        <pre style={{ whiteSpace: 'pre-wrap', background: 'var(--bg2)', padding: 12, borderRadius: 6, userSelect: 'text' }}>{text}</pre>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="primary" onClick={() => location.reload()}>Reload</button>
          <button className="toolbar-btn" onClick={() => navigator.clipboard.writeText(text).catch(() => {})}>Copy error</button>
        </div>
      </div>
    );
  }
}
