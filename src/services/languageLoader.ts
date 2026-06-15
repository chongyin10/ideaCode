/**
 * Monaco Editor 语言按需加载模块
 *
 * 从 main.tsx 提取，避免 MonacoEditor → main.tsx 循环依赖。
 * 使用方直接从此模块 import。
 */

// 已加载的语言集合
const loadedLanguages = new Set<string>(['typescript', 'javascript']);

/**
 * 按需加载语言贡献（语法高亮）
 * 在编辑器 mounting 时根据文件语言动态加载对应语法
 */
export async function ensureLanguage(lang: string): Promise<void> {
  if (loadedLanguages.has(lang)) return;

  const langMap: Record<string, () => Promise<void>> = {
    'java':       () => import('monaco-editor/esm/vs/basic-languages/java/java.contribution.js').then(() => {}),
    'cpp':        () => import('monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js').then(() => {}),
    'c':          () => import('monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js').then(() => {}),
    'csharp':     () => import('monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution.js').then(() => {}),
    'python':     () => import('monaco-editor/esm/vs/basic-languages/python/python.contribution.js').then(() => {}),
    'css':        () => import('monaco-editor/esm/vs/basic-languages/css/css.contribution.js').then(() => {}),
    'scss':       () => import('monaco-editor/esm/vs/basic-languages/scss/scss.contribution.js').then(() => {}),
    'less':       () => import('monaco-editor/esm/vs/basic-languages/less/less.contribution.js').then(() => {}),
    'sass':       () => import('monaco-editor/esm/vs/basic-languages/scss/scss.contribution.js').then(() => {}),
    'html':       () => import('monaco-editor/esm/vs/basic-languages/html/html.contribution.js').then(() => {}),
    'markdown':   () => import('monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js').then(() => {}),
    'json':       () => import('monaco-editor/esm/vs/language/json/monaco.contribution.js').then(() => {}),
  };

  const loader = langMap[lang];
  if (loader) {
    try {
      await loader();
      loadedLanguages.add(lang);
    } catch {
      console.warn(`[LanguageLoader] 语言 ${lang} 加载失败`);
    }
  }
}
