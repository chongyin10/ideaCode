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
import { ensureLanguage } from './services/languageLoader'
import './i18n'
import './index.css'

// ─── Monaco Editor Worker 按需加载 ───
// 使用动态 import 替代同步 import，仅在需要时创建 Worker。
// Vite 的 `?worker` 后缀生成 Web Worker 入口。

// Worker 工厂函数（动态加载）
let editorWorkerFactory: (() => Worker) | null = null;
let jsonWorkerFactory: (() => Worker) | null = null;
let tsWorkerFactory: (() => Worker) | null = null;
let htmlWorkerFactory: (() => Worker) | null = null;
let cssWorkerFactory: (() => Worker) | null = null;

// 预取 Worker（不阻塞渲染）
const prefetchWorkers = () => {
  import('monaco-editor/esm/vs/editor/editor.worker?worker').then(m => { editorWorkerFactory = () => new m.default(); });
  import('monaco-editor/esm/vs/language/json/json.worker?worker').then(m => { jsonWorkerFactory = () => new m.default(); });
  import('monaco-editor/esm/vs/language/typescript/ts.worker?worker').then(m => { tsWorkerFactory = () => new m.default(); });
  import('monaco-editor/esm/vs/language/html/html.worker?worker').then(m => { htmlWorkerFactory = () => new m.default(); });
  import('monaco-editor/esm/vs/language/css/css.worker?worker').then(m => { cssWorkerFactory = () => new m.default(); });
};

// 同步导入兜底：首屏编辑器 Worker 必须可用
import('monaco-editor/esm/vs/editor/editor.worker?worker').then(m => { editorWorkerFactory = () => new m.default(); })
  .catch(() => console.warn('[main] 编辑器 Worker 预加载失败'));

self.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    // 按需动态创建 Worker
    // 每个 case 都有 factory → editorWorkerFactory 两层兜底
    if (label === 'json') {
      if (jsonWorkerFactory) return jsonWorkerFactory();
      return getEditorWorkerFallback();
    }
    if (label === 'css' || label === 'scss' || label === 'less') {
      if (cssWorkerFactory) return cssWorkerFactory();
      return getEditorWorkerFallback();
    }
    if (label === 'html' || label === 'handlebars' || label === 'razor') {
      if (htmlWorkerFactory) return htmlWorkerFactory();
      return getEditorWorkerFallback();
    }
    if (label === 'typescript' || label === 'javascript' || label === 'typescriptreact' || label === 'javascriptreact') {
      if (tsWorkerFactory) return tsWorkerFactory();
      return getEditorWorkerFallback();
    }
    return getEditorWorkerFallback();
  },
}

/** 编辑器 Worker 兜底：确保始终有可用 Worker */
function getEditorWorkerFallback(): Worker {
  if (editorWorkerFactory) return editorWorkerFactory();
  // 极端兜底：同步回退到动态 import+URL（Vite dev 下也能工作）
  // 注意：此处不用 ?worker 后缀，而是直接用原始模块路径
  return new Worker(
    new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
    { type: 'module' }
  );
}

// 使用本地 monaco 包
loader.config({ monaco })

// ─── 语言语法按需注册 ───
// 基础语言（几乎总是需要）：TS/JS
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js'

// 页面空闲时预取 Worker 和常用语言
if (typeof requestIdleCallback !== 'undefined') {
  requestIdleCallback(() => {
    prefetchWorkers();
  });
  requestIdleCallback(() => {
    ensureLanguage('html').catch(() => {});
    ensureLanguage('css').catch(() => {});
    ensureLanguage('json').catch(() => {});
  }, { timeout: 3000 });
} else {
  setTimeout(() => prefetchWorkers(), 0);
}

// ─── 初始化插件系统 ───
const pluginManager = createPluginManager((pluginId, manifest) =>
  createPluginContext(pluginId, manifest, store)
);

// 注册示例插件
pluginManager.register(helloWorldPlugin.manifest);

// 延迟激活插件（浏览器空闲时）
const activatePlugins = () => {
  pluginManager.activate(helloWorldPlugin).catch(console.error);
};

if (typeof requestIdleCallback !== 'undefined') {
  requestIdleCallback(activatePlugins, { timeout: 2000 });
} else {
  setTimeout(activatePlugins, 100);
}

// 将插件管理器挂载到全局
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
