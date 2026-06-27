# IDEACODE

基于 **React + TypeScript + Vite + Monaco Editor + Electron** 构建的轻量级桌面 IDE。不是 VS Code 的复制品——它在 AI 辅助、标签管理、搜索算法、终端能力等方面引入了多项 VS Code 不具备的独立创新。

![React](https://img.shields.io/badge/React-18.3-61DAFB?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?logo=typescript)
![Vite](https://img.shields.io/badge/Vite-5.4-646CFF?logo=vite)
![Electron](https://img.shields.io/badge/Electron-30-47848F?logo=electron)

> ![整体界面](docs/images/overview-dark.png)

---

## 为什么选择 IDEACODE？

IDEACODE 的目标不是在功能数量上与 VS Code 竞争，而是在**关键开发体验**上做出差异化。以下是 IDEACODE 独有而 VS Code 不具备或做得不够好的能力：

| 特性 | IDEACODE | VS Code |
|------|----------|---------|
| **标签管理** | 🧠 神经科学驱动的 BCM 自适应淘汰，自动学习使用模式 | 固定数量的标签页限制，手动关闭 |
| **文件预测** | 📈 熵基预取，在你打开文件前自动加载 | 无自动预取能力 |
| **搜索排序** | 🎰 多臂老虎机强化学习，越用越准 | 静态模糊评分，从不学习用户偏好 |
| **AI Agent** | 🤖 多模型、双路径（安全/直接）、含审计日志 | Copilot Chat 功能有限 |
| **AI 修改模型** | 🔒 只读分析 + 用户确认 + Diff 预览，代码不直接写入 | 内联建议即用即弃 |
| **终端能力** | 📡 广播模式、书签（跳表）、密码自动检测、输出折叠 | 基础分屏终端 |
| **系统监控** | 📊 CPU/内存/GPU 实时状态栏显示 | 无系统资源可见性 |
| **搜索内核** | 🧮 FM-Index 压缩搜索 + Boyer-Moore + 跳表 + Cuckoo 过滤器 | 线性字符串扫描 |

---

## 核心差异化特性

### 1. 神经标签管理（BCM Neural Tab Manager）

> ![分屏编辑](docs/images/split-editor.png)

传统的 IDE 用固定数量限制标签页——超出上限就关闭最老的。IDEACODE 采用**神经科学模型**来智能管理标签：

**Bienenstock-Cooper-Munro (BCM) 突触可塑性理论**，将每个标签页建模为一个**神经突触**：

| 神经概念 | 标签页等价 |
|----------|-----------|
| 突触权重 `w` | 标签保留优先级（0–1） |
| 突触前活动 `x` | 标签可见性（焦点/非焦点） |
| 突触后活动 `y` | 标签使用活动（编辑频率 + 驻留时间的 EWMA） |
| 滑动阈值 `θ_M` | 自适应淘汰阈值（`E[y²]` 滑动平均） |
| 长时程增强 (LTP) | 标签加固（更难关闭） |
| 长时程抑制 (LTD) | 标签弱化（更容易关闭） |

**核心动力学方程：**

```
dw/dt = φ(y, θ_M) · x - ε · w
φ(y, θ_M) = y · (y - θ_M)  (当 y ≥ 0)
```

**VS Code 做不到的：**

- **无硬编码限制**：阈值 `θ_M` 根据你的实际使用模式自动校准，而非固定数字
- **STDP（脉冲时序依赖可塑性）**：记录标签切换的方向性模式——如果你频繁 `A → B`，系统会学习到这个关系
- **Oja 规则在线 PCA**：自动发现哪些文件经常一起被打开，形成"共激活簇"
- **李雅普诺夫稳定性**：权重有数学上可证明的稳定上界，不会发散
- **泊松过程 KDE**：使用非参数核密度估计建模标签活动，避免了 EWMA 的滞后偏差

> 通俗地说：你用得多的标签自动被保留，用得少的自动被淘汰。系统会观察你的切换模式来预测你接下来想打开什么文件。

---

### 2. 熵基文件预取（Entropy-Based Prefetching）

> ![快速打开](docs/images/quick-open.png)

在你点击文件之前，IDEACODE 已经在后台为你加载了它。文件预取系统使用**信息论 + 图论 + 贝叶斯推断**的组合策略：

**五层预测堆栈：**

| 层级 | 技术 | 作用 |
|------|------|------|
| ① 二阶马尔可夫 | `P(Z\|X,Y)` + Good-Turing 平滑 | 从历史切换模式预测下一个文件 |
| ② 个性化 PageRank | CSR 稀疏矩阵 + 切比雪夫加速 | 发现文件图中的"重要节点" |
| ③ Beta-伯努利置信度 | 贝叶斯下置信界（95% CI） | 避免过拟合，保守预测 |
| ④ NMF 潜在因子 | 非负矩阵分解 | 发现"前端调试模式"等隐模式 |
| ⑤ 条件熵路由 | `H(Y\|X)` 信息熵 | 只有高确信度才触发预取 |

**条件熵计算：**

```
H(Y|X) = -Σ P(x,y) · log₂ P(y|x)
```

熵越小，X→Y 的转移越确定，预取优先级越高。

**VS Code 做不到的：**

- **无程序化预取**：VS Code 依赖用户手动 Pin 标签或使用 `Cmd+P`
- **无学习能力**：IDEACODE 的 PageRank 重启向量会偏向你近期访问的文件，排名反映的是**你个人的**导航模式
- **冷启动保护**：Beta-伯努利贝叶斯推断确保了即使数据稀少也不会做出离谱的预测

---

### 3. 自进化搜索排序（Multi-Armed Bandit Ranker）

> ![搜索与替换](docs/images/search-replace.png)

IDEACODE 将搜索结果排序建模为一个**强化学习的 Explore-Exploit 问题**。每次你点击（或忽略）一个搜索结果，系统都在学习你的偏好。

**双策略实现：**

| 策略 | 原理 | 特点 |
|------|------|------|
| **Thompson 采样** | 为每个结果维护 `Beta(α, β)` 后验分布，每轮采样得分排序 | 自然的探索-利用平衡 |
| **UCB（上置信界）** | `得分 = μ̂ + c · √(ln t / n)` | 次线性遗憾 `O(√(T ln T))` 保证 |

**评分融合：**

```
final_score = 0.3 × static_relevance + 0.7 × learned_preference
```

**VS Code 做不到的：**

- **静态评分**：VS Code 的 `Cmd+P` 使用固定的模糊匹配加近期/频率权重
- **不学习**：你点了什么，忽略了什么——VS Code 不会从这些行为中学习
- **时间衰减**：IDEACODE 的老偏好会随时间自然衰减，适应项目上下文的演变
- **后悔保证**：UCB 策略在数学上可证明会收敛到最优排序

---

### 4. AI 代码辅助（LifeAiCode）—— 不止是聊天

> ![AI 对话](docs/images/ai-chat.png)
> ![AI Agent](docs/images/ai-agent.png)

LifeAiCode 是一个**多 LLM 厂商**的 AI 编程助手，支持 7 种模型厂商统一界面，一键切换。它的架构设计有四个 VS Code Copilot 不具备的关键能力：

#### 4.1 结构化建议系统

> ![AI 代码审查](docs/images/ai-code-review.png)

AI 的建议不是一段自由文本，而是**结构化的、带生命周期管理**的数据对象：

```
Generated → Pending → Accepted → Applied
                     ↘ Rejected
```

每条建议包含：
- **类型分类**：重构 / Bug 修复 / 新功能 / 性能优化 / 代码解释
- **文件级变更**：`{ filePath, original, modified, startLine, endLine }`
- **Diff 预览**：接受前可并排查看差异
- **批量审查**：可以一次性审查所有 AI 建议再决定应用哪些

> VS Code Copilot 的内联建议是瞬时的（接受/拒绝后立即消失），而 IDEACODE 的建议有完整的持久化生命周期。

#### 4.2 双路径编辑模型

IDEACODE 提供了两条截然不同的 AI 编辑路径：

| 路径 | 方式 | 需要确认 | 适用场景 |
|------|------|---------|---------|
| **安全路径** | `apply_edit` / `write_file` Agent 工具 | ✅ 每次需要用户确认 | 默认工作流 |
| **直接路径** | `lifeAiCode.editCode` RPC（直接写 Monaco 缓冲区） | ❌ `aiEditMode` 开启时自动生效 | 快速迭代 |

两条路径由 Redux 中的一个 `aiEditMode` 开关控制，Agent 可以根据用户偏好无缝切换。

> VS Code 的 Copilot Edit 面板是独立的工作区，而 IDEACODE 的双路径模型让 Agent 在同一对话中既能安全建议又能快速直接修改。

#### 4.3 Agent 模式（自主工具执行）

> ![AI 修改确认](docs/images/ai-diff-confirm.png)

Agent 可以自主执行以下 6 种工具，最多 10 轮 LLM 调用：

| 工具 | 功能 | 安全限制 |
|------|------|---------|
| `read_file` | 读取文件 | 500KB 上限，工作区边界检查 |
| `get_file_tree` | 获取目录树 | 最大 4 层 / 120 个文件 |
| `search_files` | 正则搜索 | 最多 100 个文件 / 50 个匹配 |
| `write_file` | 创建/覆盖文件 | 5MB 上限，需用户确认 |
| `apply_edit` | 查找替换编辑 | 双重匹配（精确 + 空白归一化），需用户确认 |
| `execute_shell` | 执行命令 | 屏蔽危险命令（rm -rf /, mkfs, fork bomb 等） |

**关键设计决策：**

- **FIFO 任务队列**：同一时间只有一个 Agent 任务运行
- **AbortController**：取消按钮通过 `AbortSignal` 立即终止 HTTP 请求
- **双重工具调用**：原生 `tool_calls`（OpenAI/DeepSeek 等）或 Prompt 注入 `<tool_call>` XML 标签（其他厂商）
- **审计日志**：所有 Agent 操作写入 `~/.lifeAiCode-agent-audit.log`
- **Planner 子模块**：复杂任务（如"重构...并...测试"）先生成 JSON 执行计划再执行

> VS Code Copilot Chat 的 Agent 模式功能更基础，没有多轮规划、审计日志和统一的多厂商兼容层。

#### 4.4 支持的 LLM 厂商

> ![AI 模型配置](docs/images/ai-settings.png)

| 厂商 | 标识 | 默认模型 | API Base URL |
|------|------|---------|-------------|
| OpenAI | `openai` | `gpt-4o` | `https://api.openai.com/v1` |
| Anthropic | `anthropic` | `claude-3-sonnet` | `https://api.anthropic.com/v1` |
| DeepSeek | `deepseek` | `deepseek-v4-flash` | `https://api.deepseek.com` |
| GLM (智谱) | `glm` | `glm-4-plus` | `https://open.bigmodel.cn/api/paas/v4` |
| Qwen (千问) | `qwen` | `qwen-plus` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Ollama (本地) | `ollama` | `deepseek-coder` | `http://localhost:11434` |
| 自定义 | `custom` | 用户自填 | 用户自填 |

```bash
# 通过环境变量配置 API Key
export OPENAI_API_KEY="sk-..."
export DEEPSEEK_API_KEY="sk-..."
export ZHIPU_API_KEY="..."
export ANTHROPIC_API_KEY="sk-ant-..."
export DASHSCOPE_API_KEY="sk-..."
```

---

### 5. 终端增强 —— 不止是 xterm.js 的包装

> ![内置终端](docs/images/terminal.png)

IDEACODE 的终端系统在 xterm.js 之上添加了多项独特能力：

#### 5.1 广播模式
将一个终端的输入同步复制到所有标记为"接收"的终端。多机 SSH 操作时，同一个命令可以同时发送到所有服务器。

#### 5.2 书签（跳表数据结构）
终端滚动缓冲区支持书签功能，底层使用**跳表（Skip List）**实现 `O(log n)` 的查找/插入/删除：

```
插入 → 二分搜索定位 + 随机层高 → O(log n)
查找 → 跳表层间跳跃            → O(log n)
```

> VS Code 终端没有书签功能。

#### 5.3 密码自动检测
监听终端输出流，通过正则 `/password\s*:/i` 检测密码提示，自动填入预配置的凭证。支持 3 秒超时回退。凭证不存储在 Redux 状态中，不会被日志泄露。

#### 5.4 输出折叠（区间树）
大量终端输出自动折叠为可展开区块。底层使用 **AVL 平衡区间树**：
- `findContaining(point)` — 定位某行属于哪个折叠区块 → `O(log n)`
- `findOverlapping(start, end)` — 视口渲染查询 → `O(log n + k)`

#### 5.5 搜索加速（Aho-Corasick + Cuckoo 过滤器 + Boyer-Moore）

| 数据结构 | 用途 | 复杂度 |
|----------|------|--------|
| **Aho-Corasick 自动机** | 多模式匹配（如 `gti → git` 纠错） | `O(n + m)` 单次扫描 |
| **Cuckoo 过滤器** | 快速去重（支持删除，95% 填充率） | `O(1)` 查找 |
| **Boyer-Moore** | 坏字符启发式快速单模式搜索 | 亚线性平均性能 |

#### 5.6 AI 异常检测
自动识别命令失败模式并建议修复：
- `npm install` 失败 → "尝试 --legacy-peer-deps"
- `git push` 失败 → "尝试 --force-with-lease"
- `tsc` 错误 → "检查 tsconfig.json"

#### 5.7 终端形态切换
终端可以在**底部面板 ↔ 编辑器区域标签页 ↔ 浮动模态窗口**之间自由切换。

---

### 6. 实时系统资源监控

> ![状态栏](docs/images/status-bar.png)

IDEACODE 的状态栏直接显示 **CPU / 内存 / GPU** 的实时使用率：

```
数据源: Electron main process (push-based)
传输方式: IPC 推送事件（非轮询）
显示位置: 状态栏右侧（Cpu / MemoryStick / Monitor 图标 + 百分比）
```

每个指标都有悬浮提示显示精确数值。

> VS Code 状态栏不提供任何系统资源可见性。

---

### 7. 文件社区发现（Spectral Clustering + Tensor Decomposition）

> ![文件浏览器](docs/images/file-explorer.png)

IDEACODE 不仅按目录结构组织文件——它自动发现文件之间的**语义关联**：

**谱聚类（Ng-Jordan-Weiss）：**
- 构建文件共现图的归一化拉普拉斯矩阵 `L = I - D⁻¹ᐟ²·W·D⁻¹ᐟ²`
- 提取最小 k 个特征向量进行 k-means 聚类
- 找到文件的"自然分组"（如"前端调试组"、"配置文件组"）

**CP 张量分解：**
- 建模三维张量 `T[文件A, 文件B, 关系类型] ≈ Σᵣ λᵣ · aᵣ ∘ bᵣ ∘ cᵣ`
- 通过 ALS（交替最小二乘）求解
- 发现间接关联的文件（例如通过 import 链连接的文件）

> VS Code 的文件浏览器是纯层级式的——IDEACODE 在文件系统之上引入了一层语义结构。

---

### 8. FM-Index 压缩搜索（终端输出缓冲区）

> ![内置终端](docs/images/terminal.png)

IDEACODE 的终端文本搜索使用 **Ferragina-Manzini Index**（BWT + wavelet trees），而非线性字符串扫描：

**核心操作——后向搜索：**

```
sp = 0, ep = n-1
for i = len(pattern)-1 down to 0:
    sp = C[pattern[i]] + Occ(pattern[i], sp)
    ep = C[pattern[i]] + Occ(pattern[i], ep+1) - 1
    if sp > ep: return 0 匹配
return ep - sp + 1 个匹配
```

**优势：**
- **压缩状态**：BWT 将文本压缩到 k 阶熵 (`~H_k`)，对 ANSI 序列密集的终端输出效果极佳
- **O(m) 搜索无需解压**：模式匹配长度 `m`，在 `O(m)` 时间完成
- **流式友好**：新输出到达时可增量更新 BWT
- **O(1) Rank 查询**：预计算的 Int32Array Occ 表

> VS Code 终端用基础 `Cmd+F` 线性扫描。IDEACODE 的 FM-Index 在大量终端历史中搜索时具有数量级优势。

---

## 基础功能

除了上述差异化特性，IDEACODE 也提供了标准 IDE 的核心能力：

| 功能 | 说明 |
|------|------|
| 📁 **文件管理** | 完整的文件树，支持创建/重命名/删除/拖拽/剪切板操作 |
| ✏️ **代码编辑** | Monaco Editor 核心，50+ 语言高亮、TS 语义着色、Cmd+Click 跳转定义 |
| 📑 **分屏编辑** | 多编辑器组并排，标签页拖拽排序，标签历史导航 |
| 🔍 **全局搜索** | 正则/整词/大小写/模糊全文搜索，按文件分组可折叠结果 |
| 🌿 **Git 集成** | 暂存/提交/推送/拉取，分支管理，Diff 对比 |
| 🔗 **SSH 远程管理** | SSH/SFTP 连接管理、远程文件树、交互会话 |
| 🎨 **主题** | 浅色/深色/高对比度，字体大小可调 |
| 🌍 **i18n** | 中/英多语言支持 |

---

## 整体布局

```
┌─────────────────────────────────────────────────┐
│  TopBar（标题栏 / 搜索 / 设置 / 面板切换）        │
├──────┬──────────┬───────────────┬───────────────┤
│Activ-│SidePanel │  主编辑区域     │  RightPanel   │
│ityBar│（文件树/  │（TabBar +     │  （AI 对话/   │
│      │  搜索/   │  MonacoEditor)│   扩展面板）   │
│      │  Git等） ├───────────────┤               │
│      │         │  BottomPanel  │               │
│      │         │  （终端/问题）  │               │
├──────┴──────────┴───────────────┴───────────────┤
│  StatusBar（Git分支/语言/行列号/CPU/内存/GPU）    │
└─────────────────────────────────────────────────┘
```

---

## 技术栈

| 技术 | 说明 |
|------|------|
| React 18 | UI 框架 |
| TypeScript | 类型安全 |
| Vite 5 | 构建工具与热更新 |
| Monaco Editor | VS Code 同款编辑器核心 |
| Electron 30 | 跨平台桌面应用框架 |
| Redux Toolkit | 状态管理 |
| xterm.js + node-pty | 内置终端 + 伪终端 |
| i18next | 国际化 |

---

## 环境要求

- **Node.js** >= 18.12.0
- **npm** >= 9.0
- **操作系统**：macOS / Windows / Linux（需图形界面）

---

## 快速开始

```bash
# 安装依赖
npm install

# 浏览器 Web 版（热更新）
npm run dev

# 桌面开发模式（推荐，Electron 热更新 + DevTools）
npm run electron:dev

# 桌面生产预览
npm run electron:preview
```

> 国内网络安装 Electron 慢时，可使用镜像：
> ```bash
> ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
> ```

---

## 扩展系统

IDEACODE 采用插件式架构，扩展在独立的 Extension Host 子进程中运行，通过 JSON-RPC 与渲染进程通信。

| 扩展 | 目录 | 说明 |
|------|------|------|
| **Git** | `web/git/` | Git 版本控制面板 |
| **SSH** | `web/ssh/` | SSH/SFTP 远程文件管理 |
| **LifeAiCode** | `web/lifeAiCode/` | AI 代码辅助（多 LLM + Agent） |

```bash
# 构建所有扩展
cd web/lifeAiCode && npm run build:all
cd web/git && npm install && npm run build
cd web/ssh && npm install && npm run build
```

---

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | Web 开发服务器 |
| `npm run build` | 生产构建 |
| `npm run preview` | 浏览器预览生产构建 |
| `npm run lint` | ESLint 检查 |
| `npm run electron:dev` | **桌面开发模式**（推荐） |
| `npm run electron:preview` | 桌面生产预览 |

---

## 项目结构

```
ideacode/
├── electron/                     # Electron 主进程
│   ├── main.cjs                  # 窗口管理、菜单
│   ├── preload.cjs               # 安全 IPC 桥接
│   └── extension-host/           # Extension Host RPC
├── src/                          # 渲染进程（IDE 主体）
│   ├── components/               # UI 组件（ActivityBar/Monaco/TabBar/…）
│   ├── store/slices/             # Redux 状态切片
│   ├── plugin/                   # 插件系统 + 扩展桥接
│   ├── services/                 # 文件/终端/Git 服务层
│   ├── utils/algorithms/         # 高级算法（BCM/PageRank/Bandit/FM-Index/…）
│   └── i18n/                     # 国际化
├── web/                          # 扩展前端源码
│   ├── git/
│   ├── ssh/
│   └── lifeAiCode/
├── extensions/                   # 扩展构建产物（gitignored）
├── docs/images/                  # 截图资源
├── package.json
└── vite.config.ts
```

---

## 已知问题

1. **Monaco Editor 首次加载**：核心资源较大，首次打开文件可能有短暂等待（已做预加载优化）
2. **File System Access API 兼容性**：Safari 不支持，建议使用 Electron 桌面端
3. **无头服务器限制**：Electron 需要图形界面环境

---

## 截图贡献

截图清单和截取方法详见 → [docs/images/README.md](docs/images/README.md)

贡献步骤：
1. `npm run electron:dev` 启动桌面应用
2. 打开一个 React/TypeScript 示例项目
3. 按清单截取各功能界面（推荐 PNG / 1920×1080）
4. 将截图放入 `docs/images/` 目录
5. 提交 PR

### 版权声明 / License
1. 本项目代码仅供个人学习、研究或非商业用途使用
- ✅ 允许：查看源码、个人学习研究、非商业性质的交流
- ❌ 禁止：未经书面授权，严禁将本项目用于任何商业用途（包括但不限于作为商业产品的一部分、出售、出租、或用于企业内部盈利性项目
- 如需商业授权或合作，请联系：📧 mailto:chongyin_good@163.com | mailto:mimicy710@gmail.com

```
⚠️ Legal Notice: All Rights Reserved. Unauthorized commercial use is strictly prohibited and will be subject to legal action.
```