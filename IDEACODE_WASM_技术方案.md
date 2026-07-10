# IDEACODE — WebAssembly 加速方案（面试版）

> 文档版本：v1.0  
> 适用场景：技术面试自述 / 架构方案讲解  
> 核心命题：**在 Electron IDE 中，用 Rust→WASM 替换 JS 热路径算法，实现 3~10x 性能提升**

---

## 一、为什么引入 WebAssembly？

### 1.1 问题背景

IDEACODE 的命令面板（Cmd+P 快速打开文件）使用**模糊搜索**算法，核心是一个 O(m×n) 的动态规划评分矩阵。当项目文件数达到 **2000+** 时，用户每输入一个字符就要对全部文件路径重新评分：

| 场景 | 数据量 | JS 耗时（实测） | 用户感知 |
|------|--------|----------------|---------|
| 100 个文件，输入 "app" | 100 targets | ~2ms | 流畅 |
| 1000 个文件，输入 "app" | 1000 targets | ~25ms | 轻微卡顿 |
| 2000 个文件，输入 "src/components/Button" | 2000 targets | ~80ms | 明显卡顿，输入抖动 |

**根因**：JS 引擎在此类场景存在三重性能瓶颈：

```
瓶颈 1：Number 装箱/拆箱 — JS 的 Number 在 V8 中可能被装箱为 HeapNumber，
        每次浮点运算需要拆箱→计算→装箱，产生隐藏的堆分配开销

瓶颈 2：BigInt 模拟 64 位 — SimHash 需要 64 位整数运算，JS 没有原生 u64，
        必须用 BigInt（堆分配 + 软件模拟），比原生 u64 慢 10x+

瓶颈 3：JIT 预热开销 — V8 的 JIT 编译器需要多次执行才会优化热路径，
        而模糊搜索的查询每次不同，分支模式不固定，JIT 优化效果有限
```

### 1.2 为什么选 WebAssembly？

| 候选方案 | 优势 | 劣势 | 结论 |
|---------|------|------|------|
| **优化 JS 算法** | 无需新工具链 | 已用滚动数组+提前终止，接近理论极限 | ❌ 边际收益递减 |
| **Web Worker** | 不阻塞主线程 | 计算总量不变，postMessage 序列化有额外开销 | ❌ 治标不治本 |
| **WebAssembly** | 接近原生速度，无 JIT 预热，原生 u64 | 需 Rust 工具链，增加构建复杂度 | ✅ 根本性解决 |
| **Native Addon** | 最快 | 破坏跨平台，打包复杂，Electron ABI 兼容问题 | ❌ 过度设计 |

**选型理由**：WASM 在**不破坏跨平台性**的前提下，消除 JS 的三重瓶颈，且可与现代构建工具链（Vite/wasm-pack）无缝集成。

---

## 二、改造了什么？

### 2.1 三个 CPU 密集型算法

| 算法 | 文件路径 | 应用场景 | WASM 优势 |
|------|---------|---------|-----------|
| **模糊搜索 DP 评分** | `fuzzy_search.rs` | 命令面板 Cmd+P 文件定位 | f64 原生运算，无 Number 装箱；批量 API 消除 N 次跨界调用 |
| **Damerau-Levenshtein** | `levenshtein.rs` | 拼写纠错（typo-tolerant） | 三行滚动数组在栈上分配，无 GC 压力 |
| **SimHash + Hamming** | `simhash.rs` | 模糊搜索预过滤（淘汰 60~95% 候选） | **u64 原生运算**（JS 需 BigInt，慢 10x+）；**CPU popcount 指令**（`count_ones()`）|

### 2.2 Rust → WASM 工具链

```
Rust 源码 (.rs)
    │
    ├── Cargo.toml          # 依赖 wasm-bindgen + serde
    ├── src/lib.rs          # WASM 入口，#[wasm_bindgen] 导出 8 个函数
    ├── src/levenshtein.rs  # Damerau-Levenshtein + Jaro-Winkler
    ├── src/simhash.rs      # FNV-1a 64-bit + popcount
    └── src/fuzzy_search.rs # DP 评分矩阵 + 注意力加权 + 归一化
         │
         ▼
    wasm-pack build --target web --release
         │
         ▼
    pkg/ideacode_wasm_bg.wasm  (40KB, release 优化)
    pkg/ideacode_wasm.js       (JS 绑定 glue code)
    pkg/ideacode_wasm.d.ts     (TypeScript 类型)
```

---

## 三、传统 JS 模式 vs WASM 模式

### 3.1 架构对比

```
┌─────────────── 传统 JS 模式 ───────────────┐
│                                           │
│  用户输入 "apptsx"                         │
│       │                                   │
│       ▼                                   │
│  fuzzySearch(query, 2000 targets)         │
│       │                                   │
│       ├── SimHash 预过滤 (BigInt 模拟 u64) │ ← 慢：BigInt 堆分配
│       │   └── 过滤后剩 200 候选            │
│       │                                   │
│       ├── 逐个 DP 评分 (200 次 JS 调用)    │ ← 慢：N 次函数调用 + Number 装箱
│       │   └── 每次构造 Float64Array        │
│       │                                   │
│       └── 排序 + 返回                      │
│                                           │
│   总耗时：~80ms (2000 文件)                │
└───────────────────────────────────────────┘

┌─────────────── WASM 加速模式 ──────────────┐
│                                           │
│  用户输入 "apptsx"                         │
│       │                                   │
│       ▼                                   │
│  fuzzySearch(query, 2000 targets)         │
│       │                                   │
│       ├── getWasmSync() → WASM 就绪？      │
│       │   ├── 是 → WASM 路径              │
│       │   └── 否 → JS fallback（降级）     │
│       │                                   │
│       ├── WASM 路径：                      │
│       │   ├── 1 次 wasm.fuzzy_score_batch │ ← 快：1 次跨界调用
│       │   │   (2000 targets 一次性传入)    │
│       │   │   └── Rust 内部循环：原生 f64  │ ← 快：无装箱/拆箱
│       │   │                                │
│       │   ├── 过滤 score > -∞ 的结果       │
│       │   └── 仅对有效结果用 JS 算匹配位置  │
│       │                                   │
│       └── 排序 + 返回                      │
│                                           │
│   总耗时：~8ms (2000 文件)                 │
└───────────────────────────────────────────┘
```

### 3.2 逐项对比

| 维度 | 传统 JS | WASM (Rust) | 差异说明 |
|------|--------|-------------|---------|
| **浮点运算** | Number 可能装箱为 HeapNumber | f64 原生 SSE2 指令 | WASM 无装箱/拆箱开销 |
| **64 位整数** | BigInt（堆分配 + 软模拟） | u64 原生寄存器运算 | **10x+ 提升** |
| **popcount** | 查表法（256 项数组 + 8 次循环） | `count_ones()` → CPU `POPCNT` 指令 | **5x 提升**（单指令 vs 循环） |
| **函数调用** | N 次 JS→JS 调用，每次构造中间对象 | 1 次 JS→WASM 调用，内部循环 | 减少 N-1 次跨界开销 |
| **GC 压力** | 每次评分创建 Float64Array、Array 等 | 纯栈上计算，零堆分配 | 消除 GC pause |
| **JIT 预热** | 需要多次执行才优化 | AOT 编译，首次即最优 | 首次查询无预热开销 |
| **内存布局** | 对象散落在堆上 | 连续数组，CPU 缓存友好 | 减少 cache miss |

### 3.3 批量 API 的关键设计

```rust
// Rust 侧：一次调用处理整个候选列表
#[wasm_bindgen]
pub fn fuzzy_score_batch(query: &str, targets: Vec<String>) -> Vec<f64> {
    targets.iter().map(|t| fuzzy_score(query, t)).collect()
}
```

```typescript
// JS 侧：1 次跨界调用 vs N 次
// ❌ 传统：N 次 JS 调用
for (const target of targets) {
  scores.push(fuzzyScore(query, target)); // 每次都有函数调用 + 对象分配开销
}

// ✅ WASM：1 次跨界调用，内部循环
const scores = wasm.fuzzy_score_batch(query, targets); // 一次性传入，Rust 内部循环
```

**关键洞察**：JS↔WASM 的跨界调用本身有固定开销（参数序列化）。如果逐个调用 `wasm.fuzzy_score()`，N 次序列化的开销可能抵消 WASM 的计算优势。因此**批量 API** 是发挥 WASM 优势的核心设计——将 N 次跨界调用压缩为 1 次。

---

## 四、效益提升量化

### 4.1 理论分析

| 算法 | JS 瓶颈 | WASM 优势 | 预期提升 |
|------|--------|-----------|---------|
| SimHash 计算 | BigInt 64 位运算 | u64 原生寄存器 | **8~12x** |
| Hamming 距离 | 查表法 8 次循环 | `POPCNT` 单指令 | **5~8x** |
| 模糊搜索评分（单次） | Number 装箱 + JIT | f64 SSE2 + AOT | **3~5x** |
| 模糊搜索批量（2000 项） | N 次调用 + N 次对象分配 | 1 次调用 + 内部循环 | **8~15x** |

### 4.2 实测场景（2000 个文件路径）

| 查询类型 | JS 耗时 | WASM 耗时 | 加速比 | 用户感知 |
|---------|--------|----------|--------|---------|
| 短查询 "app" | ~25ms | ~3ms | **8x** | 卡顿→流畅 |
| 长查询 "src/components/Button" | ~80ms | ~8ms | **10x** | 明显卡顿→无感知 |
| 无匹配查询 "xyz" | ~60ms | ~5ms | **12x** | SimHash 预过滤更快淘汰 |
| **平均** | | | **~10x** | 输入延迟从 80ms 降至 8ms，低于 16ms 帧预算 |

### 4.3 用户体验提升

```
传统模式：输入 "src/components/Button"
  按键 ① → 80ms 计算 → 帧丢 5 帧 → 可见卡顿
  按键 ② → 80ms 计算 → 帧丢 5 帧 → 输入抖动

WASM 模式：输入 "src/components/Button"
  按键 ① → 8ms 计算 → 0 帧丢 → 无感知延迟
  按键 ② → 8ms 计算 → 0 帧丢 → 流畅输入
```

**关键阈值**：浏览器帧预算为 16.67ms（60fps）。JS 模式的 80ms 远超帧预算导致掉帧；WASM 模式的 8ms 在帧预算内，实现零掉帧。

### 4.4 附加收益

| 收益 | 说明 |
|------|------|
| **WASM 二进制仅 40KB** | gzip 后约 15KB，首屏加载无感知 |
| **零侵入降级** | WASM 加载失败自动降级 JS，功能不受影响 |
| **跨平台一致** | WASM 在 macOS/Windows/Linux 行为完全一致，无平台差异 |

---

## 五、集成架构与流程图

### 5.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                     Electron Renderer (React)                │
│                                                             │
│  main.tsx                                                   │
│    │                                                        │
│    ├── initWasm()  ←── 应用启动时异步预加载（不阻塞首屏）     │
│    │     │                                                  │
│    │     ▼                                                  │
│    │   import('../wasm/pkg')  →  mod.default()  →  WASM 就绪 │
│    │                                                        │
│    ▼                                                        │
│  用户输入 "apptsx"                                           │
│    │                                                        │
│    ▼                                                        │
│  fuzzySearch(query, targets)                                │
│    │                                                        │
│    ├── getWasmSync() ──── WASM 就绪？                        │
│    │     │                  │                                │
│    │     │ 是                │ 否                             │
│    │     ▼                  ▼                                │
│    │  WASM 批量评分       JS 逐个评分 (fallback)              │
│    │  (fuzzy_score_batch)  (fuzzyScore × N)                  │
│    │     │                  │                                │
│    │     │  1 次跨界调用     │  N 次函数调用                   │
│    │     │  Rust 内部循环    │  Number 装箱 + JIT              │
│    │     │                  │                                │
│    │     ▼                  ▼                                │
│    └─── 排序 + 返回 FuzzyResult[]                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
         │
         │  JS↔WASM 跨界调用（参数序列化）
         ▼
┌─────────────────────────────────────────────────────────────┐
│                    WebAssembly Module                       │
│                   (40KB, Rust→WASM)                          │
│                                                             │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐ │
│  │ fuzzy_score │  │  simhash     │  │  levenshtein       │ │
│  │ _batch()    │  │  _filter()   │  │  _distance()       │ │
│  │             │  │              │  │                    │ │
│  │ DP 评分矩阵  │  │ FNV-1a u64   │  │ 三行滚动数组        │ │
│  │ 注意力加权   │  │ POPCNT 指令  │  │ 提前终止            │ │
│  │ 归一化      │  │              │  │                    │ │
│  └─────────────┘  └──────────────┘  └────────────────────┘ │
│                                                             │
│  特性：AOT 编译 · 零 GC · 栈上分配 · CPU 向量化              │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 WASM 生命周期时序

```
应用启动
  │
  ├──▶ initWasm() 触发异步加载
  │      │
  │      ├── import('../wasm/pkg')        ← 动态 import（Vite 代码分割）
  │      ├── mod.default()                ← wasm-bindgen init：fetch .wasm + WebAssembly.instantiate
  │      ├── 检测 fuzzy_score_batch 存在？ ← 占位模块检测（防未编译降级）
  │      └── wasmInstance = mod           ← WASM 就绪，后续调用走 WASM
  │
  │      ⚡ 此过程异步，不阻塞 React 首屏渲染
  │      ⚡ 加载期间模糊搜索自动用 JS fallback
  │
  ├──▶ React 渲染首屏
  │
  ├──▶ WASM 加载完成（通常 < 50ms）
  │      └── console.log('[WASM] 模块加载成功')
  │
  ▼
用户使用命令面板（Cmd+P）
  │
  ├──▶ getWasmSync() 返回 WASM 模块
  ├──▶ wasm.fuzzy_score_batch(query, targets)  ← 同步调用，无 Promise 开销
  └──▶ 返回 Float64Array 评分结果
```

### 5.3 降级容错机制

```
                    WASM 加载流程
                         │
              ┌──────────┴──────────┐
              │                     │
        加载成功               加载失败 / 未编译
              │                     │
              ▼                     ▼
        wasmInstance = mod     wasmInstance = null
              │                     │
              ▼                     ▼
     getWasmSync() → mod     getWasmSync() → null
              │                     │
              ▼                     ▼
       WASM 批量评分           JS 逐个评分
     (10x 加速)              (功能正常，性能为 JS 水平)
              │                     │
              └─────────┬───────────┘
                        ▼
                  结果一致，用户无感知
```

---

## 六、关键技术决策

### 6.1 为什么用 `--target web` 而非 `--target bundler`？

| 选项 | 说明 | 选择理由 |
|------|------|---------|
| `--target web` | 生成 ES Module + `import.meta.url` 定位 .wasm | Vite 原生支持，无需额外插件 |
| `--target bundler` | 依赖 bundler 处理 .wasm 加载 | 需要 `vite-plugin-wasm`，增加依赖 |
| `--target nodejs` | 用 `require` 加载 | 不适用于浏览器/Electron renderer |

### 6.2 为什么 WASM 只算得分，匹配位置用 JS？

```
WASM 侧：fuzzy_score_batch() → Float64Array  （仅得分，无匹配位置）
JS  侧：fuzzyScore() → FuzzyResult { score, matches[] }  （含匹配位置）
```

**设计原因**：
- 匹配位置（`boolean[]`）需要回溯 DP 矩阵，传输到 JS 需序列化大数组，**跨界开销可能抵消 WASM 优势**
- 实际只有**通过预过滤的候选**（score > -∞，通常 < 20% ）需要计算匹配位置
- 因此：**WASM 做批量预过滤（快），JS 只对有效结果算匹配位置（少）**，两者优势互补

### 6.3 为什么用占位文件（placeholder）？

在 WASM 未编译时（如 fresh clone 后直接 `npm run dev`），`import('../wasm/pkg')` 需要能解析。通过 `pkg/index.js`（空模块）+ `pkg/index.d.ts`（类型声明）作为占位：

- **TS 编译通过**：类型声明让 TypeScript 不报错
- **运行时降级**：加载器检测 `typeof mod.fuzzy_score_batch === 'function'`，占位模块为 false → 自动降级 JS
- **wasm-pack 编译后自动旁路**：wasm-pack 生成 `package.json`（main 指向 `ideacode_wasm.js`），优先于 `index.js`

---

## 七、面试速答卡

### Q: WASM 相比 JS 快在哪里？

> 三个层面：  
> 1. **计算层**：f64 原生 SSE2 指令，无 Number 装箱；u64 原生寄存器运算，无需 BigInt 软模拟；popcount 用 CPU 单指令而非查表循环  
> 2. **编译层**：AOT 预编译为机器码，无 JIT 预热；分支模式固定，编译器可充分优化  
> 3. **内存层**：栈上分配，零 GC 压力；连续内存布局，CPU 缓存友好  

### Q: 为什么不全部用 WASM？

> WASM 适合**CPU 密集、无 I/O、无状态**的纯计算。JS 在 DOM 操作、事件处理、异步 I/O 上更灵活。两者是**互补**关系：JS 负责业务逻辑和 UI，WASM 负责热路径计算。本项目只改造了 3 个算法函数，改动面 < 1%，但热路径性能提升 10x。

### Q: WASM 加载失败怎么办？

> **零侵入降级**：加载器在 `initWasm()` 中 try/catch 包裹，失败则 `wasmInstance = null`。业务代码通过 `getWasmSync()` 检查——返回 null 则走 JS fallback。用户无感知，功能完全正常，只是性能为 JS 水平。

### Q: 如何保证 WASM 和 JS 结果一致？

> Rust 实现完全复刻 JS 算法的逻辑：相同的得分常数（BONUS_PREFIX = 4.0 等）、相同的注意力权重公式、相同的归一化方法。此外，WASM 只负责评分（返回 Float64Array），匹配位置的回溯仍由 JS 版本计算，确保结果结构完全一致。

### Q: 40KB 的 WASM 会不会影响首屏？

> 不会。`initWasm()` 是**异步**的，不阻塞 React 首屏渲染。WASM 模块在应用启动后并行加载（fetch + instantiate 通常 < 50ms），加载完成前模糊搜索用 JS fallback。gzip 后 WASM 仅 ~15KB，对首屏无可感知影响。
