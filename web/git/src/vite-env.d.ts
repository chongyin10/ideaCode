/// <reference types="vite/client" />

// IDEACODE 注入的 WebView 桥接口
declare global {
  interface Window {
    __IDEACODE_WEBVIEW_API__?: {
      postMessage: (message: unknown) => void;
      onMessage: (callback: (msg: any) => void) => () => void;
    };
  }
}

export {};