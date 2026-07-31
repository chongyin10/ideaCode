/**
 * WASM vs JS 性能基准测试
 *
 * 用法（在浏览器控制台或开发时运行）：
 *   import { runBenchmark } from './utils/wasmBenchmark';
 *   runBenchmark();
 *
 * 或在应用启动后，在 DevTools Console 中执行：
 *   window.__runWasmBenchmark?.()
 */

import { getWasm } from './wasmLoader';
import { fuzzySearch as jsFuzzySearch } from './algorithms/fuzzySearch';

/** 生成测试用的文件路径列表 */
function generateTestTargets(count: number): string[] {
  const prefixes = ['src', 'test', 'lib', 'utils', 'components', 'services', 'hooks', 'store'];
  const names = [
    'App', 'index', 'main', 'utils', 'helper', 'config', 'types', 'constants',
    'Button', 'Input', 'Modal', 'Editor', 'Terminal', 'Sidebar', 'Panel', 'Toolbar',
    'searchService', 'fileService', 'gitService', 'sshService', 'authService',
    'useSearch', 'useEditor', 'useTerminal', 'useGit', 'useTheme',
    'fuzzySearch', 'levenshtein', 'simHash', 'invertedIndex', 'arcCache',
    'monacoEditor', 'xterminal', 'tabManager', 'commandPalette',
  ];
  const exts = ['.ts', '.tsx', '.js', '.jsx', '.css', '.json', '.md'];

  const targets: string[] = [];
  for (let i = 0; i < count; i++) {
    const prefix = prefixes[i % prefixes.length];
    const name = names[i % names.length];
    const ext = exts[i % exts.length];
    const subDir = i % 3 === 0 ? `${prefixes[(i + 3) % prefixes.length]}/` : '';
    targets.push(`${prefix}/${subDir}${name}${ext}`);
  }
  return targets;
}

interface BenchResult {
  name: string;
  wasmMs: number;
  jsMs: number;
  speedup: number;
  iterations: number;
  targetCount: number;
}

async function benchFuzzyScoreBatch(
  query: string,
  targets: string[],
  iterations: number
): Promise<BenchResult> {
  const wasm = await getWasm();

  // ── WASM 基准 ──
  let wasmMs = 0;
  if (wasm) {
    // 预热
    wasm.fuzzy_score_batch(query, targets);

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      wasm.fuzzy_score_batch(query, targets);
    }
    wasmMs = performance.now() - start;
  }

  // ── JS 基准 ──
  // 预热
  jsFuzzySearch(query, targets);

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    jsFuzzySearch(query, targets);
  }
  const jsMs = performance.now() - start;

  return {
    name: `fuzzy_score_batch("${query}", ${targets.length} targets)`,
    wasmMs,
    jsMs,
    speedup: wasmMs > 0 ? jsMs / wasmMs : 0,
    iterations,
    targetCount: targets.length,
  };
}

export async function runBenchmark(): Promise<void> {
  console.log('%c═══ WASM vs JS 性能基准测试 ═══', 'color: #4CAF50; font-size: 16px; font-weight: bold');

  const wasm = await getWasm();
  if (wasm) {
    console.log('%c✅ WASM 模块已加载', 'color: #4CAF50');
  } else {
    console.log('%c⚠️  WASM 未加载，仅测试 JS 性能（运行 npm run build:wasm 后再测可对比）', 'color: #FF9800');
  }

  console.log('');

  const testCases: Array<{ query: string; count: number; iterations: number; label: string }> = [
    { query: 'app', count: 100, iterations: 100, label: '短查询 × 小列表' },
    { query: 'app', count: 1000, iterations: 50, label: '短查询 × 大列表' },
    { query: 'fuzzySearch', count: 500, iterations: 50, label: '长查询 × 中列表' },
    { query: 'src/components/Button', count: 2000, iterations: 20, label: '路径查询 × 大列表' },
    { query: 'xyz', count: 1000, iterations: 50, label: '无匹配查询 × 大列表' },
  ];

  const results: BenchResult[] = [];

  for (const tc of testCases) {
    const targets = generateTestTargets(tc.count);
    console.log(`⏱️  测试: ${tc.label} (query="${tc.query}", ${tc.count} targets, ${tc.iterations} 轮)`);
    const result = await benchFuzzyScoreBatch(tc.query, targets, tc.iterations);
    results.push(result);

    if (result.wasmMs > 0) {
      console.log(
        `   WASM: ${result.wasmMs.toFixed(2)}ms | JS: ${result.jsMs.toFixed(2)}ms | 加速比: ${result.speedup.toFixed(2)}x`
      );
    } else {
      console.log(`   JS: ${result.jsMs.toFixed(2)}ms (WASM 未就绪)`);
    }
  }

  // 汇总
  console.log('');
  console.log('%c═══ 汇总 ═══', 'color: #4CAF50; font-weight: bold');
  console.table(
    results.map(r => ({
      测试: r.name,
      'WASM(ms)': r.wasmMs > 0 ? r.wasmMs.toFixed(2) : 'N/A',
      'JS(ms)': r.jsMs.toFixed(2),
      '加速比': r.wasmMs > 0 ? `${r.speedup.toFixed(2)}x` : 'N/A',
    }))
  );

  const avgSpeedup = results.filter(r => r.wasmMs > 0);
  if (avgSpeedup.length > 0) {
    const avg = avgSpeedup.reduce((sum, r) => sum + r.speedup, 0) / avgSpeedup.length;
    console.log(`%c平均加速比: ${avg.toFixed(2)}x`, 'color: #4CAF50; font-weight: bold');
  }
}

// 挂载到 window 方便从 DevTools 调用
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__runWasmBenchmark = runBenchmark;
}
