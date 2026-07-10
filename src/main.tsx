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
import { helloWorldPlugin, lifeAiCodePlugin } from './plugin'
import { createExtensionBridge } from './plugin/extensionBridge'
import { initWasm } from './utils/wasmLoader'
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

// 同步预加载核心 Worker：首屏编辑器（尤其是 TS/JS）必须立即可用
import('monaco-editor/esm/vs/editor/editor.worker?worker').then(m => { editorWorkerFactory = () => new m.default(); })
  .catch(() => console.warn('[main] editor.worker 预加载失败'));
import('monaco-editor/esm/vs/language/typescript/ts.worker?worker').then(m => { tsWorkerFactory = () => new m.default(); })
  .catch(() => console.warn('[main] ts.worker 预加载失败'));
import('monaco-editor/esm/vs/language/json/json.worker?worker').then(m => { jsonWorkerFactory = () => new m.default(); })
  .catch(() => console.warn('[main] json.worker 预加载失败'));
import('monaco-editor/esm/vs/language/html/html.worker?worker').then(m => { htmlWorkerFactory = () => new m.default(); })
  .catch(() => console.warn('[main] html.worker 预加载失败'));
import('monaco-editor/esm/vs/language/css/css.worker?worker').then(m => { cssWorkerFactory = () => new m.default(); })
  .catch(() => console.warn('[main] css.worker 预加载失败'));

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

// ─── 预加载 WASM 模块（异步非阻塞，加载完成后自动加速模糊搜索）───
// WASM 未编译时静默降级到 JS 实现，不影响功能可用性
initWasm();

// ─── 语言语法预置（同步加载，消除首屏高亮延迟）───
// 核心语言：TypeScript / JavaScript（富语言支持含语义高亮）
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js'
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution.js'
// 常用语言：提前同步加载，避免按需加载的 200-500ms 延迟
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/scss/scss.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/less/less.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js'
import 'monaco-editor/esm/vs/language/json/monaco.contribution.js'

// ─── 初始化插件系统 ───
const pluginManager = createPluginManager((pluginId, manifest) =>
  createPluginContext(pluginId, manifest, store)
);

// 注册示例插件
pluginManager.register(helloWorldPlugin.manifest);
pluginManager.register(lifeAiCodePlugin.manifest);

// 延迟激活插件（浏览器空闲时）
const activatePlugins = () => {
  pluginManager.activate(helloWorldPlugin).catch(console.error);
  pluginManager.activate(lifeAiCodePlugin).catch(console.error);
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

// 初始化扩展桥接（第三方扩展系统）
const initExtensionBridge = async () => {
  const bridge = createExtensionBridge(store);
  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__extensionBridge = bridge;
  }
  await bridge.initialize();
};

if (typeof requestIdleCallback !== 'undefined') {
  // 插件/扩展初始化完全异步，不阻塞首屏渲染与主线程事件循环
  requestIdleCallback(() => initExtensionBridge().catch(console.error), { timeout: 5000 });
} else {
  setTimeout(() => initExtensionBridge().catch(console.error), 500);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Provider store={store}>
      <RouterProvider router={router} />
    </Provider>
  </StrictMode>,
)
