/**
 * lib.rs — WASM 模块入口
 *
 * 导出的函数通过 wasm-bindgen 自动生成 JS 绑定，
 * 在 JS 侧通过 `import { ... } from './pkg'` 调用。
 *
 * 设计原则：
 * - WASM 只负责纯计算（无状态、无 I/O）
 * - 提供 batch API 减少 JS↔WASM 跨界调用次数
 * - 行为与 JS 版本（algorithms/levenshtein.ts, simHash.ts, fuzzySearch.ts）完全一致
 */

pub mod levenshtein;
pub mod simhash;
pub mod fuzzy_search;

use wasm_bindgen::prelude::*;

// ─── Levenshtein / Damerau-Levenshtein ───

#[wasm_bindgen]
pub fn levenshtein_distance(a: &str, b: &str, max_distance: u32) -> u32 {
    levenshtein::levenshtein_distance(a, b, max_distance)
}

#[wasm_bindgen]
pub fn levenshtein_similarity(a: &str, b: &str) -> f64 {
    levenshtein::levenshtein_similarity(a, b)
}

#[wasm_bindgen]
pub fn jaro_winkler(a: &str, b: &str, prefix_scale: f64) -> f64 {
    levenshtein::jaro_winkler(a, b, prefix_scale)
}

// ─── SimHash ───

#[wasm_bindgen]
pub fn compute_simhash(text: &str) -> u64 {
    simhash::compute_simhash(text)
}

#[wasm_bindgen]
pub fn hamming_distance(a: u64, b: u64) -> u32 {
    simhash::hamming_distance(a, b)
}

/// 批量 SimHash 预过滤：返回通过汉明距离阈值的候选索引
#[wasm_bindgen]
pub fn simhash_filter(query: &str, candidates: Vec<String>, max_dist: u32) -> Vec<u32> {
    simhash::simhash_filter(query, &candidates, max_dist)
}

// ─── 模糊搜索评分 ───

/// 单个 query-target 模糊评分，返回归一化得分（-inf 表示不匹配）
#[wasm_bindgen]
pub fn fuzzy_score(query: &str, target: &str) -> f64 {
    fuzzy_search::fuzzy_score(query, target)
}

/// 批量模糊评分：一次调用处理整个候选列表，返回 (索引, 得分) 对
#[wasm_bindgen]
pub fn fuzzy_score_batch(query: &str, targets: Vec<String>) -> Vec<f64> {
    fuzzy_search::fuzzy_score_batch(query, &targets)
}
