/**
 * simhash.rs — SimHash 局部敏感哈希 + 汉明距离
 *
 * 对应 JS 实现: src/utils/algorithms/simHash.ts
 *
 * 算法：
 * 1. 对字符串做 n-gram 特征提取 (n=2,3)
 * 2. 每个特征用 FNV-1a 64-bit 哈希
 * 3. 聚合：每位按 +1 或 -1 累加
 * 4. 最终 SimHash：累加和 > 0 → 1，否则 → 0
 *
 * Rust 优势：
 * - u64 原生 64 位整数运算（JS 需用 BigInt，性能差 10x+）
 * - popcount 内置指令 (count_ones) 比 JS 查表法快
 */

/// FNV-1a 64-bit 哈希
fn fnv1a64(s: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in s.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// 计算汉明距离（使用 CPU 内置 popcount 指令）
pub fn hamming_distance(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

/// 计算字符串的 SimHash 指纹
/// 提取 2-gram 和 3-gram 特征，用 FNV-1a 哈希后聚合
pub fn compute_simhash(text: &str) -> u64 {
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();
    if len == 0 {
        return 0;
    }

    let mut vector = [0.0f64; 64];

    // 2-gram 特征
    if len >= 2 {
        for i in 0..=len - 2 {
            let bigram: String = chars[i..i + 2].iter().collect();
            let hash = fnv1a64(&bigram);
            for b in 0..64 {
                if (hash >> b) & 1 == 1 {
                    vector[b] += 1.0;
                } else {
                    vector[b] -= 1.0;
                }
            }
        }
    }

    // 3-gram 特征（权重减半，减少噪音）
    if len >= 3 {
        for i in 0..=len - 3 {
            let trigram: String = chars[i..i + 3].iter().collect();
            let hash = fnv1a64(&trigram);
            for b in 0..64 {
                if (hash >> b) & 1 == 1 {
                    vector[b] += 0.5;
                } else {
                    vector[b] -= 0.5;
                }
            }
        }
    }

    // 生成最终 SimHash
    let mut result: u64 = 0;
    for b in 0..64 {
        if vector[b] > 0.0 {
            result |= 1 << b;
        }
    }

    result
}

/// 批量 SimHash 预过滤：返回通过汉明距离阈值的候选索引
pub fn simhash_filter(query: &str, candidates: &[String], max_dist: u32) -> Vec<u32> {
    let query_hash = compute_simhash(query);
    candidates
        .iter()
        .enumerate()
        .filter(|(_, cand)| {
            let cand_hash = compute_simhash(cand);
            hamming_distance(query_hash, cand_hash) <= max_dist
        })
        .map(|(i, _)| i as u32)
        .collect()
}
