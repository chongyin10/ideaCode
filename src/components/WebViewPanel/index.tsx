import { useRef, useEffect } from 'react';
import './WebViewPanel.css';

interface WebViewPanelProps {
  html: string;
  panelId: string;
  extensionPath?: string;
}

/**
 * WebView 面板组件
 * 
 * 使用 iframe 渲染插件提供的 HTML 内容，实现与核心代码的隔离。
 * 插件通过 postMessage 与核心通信。
 */
const WebViewPanel = ({ html, panelId, extensionPath }: WebViewPanelProps) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    // 注入 VSCode WebView API 兼容层，使插件 WebView 能调用 acquireVsCodeApi
    // 注意：acquireVsCodeApi 必须是单例，否则 WebView 每次渲染都会拿到新对象，
    // 触发依赖它的 useEffect 反复执行（如无限发送 requestConfig）。
    const vscodeApiScript = `
<script>
(function() {
  var state = {};
  var api = null;
  window.acquireVsCodeApi = function() {
    if (!api) {
      api = {
        postMessage: function(message) {
          window.parent.postMessage(message, '*');
        },
        getState: function() {
          return state;
        },
        setState: function(newState) {
          state = newState;
        }
      };
    }
    return api;
  };
})();
</script>
`;

    // 处理 webview-asset:// URI
    let processedHtml = html;
    if (extensionPath) {
      processedHtml = html.replace(
        /(src|href)="webview-asset:\/\//g,
        `$1="file://${extensionPath}/webview/`
      );
    }

    // 将 acquireVsCodeApi 注入到 <head> 末尾或 <body> 开头
    if (processedHtml.includes('</head>')) {
      processedHtml = processedHtml.replace('</head>', `${vscodeApiScript}</head>`);
    } else if (processedHtml.includes('<body>')) {
      processedHtml = processedHtml.replace('<body>', `<body>${vscodeApiScript}`);
    } else {
      processedHtml = vscodeApiScript + processedHtml;
    }

    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (doc) {
      doc.open();
      doc.write(processedHtml);
      doc.close();
    }
  }, [html, extensionPath]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return;
      const message = event.data;
      if (message && message.command) {
        window.electronAPI?.extension?.rpc('webview.message', {
          id: panelId,
          message,
        }).catch(console.error);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [panelId]);

  // 接收 Extension Host 发来的消息并转发到 iframe
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let timeoutId: ReturnType<typeof setTimeout>;

    const trySubscribe = () => {
      const bridge = (window as unknown as Record<string, unknown>).__extensionBridge as {
        onWebViewMessage?: (id: string, callback: (message: unknown) => void) => (() => void);
      } | undefined;
      if (bridge?.onWebViewMessage) {
        unsubscribe = bridge.onWebViewMessage(panelId, (message) => {
          const iframe = iframeRef.current;
          if (iframe && iframe.contentWindow) {
            iframe.contentWindow.postMessage(message, '*');
          }
        });
      } else {
        timeoutId = setTimeout(trySubscribe, 100);
      }
    };

    trySubscribe();
    return () => {
      clearTimeout(timeoutId);
      unsubscribe?.();
    };
  }, [panelId]);

  return (
    <div className="webview-panel">
      <iframe
        ref={iframeRef}
        className="webview-panel__iframe"
        sandbox="allow-scripts allow-same-origin allow-popups allow-modals"
        allowFullScreen
        title={panelId}
      />
    </div>
  );
};

export default WebViewPanel;
