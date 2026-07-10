/**
 * WASM 模块类型声明（占位）
 *
 * 运行 `wasm-pack build` 后，wasm-pack 会生成 `ideacode_wasm.d.ts`
 * 和 `package.json`（types 指向 ideacode_wasm.d.ts），优先于此文件。
 *
 * 此文件确保 TypeScript 在 WASM 未编译时也能正确推断类型。
 */

export declare function levenshtein_distance(
  a: string,
  b: string,
  max_distance: number
): number;

export declare function levenshtein_similarity(a: string, b: string): number;

export declare function jaro_winkler(
  a: string,
  b: string,
  prefix_scale: number
): number;

/** 返回 64-bit SimHash 指纹（wasm-bindgen 将 u64 映射为 BigInt） */
export declare function compute_simhash(text: string): bigint;

/** 汉明距离（参数为 bigint，对应 Rust u64） */
export declare function hamming_distance(a: bigint, b: bigint): number;

/** 批量 SimHash 预过滤：返回通过汉明距离阈值的候选索引 */
export declare function simhash_filter(
  query: string,
  candidates: string[],
  max_dist: number
): number[];

/** 单个 query-target 模糊评分，返回归一化得分（-Infinity 表示不匹配） */
export declare function fuzzy_score(query: string, target: string): number;

/** 批量模糊评分：返回 Float64Array（wasm-bindgen 将 Vec<f64> 映射为 Float64Array） */
export declare function fuzzy_score_batch(
  query: string,
  targets: string[]
): Float64Array;

/**
 * WASM 初始化函数（wasm-bindgen --target web 的 default export）
 * 占位声明：真实编译后由 ideacode_wasm.d.ts 提供
 */
declare function _init(module_or_path?: unknown): Promise<unknown>;
export default _init;
