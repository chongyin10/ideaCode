---
name: file-preview
description: IDEACODE 编辑器二进制/媒体文件预览架构说明与新增文件类型预览的标准流程（pdf、图片、视频、音频、word/docx、二进制兜底）
type: prompt
whenToUse: 当用户要求支持某种新文件后缀的打开/预览，或反馈某个文件打开后是乱码、二进制内容被当文本显示时
---

# IDEACODE 文件预览架构

## 核心原则

- 文本文件 → Monaco Editor（`language` 由 `src/utils/languageFromPath.ts` 推断）。
- 二进制/媒体文件 → **绝不进 Monaco**（utf-8 读取会乱码且撑爆内存），以 `content: ''` + `readOnly: true` 打开，`language` 字段标记预览类型，由 `MediaViewer` 渲染。

## 关键文件与链路

1. **`src/utils/fileType.ts`** — 单点分类，所有改动从这里开始：
   - `getFileKind(name)`：扩展名 → `'pdf' | 'image' | 'video' | 'audio' | 'text'`，维护 `IMAGE_MIME_MAP` / `VIDEO_MIME_MAP` / `AUDIO_MIME_MAP`。
   - `getPreviewMime(name, kind)`：构造 Blob 用的 MIME。
   - `sniffKindFromContent(content)`：魔数嗅探（%PDF-、PNG、RIFF/WEBP、GIF8、ftyp、OggS、ID3）。用于扩展名不可信的场景（如 `xxx.png.baiduyun.uploading.cfg` 网盘临时文件）。注意 utf-8 解码后非法字节变 U+FFFD，但 ASCII 魔数保留，可安全匹配。
   - `isBinaryContent(content)`：前 8KB NUL 一票否决 + 控制字符比例 >10% 判定二进制。
   - `BINARY_VIEWER_LANGS`：不走 Monaco 的 language 集合。
2. **`src/store/slices/workspaceSlice.ts` `openFile`**：分类入口。kind 非 text → 只读打开不读内容；text → 读文本后先魔数嗅探、再二进制启发式，命中则改以对应预览类型只读打开。`refreshOpenedFiles` / `reloadFilesFromDisk` 用 `BINARY_VIEWER_LANGS.has(file.language)` 跳过二进制文件。
3. **`src/components/MediaViewer/`**：统一预览组件。pdf → iframe + Chromium 内置 PDFium；image → `<img>`；video/audio → 原生 `<video>/<audio controls>`；word（仅 .docx）→ `mammoth.convertToHtml({ arrayBuffer })` 转 HTML 渲染（浅色纸张容器，旧版 .doc 无可靠 JS 方案，走 binary 兜底）；binary → 兜底提示页（不读内容）。内容经 `readFileBase64` 加载，Blob URL 卸载时 `revokeObjectURL`。mammoth 是既有依赖（扩展宿主 docExtractor 也用它），浏览器端直接用 `import { convertToHtml } from 'mammoth'`。
4. **`src/services/fileService.ts` `readFileBase64`**：本地走 IPC `fs:readFileBase64`（主进程 `electron/main/ipcHandlers/fsHandler.cjs`，含 128MB 上限与 EISDIR 保护）；浏览器 FileSystemHandle 走 arrayBuffer 分块转 base64；远程（SSH）URI 抛错提示不支持。
5. **`src/pages/Home.tsx`**：`BINARY_VIEWER_LANGS.has(file.language)` 分支懒加载渲染 `MediaViewer`；`getTabType` 控制 tab 锁图标。
6. **`electron/main/windowManager.cjs`**：`webPreferences.plugins: true` 是 iframe 渲染 PDF 的前提，勿删。

## 新增一种预览类型的标准流程

1. 在 `fileType.ts` 加扩展名映射（新 kind 则扩展 `FileKind` 与 `BINARY_VIEWER_LANGS`）。
2. 若魔数可靠，在 `sniffKindFromContent` 加一条 ASCII 魔数匹配（zip 系格式 docx/xlsx 魔数同为 'PK'，无法区分，不要嗅探）。
3. 在 `MediaViewer` 加对应渲染分支（需要新读法时先扩展 `readFileBase64` / 主进程 IPC）。优先复用已有依赖（如 mammoth），新增 npm 依赖前先确认项目里没有同等能力。
4. `npx tsc -b` + `npx vite build` 验证（仓库有存量 tsc 报错，只确认改动文件无新错）。

## 注意事项

- 二进制文件的 `content` 恒为 `''`，任何按文本读回 content 的逻辑（外部变更刷新、git discard 重载）都必须跳过 `BINARY_VIEWER_LANGS`。
- 预览文件 `readOnly: true`，不要为其启用编辑/保存路径。
- SVG 是文本，保留在 Monaco 编辑，不在图片预览之列。
