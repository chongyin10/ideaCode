/**
 * WASM 加载器 — 懒加载 + 同步调用 + JS fallback
 *
 * 设计原则：
 * 1. 懒加载：首次调用时才加载 WASM 模块，避免影响启动速度
 * 2. 同步调用：WASM 加载后，导出的函数是同步的，可从同步代码直接调用
 * 3. 降级：WASM 加载失败时自动降级到 JS 实现，保证功能可用
 *
 * 使用方式：
 *   import { initWasm, isWasmReady, getWasmSync } from './wasmLoader';
 *   // 应用启动时预加载
 *   initWasm();
 *   // 同步调用（WASM 就绪后自动用 WASM，否则用 JS）
 *   const wasm = getWasmSync();
 *   if (wasm) { ... } else { ... JS fallback ... }
 */

// ─── WASM 模块接口定义（与 src/wasm/pkg/index.d.ts 一致）───

export interface WasmModule {
  levenshtein_distance(a: string, b: string, max_distance: number): number;
  levenshtein_similarity(a: string, b: string): number;
  jaro_winkler(a: string, b: string, prefix_scale: number): number;
  compute_simhash(text: string): bigint;
  hamming_distance(a: bigint, b: bigint): number;
  simhash_filter(query: string, candidates: string[], max_dist: number): Uint32Array;
  fuzzy_score(query: string, target: string): number;
  fuzzy_score_batch(query: string, targets: string[]): Float64Array;
}

let wasmInstance: WasmModule | null = null;
let loadingPromise: Promise<WasmModule | null> | null = null;

/**
 * 预加载 WASM 模块（异步，不阻塞调用方）
 * 在应用启动时调用，WASM 加载完成后自动切换到 WASM 加速
 *
 * 安全性：
 * - 如果 pkg/ 未编译（占位模块），检测到无导出函数则保持 null
 * - 如果加载失败，静默降级到 JS 实现
 */
export function initWasm(): void {
  if (wasmInstance || loadingPromise) return;
  loadingPromise = (async () => {
    try {
      const mod = await import('../wasm/pkg');
      // wasm-bindgen --target web 模式：需要先调用 default export (init 函数)
      // 来加载并实例化 .wasm 二进制，之后导出的函数才可用
      if (typeof mod.default === 'function') {
        await mod.default();
      }
      // 检测关键函数是否存在（占位模块导出为空，此处为 false）
      if (typeof mod.fuzzy_score_batch === 'function') {
        wasmInstance = mod as unknown as WasmModule;
        console.log('[WASM] 模块加载成功，模糊搜索已切换到 WASM 加速');
      } else {
        console.log('[WASM] 模块未编译（占位模块），使用 JS 实现。运行 npm run build:wasm 编译。');
      }
    } catch (e) {
      console.warn('[WASM] 加载失败，保持 JS 实现:', e);
    } finally {
      loadingPromise = null;
    }
    return wasmInstance;
  })();
}

/**
 * WASM 是否已就绪（同步检查）
 */
export function isWasmReady(): boolean {
  return wasmInstance !== null;
}

/**
 * 获取 WASM 模块（异步，用于需要等待加载完成的场景）
 */
export async function getWasm(): Promise<WasmModule | null> {
  if (wasmInstance) return wasmInstance;
  if (loadingPromise) await loadingPromise;
  return wasmInstance;
}

// ─── 同步 API：WASM 就绪时用 WASM，否则返回 null（调用方降级到 JS）───

/**
 * 同步获取 WASM 模块（未加载时返回 null）
 */
export function getWasmSync(): WasmModule | null {
  return wasmInstance;
}

// ─── 异步 API：自动 WASM↔JS 降级 ───

import { levenshteinDistance as jsLevenshtein } from './algorithms/levenshtein';
import { jaroWinkler as jsJaroWinkler } from './algorithms/levenshtein';
import { computeSimHash as jsComputeSimHash } from './algorithms/simHash';
import { hammingDistanceFast as jsHammingDistance } from './algorithms/simHash';
import { fuzzyScore as jsFuzzyScore } from './algorithms/fuzzySearch';

/**
 * 异步：Damerau-Levenshtein 编辑距离
 */
export async function levenshteinDistance(
  a: string, b: string, maxDistance: number = Infinity
): Promise<number> {
  const wasm = await getWasm();
  if (wasm) {
    return wasm.levenshtein_distance(a, b, maxDistance === Infinity ? 0xFFFFFFFF : maxDistance);
  }
  return jsLevenshtein(a, b, maxDistance);
}

/**
 * 异步：Jaro-Winkler 相似度
 */
export async function jaroWinkler(a: string, b: string, prefixScale = 0.1): Promise<number> {
  const wasm = await getWasm();
  if (wasm) return wasm.jaro_winkler(a, b, prefixScale);
  return jsJaroWinkler(a, b, prefixScale);
}

/**
 * 异步：SimHash 指纹
 * 注意：wasm-bindgen 将 u64 返回值映射为 BigInt，无需再转换
 */
export async function computeSimHash(text: string): Promise<bigint> {
  const wasm = await getWasm();
  if (wasm) return wasm.compute_simhash(text);
  return jsComputeSimHash(text);
}

/**
 * 异步：汉明距离
 * 注意：wasm-bindgen 将 u64 参数映射为 BigInt，直接传 bigint
 */
export async function hammingDistance(a: bigint, b: bigint): Promise<number> {
  const wasm = await getWasm();
  if (wasm) return wasm.hamming_distance(a, b);
  return jsHammingDistance(a, b);
}

/**
 * 异步：模糊评分（单个 target）
 */
export async function fuzzyScore(query: string, target: string): Promise<number> {
  const wasm = await getWasm();
  if (wasm) return wasm.fuzzy_score(query, target);
  const result = jsFuzzyScore(query, target);
  return result ? result.score : -Infinity;
}

/**
 * 异步：批量模糊评分（WASM 核心优势场景）
 */
export async function fuzzyScoreBatch(query: string, targets: string[]): Promise<number[]> {
  const wasm = await getWasm();
  if (wasm) return Array.from(wasm.fuzzy_score_batch(query, targets));
  return targets.map((t) => {
    const result = jsFuzzyScore(query, t);
    return result ? result.score : -Infinity;
  });
}
