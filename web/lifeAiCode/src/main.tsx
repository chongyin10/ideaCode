import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './index.css'

// 注意：使用 StrictMode 在 dev 模式下会双调 effect（产生重复的 postMessage / 重复计时器）
// 这里关掉以避免重复的 requestConfig / setTimeout 等副作用
ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
)
