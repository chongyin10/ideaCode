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
    if (label === 'typescript' || label === 'javascript' || label === 'typescriptreact' || label === 'javascriptreact') return new tsWorker()
    return new editorWorker()
  },
}

// 使用本地 monaco 包，彻底脱离 CDN
loader.config({ monaco })

// 确保 TypeScript/JSX 语言注册（防止 Vite tree-shaking 丢弃）
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js'

// ─── 自定义编辑器主题 ───
// 基于 vs-dark，覆盖语义 token 和 Monarch token 着色
// 语义 token 类型（如 function/method/variable）通过 rules 规则名称匹配
// 注：TSX 中 JSX 标签名（如 div）被 Monarch 语法标记为 identifier，而非 tag
monaco.editor.defineTheme('ideacode-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    // 方法/函数 → 橘色 (用户期望)
    { token: 'function', foreground: 'DADAAE' },
    { token: 'method', foreground: 'DADAAE' },
    { token: 'member', foreground: 'DADAAE' },
    // JSX 标签名（identifier）→ 与变量相同的浅蓝色
    // TypeScript Monarch 语法将 `<div>` 中的 `div` 标记为 identifier
    { token: 'identifier', foreground: '6DBBF5' },
    // 变量显式设置为浅蓝色（确保一致性）
    { token: 'variable', foreground: '6DBBF5' },
    { token: 'variable.readonly', foreground: '6DBBF5' },
    { token: 'property', foreground: '6DBBF5' },
    { token: 'parameter', foreground: '6DBBF5' },
    // JSX 尖括号 < > → 干净蓝灰色（默认 bracket 映射为 delimiter.angle）
    { token: 'delimiter.angle', foreground: '9BA4B5' },
    // </ 闭合标签及其他分隔符（逗号、分号等）→ 与尖括号一致的蓝灰色
    { token: 'delimiter', foreground: '9BA4B5' },
  ],
  colors: {},
})

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
