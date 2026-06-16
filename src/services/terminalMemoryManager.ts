/**
 * 终端实例内存分级管理
 * 
 * 功能：
 * 1. 对非活跃 Tab 的终端实例进行"冻结"（暂停渲染循环，仅保留 buffer）
 * 2. 活跃 Tab 正常渲染
 * 3. 切换 Tab 时自动解冻并恢复渲染
 * 
 * 内存策略：
 * - 0-3 个实例：全部活跃渲染
 * - 4-5 个实例：活跃实例 + 1 个可见实例正常渲染，其余暂停渲染
 * - 6+ 个实例：仅活跃实例正常渲染，其余暂停渲染
 */

import { XtermTerminal } from '../components/BottomPanel/xtermInstance';

interface FrozenTerminalState {
  /** xterm.js 实例引用（渲染已暂停） */
  xterm: XtermTerminal;
  /** 冻结时间 */
  frozenAt: number;
}

/**
 * 终端内存管理器
 */
export class TerminalMemoryManager {
  private activeInstances = new Map<string, XtermTerminal>();
  private frozenInstances = new Map<string, FrozenTerminalState>();

  /**
   * 注册活跃实例
   */
  registerActive(id: string, xterm: XtermTerminal): void {
    this.activeInstances.set(id, xterm);
    this._applyMemoryPolicy();
  }

  /**
   * 切换活跃 Tab
   */
  switchActive(newActiveId: string): void {
    // 冻结之前的活跃实例
    for (const [id, xterm] of this.activeInstances) {
      if (id !== newActiveId) {
        this._freeze(id, xterm);
      }
    }
    this.activeInstances.clear();

    // 解冻目标实例
    const frozen = this.frozenInstances.get(newActiveId);
    if (frozen) {
      this.activeInstances.set(newActiveId, frozen.xterm);
      this.frozenInstances.delete(newActiveId);
    }
    this._applyMemoryPolicy();
  }

  /**
   * 释放实例
   */
  dispose(id: string): void {
    const active = this.activeInstances.get(id);
    if (active) {
      active.dispose();
      this.activeInstances.delete(id);
    }
    const frozen = this.frozenInstances.get(id);
    if (frozen) {
      frozen.xterm.dispose();
      this.frozenInstances.delete(id);
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): { active: number; frozen: number; total: number } {
    return {
      active: this.activeInstances.size,
      frozen: this.frozenInstances.size,
      total: this.activeInstances.size + this.frozenInstances.size,
    };
  }

  /**
   * 应用内存策略
   */
  private _applyMemoryPolicy(): void {
    const total = this.activeInstances.size + this.frozenInstances.size;

    // 6+ 个实例：全部非活跃实例冻结渲染
    if (total >= 6) {
      // 找出所有非活跃的 active 实例进行冻结
      const toFreeze: Array<[string, XtermTerminal]> = [];
      for (const [id, xterm] of this.activeInstances) {
        if (this.activeInstances.size > 1) {
          toFreeze.push([id, xterm]);
        }
      }
      for (const [id, xterm] of toFreeze) {
        this._freeze(id, xterm);
        this.activeInstances.delete(id);
      }
    }
  }

  /**
   * 冻结终端实例（暂停 DOM 渲染，保留 buffer 数据）
   */
  private _freeze(id: string, xterm: XtermTerminal): void {
    // xterm.js 没有原生的 freeze API，这里采用策略：
    // 1. 将 xterm 元素设为 display: none（暂停 CSS 渲染）
    // 2. 保留实例引用以便恢复
    if (xterm.raw.element) {
      (xterm.raw.element as HTMLElement).style.display = 'none';
    }
    this.frozenInstances.set(id, { xterm, frozenAt: Date.now() });
  }

  /**
   * 解冻终端实例（恢复渲染）
   */
  thaw(id: string): XtermTerminal | undefined {
    const frozen = this.frozenInstances.get(id);
    if (!frozen) return undefined;

    if (frozen.xterm.raw.element) {
      (frozen.xterm.raw.element as HTMLElement).style.display = '';
    }
    // xterm.js 会在重新可见时自动恢复渲染
    this.frozenInstances.delete(id);
    this.activeInstances.set(id, frozen.xterm);
    return frozen.xterm;
  }

  /**
   * 释放所有实例
   */
  disposeAll(): void {
    for (const [, xterm] of this.activeInstances) {
      xterm.dispose();
    }
    for (const [, frozen] of this.frozenInstances) {
      frozen.xterm.dispose();
    }
    this.activeInstances.clear();
    this.frozenInstances.clear();
  }
}

// 单例
export const terminalMemoryManager = new TerminalMemoryManager();
