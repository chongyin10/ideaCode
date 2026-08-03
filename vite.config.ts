import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'
import { createRequire } from 'module'
import type { PluginBuild, OnLoadArgs } from 'esbuild'

const require = createRequire(import.meta.url)
const monacoNls = require('vite-plugin-monaco-editor-nls')
const MonacoEditorNlsPlugin = monacoNls.default || monacoNls
const { esbuildPluginMonacoEditorNls, Languages } = monacoNls

const monacoLocaleData = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, 'src/i18n/monaco-zh-hans.json'),
    'utf-8'
  )
)

/**
 * 修复 vite-plugin-monaco-editor-nls 在 dev 模式下未处理 localize2 的问题。
 *
 * 根因：esbuildPluginMonacoEditorNls 的 onLoad 会抢先处理所有 monaco-editor/esm/vs/*.js 文件，
 * 但其 transformLocalizeFuncCode 只注入 localize 的 module path，不处理 localize2。
 * 由于 esbuild onLoad 是「先到先得」，原 esbuildMonacoNlsLocalize2Fix 排在后面永远不会执行。
 * 未注入 path 的 localize2(data, msg) 会落入替换后的 localize2(path, data, defaultMsg)，
 * 参数错位导致 defaultMsg = undefined → 返回 { value: undefined, original: undefined }，
 * 右键菜单排序时 _compareTitles 取 a.original 调 localeCompare → 抛
 * "Cannot read properties of undefined (reading 'localeCompare')"。
 *
 * 修复：将本插件置于 esbuildPluginMonacoEditorNls 之前，统一注入 localize + localize2 的
 * module path；nls.js 交由 esbuildPluginMonacoEditorNls 替换整个文件。
 */
function esbuildMonacoNlsLocalize2Fix() {
  return {
    name: 'esbuild-monaco-nls-localize2-fix',
    setup(build: PluginBuild) {
      build.onLoad({ filter: new RegExp('monaco-editor[/\\\\]esm[/\\\\]vs.+\\.js$') }, async (args: OnLoadArgs) => {
        // nls.js 由 esbuildPluginMonacoEditorNls 整体替换，跳过
        if (/[\\/]vs[\\/]nls\.js$/.test(args.path)) return

        const source = await fs.promises.readFile(args.path, 'utf-8')
        const re = new RegExp('(?:monaco-editor[/\\\\]esm[/\\\\])(.+)(?=\\.js)')
        const match = re.exec(args.path)
        if (!match) return
        const modulePath = match[1].replace(/\\/g, '/')

        // 同时注入 localize 和 localize2 的 module path
        let code = source.replace(/localize\(/g, `localize('${modulePath}', `)
        code = code.replace(/localize2\(/g, `localize2('${modulePath}', `)
        return { contents: code, loader: 'js' }
      })
    },
  }
}

/**
 * Rollup 构建阶段补充：MonacoEditorNlsPlugin 的 transform 仅在模块存在于 locale 数据时
 * 才注入 path，且要求 code.includes('localize(')。对于只有 localize2 的文件或不在 locale
 * 数据中的模块，localize/localize2 调用不会被注入 path，同样会导致参数错位。
 *
 * 使用 enforce: 'post' 在 MonacoEditorNlsPlugin 之后运行，仅修补未被注入 path 的调用
 * （通过检测 localize2(/localize( 后首个参数是数字或 { 来判断未注入）。
 */
function rollupMonacoNlsLocalize2Fix() {
  return {
    name: 'rollup-monaco-nls-localize2-fix',
    enforce: 'post' as const,
    transform(code: string, filepath: string) {
      if (!/monaco-editor[\\/\\]esm[\\/\\]vs.+\.js/.test(filepath)) return
      if (/esm[\\/\\]vs[\\/\\].*nls\.js/.test(filepath)) return
      const re = /(?:monaco-editor[/\\]esm[/\\])(.+)(?=\.js)/
      const m = re.exec(filepath)
      if (!m) return
      const modulePath = m[1].replace(/\\/g, '/')
      // 仅匹配未被注入 path 的调用：首个参数为数字或 {（已注入的为字符串引号）
      let patched = code.replace(/localize\(([\d{])/g, `localize('${modulePath}', $1`)
      patched = patched.replace(/localize2\(([\d{])/g, `localize2('${modulePath}', $1`)
      if (patched === code) return
      return { code: patched, map: null }
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  base: './',
  plugins: [
    react(),
    MonacoEditorNlsPlugin({
      locale: Languages.zh_hans,
      localeData: monacoLocaleData,
    }),
    rollupMonacoNlsLocalize2Fix(),
  ],
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
      },
    },
  },
  optimizeDeps: {
    include: [
      'monaco-editor/esm/vs/language/css/cssMode',
      'monaco-editor/esm/vs/language/typescript/tsMode',
      'monaco-editor/esm/vs/language/json/jsonMode',
      'monaco-editor/esm/vs/language/html/htmlMode',
    ],
    esbuildOptions: {
      plugins: [
        esbuildMonacoNlsLocalize2Fix(),
        esbuildPluginMonacoEditorNls({
          locale: Languages.zh_hans,
          localeData: monacoLocaleData,
        }),
      ],
    },
  },
})
