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
    path.resolve(__dirname, 'node_modules/vite-plugin-monaco-editor-nls/dist/locale/src/locale/zh-hans.json'),
    'utf-8'
  )
)

/**
 * 修复 vite-plugin-monaco-editor-nls 在 dev 模式下未处理 localize2 的问题。
 * Monaco 0.50+ 大量内置文案使用 localize2，本插件在 esbuild 预编译阶段只替换了 localize，
 * 会导致 dev 时部分菜单项仍为英文或报错。该插件在 rollup 构建阶段已处理 localize2，
 * 因此只需在 esbuild 预编译阶段补充 localize2 的 path 注入。
 */
function esbuildMonacoNlsLocalize2Fix() {
  return {
    name: 'esbuild-monaco-nls-localize2-fix',
    setup(build: PluginBuild) {
      build.onLoad({ filter: new RegExp('monaco-editor[/\\\\]esm[/\\\\]vs.+\\.js$') }, async (args: OnLoadArgs) => {
        const source = await fs.promises.readFile(args.path, 'utf-8')
        if (!source.includes('localize2(')) return
        const re = new RegExp('(?:monaco-editor[/\\\\]esm[/\\\\])(.+)(?=\\.js)')
        const match = re.exec(args.path)
        if (!match) return
        const modulePath = match[1].replace(/\\/g, '/')
        if (!monacoLocaleData[modulePath]) return
        const code = source.replace(/localize2\(/g, `localize2('${modulePath}', `)
        return { contents: code, loader: 'js' }
      })
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
  ],
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        terminal: path.resolve(__dirname, 'terminal.html'),
      },
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      plugins: [
        esbuildPluginMonacoEditorNls({
          locale: Languages.zh_hans,
          localeData: monacoLocaleData,
        }),
        esbuildMonacoNlsLocalize2Fix(),
      ],
    },
  },
})
