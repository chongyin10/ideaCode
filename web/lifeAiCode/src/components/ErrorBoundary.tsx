import React from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[LifeAiCode] Runtime error:', error, errorInfo);
    this.setState({ errorInfo });
  }

  render() {
    if (this.state.hasError && this.state.error) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          justifyContent: 'flex-start',
          height: '100%',
          padding: 24,
          background: '#1a0f0f',
          color: '#fca5a5',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 12,
          lineHeight: 1.6,
          overflow: 'auto',
        }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#fecaca', marginBottom: 12 }}>
            ⚠ LifeAiCode 面板运行时错误
          </div>
          <div style={{ color: '#fca5a5', marginBottom: 16 }}>
            {this.state.error.message || String(this.state.error)}
          </div>
          {this.state.error.stack && (
            <details style={{ marginBottom: 12 }}>
              <summary style={{ cursor: 'pointer', color: '#fdba74' }}>调用栈</summary>
              <pre style={{
                marginTop: 8,
                padding: 12,
                background: 'rgba(0,0,0,0.3)',
                borderRadius: 6,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: 11,
                color: '#fcd34d',
              }}>{this.state.error.stack}</pre>
            </details>
          )}
          {this.state.errorInfo?.componentStack && (
            <details style={{ marginBottom: 12 }}>
              <summary style={{ cursor: 'pointer', color: '#fdba74' }}>组件栈</summary>
              <pre style={{
                marginTop: 8,
                padding: 12,
                background: 'rgba(0,0,0,0.3)',
                borderRadius: 6,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: 11,
                color: '#fcd34d',
              }}>{this.state.errorInfo.componentStack}</pre>
            </details>
          )}
          <button
            onClick={() => {
              this.setState({ hasError: false, error: null, errorInfo: null });
              window.location.reload();
            }}
            style={{
              marginTop: 8,
              padding: '6px 14px',
              background: '#7f1d1d',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
