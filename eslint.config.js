import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'node_modules',
      'dist',
      'build',
      'release',
      'extensions',
      'src/wasm/pkg',
      'src/wasm/target',
      'web/*/dist',
      'web/*/build',
      'web/*/node_modules',
      '.kilo',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      // 动态场景（JSON 数据、插件系统、第三方回调）中 any 是合理写法，
      // 降级为 warning 保留提示，避免阻塞构建。
      '@typescript-eslint/no-explicit-any': 'warn',
      // `const self = this` 是捕获 this 语义的可读惯用法（大型 TS 项目同款），
      // 属风格规则而非错误，关闭。
      '@typescript-eslint/no-this-alias': 'off',
      // 下划线前缀参数/变量是"故意未使用"的占位（回调签名、接口对齐等）
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
)
