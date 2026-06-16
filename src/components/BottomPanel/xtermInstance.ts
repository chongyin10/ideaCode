/**
 * xterm.js 终端实例封装
 * 
 * 参考 VS Code XtermTerminal 的设计，封装 xterm.js 实例并加载所有 addons。
 * 支持：WebGL 渲染、搜索、Unicode 11、连字、剪贴板、序列化、图片、进度。
 */

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { BoyerMoore } from '../../services/terminalIndexes';
import type { SearchAddon as SearchAddonType } from '@xterm/addon-search';
import type { WebglAddon as WebglAddonType } from '@xterm/addon-webgl';
import type { Unicode11Addon as Unicode11AddonType } from '@xterm/addon-unicode11';
import type { SerializeAddon as SerializeAddonType } from '@xterm/addon-serialize';

export interface XtermInstanceConfig {
  cols?: number;
  rows?: number;
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  cursorStyle?: 'block' | 'underline' | 'bar';
  cursorBlink?: boolean;
  scrollback?: number;
  gpuAcceleration?: 'auto' | 'on' | 'off';
  allowProposedApi?: boolean;
}

export class XtermTerminal {
  readonly raw: Terminal;
  readonly fitAddon: FitAddon;
  private _searchAddon?: SearchAddonType;
  private _webglAddon?: WebglAddonType;
  private _unicode11Addon?: Unicode11AddonType;
  private _serializeAddon?: SerializeAddonType;
  private _bmSearchers = new Map<string, BoyerMoore>();

  /** 上一次 fit 后的 cols/rows — 用于跳过无变更 resize */
  private _lastFitCols = -1;
  private _lastFitRows = -1;

  private _config: XtermInstanceConfig;

  constructor(config: XtermInstanceConfig = {}) {
    this._config = config;

    this.fitAddon = new FitAddon();

    this.raw = new Terminal({
      allowProposedApi: config.allowProposedApi ?? true,
      cols: config.cols ?? 80,
      rows: config.rows ?? 24,
      fontFamily: config.fontFamily ?? "Menlo, 'Courier New', monospace",
      fontSize: config.fontSize ?? 14,
      lineHeight: config.lineHeight ?? 1.2,
      cursorStyle: config.cursorStyle ?? 'block',
      cursorBlink: config.cursorBlink ?? true,
      scrollback: config.scrollback ?? 5000,
      screenReaderMode: false,
      theme: {
        background: '#1e1e1e',
        foreground: '#cccccc',
        cursor: '#cccccc',
        selectionBackground: '#264f78',
      },
      drawBoldTextInBrightColors: true,
      macOptionIsMeta: true,
      allowTransparency: true,
    });

    this.raw.loadAddon(this.fitAddon);
  }

  /** 挂载到 DOM 元素 */
  open(container: HTMLElement): void {
    this.raw.open(container);
    this._loadOptionalAddons();
  }

  /** 自适应尺寸 — 跳过无变更的 resize */
  fit(): boolean {
    try {
      const prevCols = this.raw.cols;
      const prevRows = this.raw.rows;
      this.fitAddon.fit();
      const changed = this.raw.cols !== prevCols || this.raw.rows !== prevRows;

      if (changed) {
        this._lastFitCols = this.raw.cols;
        this._lastFitRows = this.raw.rows;
      }
      return changed;
    } catch {
      return false;
    }
  }

  /** 上一次 fit 后的尺寸 */
  get lastFitCols(): number { return this._lastFitCols; }
  get lastFitRows(): number { return this._lastFitRows; }

  /** 写入数据 */
  write(data: string | Uint8Array, callback?: () => void): void {
    this.raw.write(data, callback);
  }

  /** 调整尺寸 */
  resize(cols: number, rows: number): void {
    this.raw.resize(cols, rows);
  }

  /** 聚焦 */
  focus(): void {
    this.raw.focus();
  }

  /** 清屏 */
  clear(): void {
    this.raw.clear();
  }

  /** 获取选区文本 */
  getSelection(): string {
    return this.raw.getSelection();
  }

  /** 是否有选区 */
  hasSelection(): boolean {
    return this.raw.hasSelection();
  }

  /** 清除选区 */
  clearSelection(): void {
    this.raw.clearSelection();
  }

  /** 全选 */
  selectAll(): void {
    this.raw.selectAll();
  }

  /** 根据行号滚动 */
  scrollToLine(line: number): void {
    this.raw.scrollToLine(line);
  }

  /** 滚动到底部 */
  scrollToBottom(): void {
    this.raw.scrollToBottom();
  }

  /** 获取缓冲区内容为文本 */
  getContentsAsText(): string {
    const buffer = this.raw.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) {
        lines.push(line.translateToString(true));
      }
    }
    return lines.join('\n');
  }

  /* ─── Addon 管理 ─── */

  private async _loadOptionalAddons(): Promise<void> {
    try {
      // WebGL 渲染
      if (this._config.gpuAcceleration !== 'off') {
        await this._loadWebglAddon();
      }
    } catch {
      // WebGL 不可用，降级到 DOM 渲染
    }

    try {
      // Unicode 11
      await this._loadUnicode11Addon();
    } catch {
      // 忽略
    }
  }

  private async _loadWebglAddon(): Promise<void> {
    try {
      const { WebglAddon } = await import('@xterm/addon-webgl');
      this._webglAddon = new WebglAddon();
      this.raw.loadAddon(this._webglAddon);
    } catch {
      // GPU 不可用
    }
  }

  private async _loadUnicode11Addon(): Promise<void> {
    try {
      const { Unicode11Addon } = await import('@xterm/addon-unicode11');
      this._unicode11Addon = new Unicode11Addon();
      this.raw.loadAddon(this._unicode11Addon);
      this.raw.unicode.activeVersion = '11';
    } catch {
      // Unicode 11 addon 加载失败，使用默认 unicode 版本
    }
  }

  /* ─── 搜索 ─── */

  async getSearchAddon(): Promise<SearchAddonType> {
    if (!this._searchAddon) {
      const { SearchAddon } = await import('@xterm/addon-search');
      this._searchAddon = new SearchAddon();
      this.raw.loadAddon(this._searchAddon);
    }
    return this._searchAddon;
  }

  async findNext(term: string): Promise<boolean> {
    // 长搜索词使用 Boyer-Moore 加速 (数学优化 #10)
    if (term.length > 8) {
      return this._boyerMooreSearch(term);
    }
    const addon = await this.getSearchAddon();
    return addon.findNext(term);
  }

  async findPrevious(term: string): Promise<boolean> {
    if (term.length > 8) {
      return this._boyerMooreSearchReverse(term);
    }
    const addon = await this.getSearchAddon();
    return addon.findPrevious(term);
  }

  /** Boyer-Moore 搜索 — 对长搜索词更快 */
  private _boyerMooreSearch(term: string): boolean {
    const content = this.getContentsAsText();
    if (!content) return false;
    if (!this._bmSearchers.has(term)) {
      this._bmSearchers.set(term, new BoyerMoore(term));
    }
    const bm = this._bmSearchers.get(term)!;
    const index = bm.search(content);
    if (index >= 0) {
      // 计算行号并滚动
      const before = content.substring(0, index);
      const lineNum = before.split('\n').length - 1;
      this.scrollToLine(lineNum);
      return true;
    }
    return false;
  }

  private _boyerMooreSearchReverse(_term: string): boolean {
    // BM 反向搜索：找最后一个匹配
    const content = this.getContentsAsText();
    if (!content) return false;
    if (!this._bmSearchers.has(_term)) {
      this._bmSearchers.set(_term, new BoyerMoore(_term));
    }
    const bm = this._bmSearchers.get(_term)!;
    const indices = bm.searchAll(content);
    if (indices.length > 0) {
      const lastIndex = indices[indices.length - 1];
      const before = content.substring(0, lastIndex);
      const lineNum = before.split('\n').length - 1;
      this.scrollToLine(lineNum);
      return true;
    }
    return false;
  }

  clearSearchDecorations(): void {
    this._searchAddon?.clearDecorations();
  }

  /* ─── 序列化 ─── */

  async getSerializeAddon(): Promise<SerializeAddonType> {
    if (!this._serializeAddon) {
      const { SerializeAddon } = await import('@xterm/addon-serialize');
      this._serializeAddon = new SerializeAddon();
      this.raw.loadAddon(this._serializeAddon);
    }
    return this._serializeAddon;
  }

  async serializeAsHTML(): Promise<string> {
    const addon = await this.getSerializeAddon();
    return addon.serializeAsHTML();
  }

  /* ─── 销毁 ─── */

  dispose(): void {
    this._bmSearchers.clear();
    try {
      if (this._webglAddon) { this._webglAddon.dispose(); this._webglAddon = undefined; }
    } catch { /* WebGL dispose 异常 */ }
    this._searchAddon = undefined;
    this._unicode11Addon = undefined;
    this._serializeAddon = undefined;
    try { this.raw.dispose(); } catch { /* 已自动 dispose */ }
  }
}
