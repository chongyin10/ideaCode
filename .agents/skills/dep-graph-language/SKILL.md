---
name: dep-graph-language
description: 工作流可视化（依赖图）的多语言架构说明与新增语言支持的标准流程（typescript、python、java、rust、c/c++）
type: prompt
whenToUse: 当用户要求某种新语言/新文件后缀支持「工作流可视化」依赖图，或反馈某种语言的依赖连线缺失、误连时
---

# 依赖图多语言架构

## 核心原则

- 资源管理器右键「工作流可视化」→ 解析文件间引入关系 → 生成统一的工作流画布（节点=文件，边=引入）。
- 解析是**纯同步启发式正则**，不引 AST 依赖；解析失败的说明符返回 null，该条引入不参与构图（宁缺毋滥）。
- 每种语言一个 `LanguageAnalyzer`，注册进注册表即完成接入，菜单门控、构图、布局、聚合全部自动生效，无需改画布代码。

## 关键文件与链路

1. **`src/services/dependencyGraphLanguages.ts`** — 语言分析器注册表，所有改动从这里开始：
   - `LanguageAnalyzer` 接口：`extensions`（小写带点）、`extractSpecifiers(content)`（提取引入说明符，原始书写形式）、`resolveSpecifier(spec, fromRel, fileSet)`（解析为项目内 posix 相对路径，失败返回 null）。
   - `LANGUAGE_ANALYZERS`：注册表数组，**TS/JS 必须首位**（重叠扩展名优先命中）；`getAnalyzerForFile(name)` 按扩展名取分析器；`CODE_EXTENSIONS` 为全注册扩展名合集。
   - 共用工具：`normalizePath`（posix 归一化 `./ ../`）、`stripComments`（剔块/行注释，行注释要求前导非 `:` 防误伤 http://）。
   - 已注册语言及解析规则：
     - **typescript**（.ts/.tsx/.js/.jsx/.mjs/.cjs）：`import/export from`、`import()`、`require()`；仅 `./ ../` 相对说明符；解析=归一化后查 fileSet，补扩展名或 `/index+ext`。
     - **python**（.py）：`import a.b`、`from a.b import x`、`from . import x`、`from ..a import b`；点号→路径，候选 `a/b.py` 与 `a/b/__init__.py`；绝对引入先按当前文件同级目录、再按项目根解析。
     - **java**（.java）：`import com.foo.Bar;`（含 static，跳过 `.*` 通配）；`com/foo/Bar.java` 对 fileSet 做 `endsWith` 后缀匹配，兼容 src/main/java 等源根。
     - **rust**（.rs）：`mod foo;`、`use crate::/super::/self::`；`mod foo` → `<dir>/foo.rs`、`<dir>/foo/mod.rs`；`crate::` 以路径中最后一个 `src` 目录为 crate 根；use 末段是模块内项时退化为模块级连线。
     - **go**（.go）：`import "path"` 单行/块（含别名、`.`、`_`）；import 路径末段与项目内 .go 文件目录做后缀匹配，取唯一命中的最长后缀，连线到包目录代表文件（优先 `<末段>.go`）；标准库/第三方包/歧义目录返回 null，测试文件（`_test.go`）不参与。
     - **c**（.c/.h/.cpp/.hpp/.cc/.hh）：仅 `#include "..."` 引号包含（尖括号跳过）；先当前文件目录相对、再项目根相对。
2. **`src/services/dependencyGraph.ts`** — 构图与布局，语言无关：
   - `isCodeFile(name)`：`getAnalyzerForFile(name) !== null`，是菜单门控唯一判据（`ExplorerContent.tsx` 右键菜单据此显隐「工作流可视化」）。
   - `buildDependencyGraph`：`parseFile` 按扩展名分派分析器做 extract/resolve；目录模式候选过滤与文件模式入口检查都走 `isCodeFile`。
   - `CODE_EXTENSIONS` 从此文件 re-export，对外 API 不变。
3. **`src/components/SidePanel/ExplorerContent.tsx`**：右键菜单入口，`isCodeFile` 判据无需随语言扩展改动。
4. **画布**：`src/components/DependencyGraphCanvas/`，只消费 `WorkflowFileData`，与语言无关。

## 新增一种语言的标准流程

1. 在 `dependencyGraphLanguages.ts` 新增一个 `LanguageAnalyzer`：写 `extractSpecifiers`（注意剔除注释后匹配、行首锚定防误匹配）与 `resolveSpecifier`（把语言自身的模块语义映射到 fileSet 内的相对路径），追加到 `LANGUAGE_ANALYZERS`。
2. 验证：`npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep -E "dependencyGraph"`（grep 无输出即无新错）+ `npx eslint` 两个文件；再写临时脚本对 extract/resolve 做样例断言（用后删除）。
3. 实机验证：含该语言的项目目录右键「工作流可视化」，检查节点与连线。

## 注意事项

- **第三方依赖/缓存/构建产物目录不参与构图**：`dependencyGraph.ts` 的 `EXCLUDED_DIR_SEGMENTS`（node_modules、venv、.venv、__pycache__、site-packages、target、vendor）按路径段匹配，候选文件与解析出的依赖都会被过滤——否则项目内 venv 会把 site-packages 整棵依赖树灌进图里。用户明确对排除目录内的目标构图时不排除。
- **`renameFileWithImportSync`（重命名同步改引入）是 TS/JS 专用**：说明符改写只认 import/require 语法（`TS_FILE_RE` + `extractTsSpecifiers`/`resolveTsSpecifier`），其他语言重命名只改文件名，不同步引入语句。若要支持需按语言各写改写规则。
- 各语言已知限制（启发式不覆盖，属预期行为）：
  - python：`sys.path` 动态注入、site-packages 第三方包解析不到。
  - java：同包类无需 import，无 import 即无边；JDK 类（java.\*/javax.\*）不参与。
  - rust：宏生成模块、`#[path]` 属性、extern crate 不覆盖。
  - c/c++：编译参数 `-I` 注入的 include 路径不覆盖；只连头文件包含，不连符号级依赖。
- 说明符解析必须容忍 fileSet 未命中（返回 null），严禁抛异常中断整图构建。
