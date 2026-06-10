import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { Provider } from 'react-redux'
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import { store } from './store'
import router from './router'
import { createPluginManager } from './plugin'
import { createPluginContext } from './plugin'
import { helloWorldPlugin } from './plugin'
import './index.css'

// 配置 Monaco Editor 使用本地 worker（替代 CDN，支持断网使用）
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'

self.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  },
}

// 使用本地 monaco 包，彻底脱离 CDN
loader.config({ monaco })

// ─── 初始化插件系统 ───
const pluginManager = createPluginManager((pluginId, manifest) =>
  createPluginContext(pluginId, manifest, store)
);

// 注册并激活示例插件
pluginManager.register(helloWorldPlugin.manifest);
pluginManager.activate(helloWorldPlugin).catch(console.error);

// 将插件管理器挂载到全局，方便调试
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__pluginManager = pluginManager;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Provider store={store}>
      <RouterProvider router={router} />
    </Provider>
  </StrictMode>,
)
