/**
 * fuzzy_search.rs — 模糊搜索评分（注意力加权 + 归一化）
 *
 * 对应 JS 实现: src/utils/algorithms/fuzzySearch.ts (fuzzyScore + fuzzySearch)
 *
 * 算法原理：
 * 1. 动态规划计算最优匹配得分
 * 2. 综合因素：字符匹配、连续匹配奖励、首字母奖励、驼峰奖励、注意力加权
 * 3. 长度归一化：得分 / sqrt(queryLen × targetLen)
 *
 * Rust 优势：
 * - f64 原生运算，无 JS 的 Number 装箱/拆箱开销
 * - 栈上数组分配（无堆分配）for 固定大小数据
 * - 编译器自动向量化优化
 */

// ─── 得分常数（与 JS 版本完全一致）───

const BONUS_PREFIX: f64 = 4.0;
const BONUS_WORD_START: f64 = 3.0;
const BONUS_CONSECUTIVE: f64 = 2.5;
const BONUS_CAMEL_CASE: f64 = 2.0;
const PENALTY_LEADING: f64 = -1.2;
const PENALTY_MAX_LEADING: f64 = -6.0;
const PENALTY_UNMATCHED: f64 = -0.5;

const NEG_INF: f64 = f64::NEG_INFINITY;

/// 判断是否为分隔符
fn is_separator(ch: char) -> bool {
    matches!(ch, '/' | '\\' | '_' | '-' | '.' | ' ')
}

/// 判断是否为大写字母
fn is_upper(ch: char) -> bool {
    ch.is_ascii_uppercase()
}

/// 计算注意力权重（U 型分布：首尾高，中间低）
fn attention_weights(query_len: usize) -> Vec<f64> {
    if query_len <= 1 {
        return vec![1.0];
    }
    let mid = (query_len - 1) as f64 / 2.0;
    let mut weights = vec![0.0; query_len];
    let mut sum = 0.0;
    for i in 0..query_len {
        weights[i] = 1.0 + 0.6 * (1.0 - (i as f64 / mid - 1.0).abs());
        sum += weights[i];
    }
    // 归一化到总和为 query_len
    let scale = query_len as f64 / sum;
    for w in &mut weights {
        *w *= scale;
    }
    weights
}

/// 归一化得分：raw / sqrt(queryLen × targetLen)
fn normalize_score(raw_score: f64, query_len: usize, target_len: usize) -> f64 {
    if raw_score <= NEG_INF + 100.0 {
        return NEG_INF;
    }
    let divisor = (query_len as f64 * target_len.max(1) as f64).sqrt();
    raw_score / divisor
}

/// 单个 query-target 模糊评分
///
/// 返回归一化得分，NEG_INF 表示不匹配
pub fn fuzzy_score(query: &str, target: &str) -> f64 {
    let query_chars: Vec<char> = query.chars().collect();
    let target_chars: Vec<char> = target.chars().collect();
    let m = query_chars.len();
    let n = target_chars.len();

    // 边界条件
    if m == 0 {
        return 0.0;
    }
    if n == 0 || m > n {
        return NEG_INF;
    }

    // 精确匹配（忽略大小写）
    if query.eq_ignore_ascii_case(target) {
        return f64::INFINITY;
    }

    let attn_weights = attention_weights(m);

    // DP 评分矩阵（用 Vec<Vec<f64>> 实现，与 JS 版本一致）
    // prev[j] 和 curr[j] 分别表示上一行和当前行的得分
    let mut prev = vec![NEG_INF; n];
    let mut curr = vec![NEG_INF; n];
    let mut match_matrix: Vec<Vec<f64>> = Vec::with_capacity(m);

    for i in 0..m {
        let qch = query_chars[i].to_ascii_lowercase();
        let mut max_prev = NEG_INF;

        // 初始化当前行
        for j in 0..n {
            curr[j] = NEG_INF;
        }

        for j in i..n {
            if i > 0 && j > 0 {
                max_prev = max_prev.max(prev[j - 1]);
            }

            let tch = target_chars[j].to_ascii_lowercase();

            if qch == tch {
                let mut score = 0.0;

                // 基础匹配分 × 注意力权重
                score += 1.0 * attn_weights[i];

                // 前缀奖励
                if i == 0 && j == 0 {
                    score += BONUS_PREFIX;
                }

                // 单词首字母奖励
                if j == 0 || is_separator(target_chars[j - 1]) {
                    score += BONUS_WORD_START;
                }

                // 驼峰奖励
                if j > 0 && is_upper(target_chars[j]) && !is_upper(target_chars[j - 1]) {
                    score += BONUS_CAMEL_CASE;
                }

                // 连续匹配奖励
                if i > 0 && j > 0 && prev[j - 1] > NEG_INF {
                    score += BONUS_CONSECUTIVE;
                }

                if i == 0 {
                    let leading_penalty = (j as f64 * PENALTY_LEADING).max(PENALTY_MAX_LEADING);
                    curr[j] = score + leading_penalty;
                } else if max_prev > NEG_INF {
                    curr[j] = score + max_prev;
                } else {
                    curr[j] = NEG_INF;
                }
            }
        }

        // 保存当前行到 match_matrix（用于回溯，但评分只需要最后一行）
        match_matrix.push(curr.clone());

        // 滚动：prev = curr, curr 重置
        for j in 0..n {
            prev[j] = curr[j];
        }
    }

    // 找最后一行的最大得分
    let last_row = &match_matrix[m - 1];
    let mut best_score = NEG_INF;
    for &val in last_row {
        if val > best_score {
            best_score = val;
        }
    }

    if best_score == NEG_INF {
        return NEG_INF;
    }

    // 未匹配字符惩罚
    let unmatched_count = (n - m) as f64;
    best_score += unmatched_count * PENALTY_UNMATCHED;

    normalize_score(best_score, m, n)
}

/// 批量模糊评分
///
/// 对每个 target 计算 fuzzy_score，返回得分数组
/// NEG_INF 表示不匹配，调用方需过滤
pub fn fuzzy_score_batch(query: &str, targets: &[String]) -> Vec<f64> {
    targets
        .iter()
        .map(|target| fuzzy_score(query, target))
        .collect()
}
