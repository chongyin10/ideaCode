/**
 * levenshtein.rs — Damerau-Levenshtein 编辑距离 + Jaro-Winkler 相似度
 *
 * 对应 JS 实现: src/utils/algorithms/levenshtein.ts
 *
 * 算法：
 * 1. Damerau-Levenshtein: 在标准 Levenshtein（插入/删除/替换）基础上增加相邻字符交换
 *    使用三行滚动数组 + 提前终止阈值
 *    时间复杂度 O(m×n)，空间复杂度 O(min(m,n))
 * 2. Jaro-Winkler: 基于公共字符和交换次数计算相似度，对短字符串（文件名）特别有效
 */

/// Damerau-Levenshtein 编辑距离（带提前终止）
pub fn levenshtein_distance(a: &str, b: &str, max_distance: u32) -> u32 {
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let m = a_chars.len();
    let n = b_chars.len();
    let max_d = max_distance as usize;

    // 长度差超过阈值，直接返回
    if m.abs_diff(n) > max_d {
        return max_distance + 1;
    }
    if m == 0 {
        return if n <= max_d { n as u32 } else { max_distance + 1 };
    }
    if n == 0 {
        return if m <= max_d { m as u32 } else { max_distance + 1 };
    }

    // 确保 short 是较短的那个
    let (short, long): (Vec<char>, Vec<char>) = if m <= n {
        (a_chars, b_chars)
    } else {
        (b_chars, a_chars)
    };
    let slen = short.len();
    let llen = long.len();

    // 三行滚动数组（Damerau-Levenshtein 需要前两行检测交换）
    let mut prev_prev = vec![0u32; slen + 1];
    let mut prev = vec![0u32; slen + 1];
    let mut curr = vec![0u32; slen + 1];

    for j in 0..=slen {
        prev[j] = j as u32;
    }

    for i in 1..=llen {
        curr[0] = i as u32;
        let mut row_min = i as u32;

        let start = 1usize.max(i.saturating_sub(max_d));
        let end = slen.min(i + max_d);

        for j in start..=end {
            let cost = if long[i - 1] == short[j - 1] { 0 } else { 1 };

            // 三种标准操作
            let sub = prev[j - 1] + cost;
            let ins = curr[j - 1] + 1;
            let del = prev[j] + 1;
            let mut val = sub.min(ins).min(del);

            // Damerau 交换操作
            if i > 1 && j > 1 && long[i - 1] == short[j - 2] && long[i - 2] == short[j - 1] {
                val = val.min(prev_prev[j - 2] + cost);
            }

            curr[j] = val;
            if val < row_min {
                row_min = val;
            }
        }

        // 提前终止：本行最小值已超过阈值
        if row_min > max_distance {
            return max_distance + 1;
        }

        // 滚动三行
        let tmp = prev_prev.clone();
        prev_prev = prev.clone();
        prev = curr.clone();
        curr = tmp;
    }

    let result = prev[slen];
    if result <= max_distance {
        result
    } else {
        max_distance + 1
    }
}

/// 编辑距离相似度（0~1，1 表示完全相同）
pub fn levenshtein_similarity(a: &str, b: &str) -> f64 {
    let a_lower = a.to_lowercase();
    let b_lower = b.to_lowercase();
    let dist = levenshtein_distance(&a_lower, &b_lower, u32::MAX) as f64;
    let max_len = a.len().max(b.len()) as f64;
    if max_len == 0.0 {
        return 1.0;
    }
    1.0 - dist / max_len
}

/// Jaro-Winkler 相似度
/// 对短字符串（文件名/标识符）特别有效，前缀匹配加分
pub fn jaro_winkler(a: &str, b: &str, prefix_scale: f64) -> f64 {
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let a_len = a_chars.len();
    let b_len = b_chars.len();

    if a_len == 0 && b_len == 0 {
        return 1.0;
    }
    if a_len == 0 || b_len == 0 {
        return 0.0;
    }

    let match_dist = (a_len.max(b_len) / 2).saturating_sub(1) as isize;
    let mut a_matches = vec![false; a_len];
    let mut b_matches = vec![false; b_len];
    let mut matches = 0usize;

    for i in 0..a_len {
        let start = (i as isize - match_dist).max(0) as usize;
        let end = (i as isize + match_dist + 1).min(b_len as isize) as usize;

        for j in start..end {
            if !b_matches[j] && a_chars[i] == b_chars[j] {
                a_matches[i] = true;
                b_matches[j] = true;
                matches += 1;
                break;
            }
        }
    }

    if matches == 0 {
        return 0.0;
    }

    // 计算交换次数（transpositions）
    let mut trans = 0usize;
    let mut k = 0usize;
    for i in 0..a_len {
        if !a_matches[i] {
            continue;
        }
        while !b_matches[k] {
            k += 1;
        }
        if a_chars[i] != b_chars[k] {
            trans += 1;
        }
        k += 1;
    }
    trans /= 2;

    let m = matches as f64;
    let jaro = (m / a_len as f64 + m / b_len as f64 + (m - trans as f64) / m) / 3.0;

    // Winkler 增强：前缀匹配加分（最多 4 个字符）
    let max_prefix = 4usize.min(a_len).min(b_len);
    let mut prefix = 0usize;
    for i in 0..max_prefix {
        if a_chars[i] == b_chars[i] {
            prefix += 1;
        } else {
            break;
        }
    }

    jaro + prefix as f64 * prefix_scale * (1.0 - jaro)
}
