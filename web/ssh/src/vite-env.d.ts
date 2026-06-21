/// <reference types="vite/client" />

// IDEACODE WebView 全局 API
declare global {
  interface Window {
    /** VSCode 风格的 WebView API */
    acquireVsCodeApi?: () => {
      postMessage: (message: unknown) => void;
      setState: (state: unknown) => void;
      getState: () => unknown;
    };
  }
}

export {}
