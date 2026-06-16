/**
 * 终端实例内存分级管理
 * 
 * 数学优化 (#6/#7):
 * - Zipf 分布活跃预测
 * - Markov 链预测下一个活跃 tab → 提前解冻
 * - 约束优化: 动态决定活跃实例数
 */

import { XtermTerminal } from '../components/BottomPanel/xtermInstance';
import { TabActivityTracker, MarkovPredictor } from './terminalStats';

interface FrozenTerminalState {
  xterm: XtermTerminal;
  frozenAt: number;
}

export class TerminalMemoryManager {
  private activeInstances = new Map<string, XtermTerminal>();
  private frozenInstances = new Map<string, FrozenTerminalState>();
  public activity = new TabActivityTracker();
  public markov = new MarkovPredictor();

  registerActive(id: string, xterm: XtermTerminal): void {
    this.activeInstances.set(id, xterm);
    this._applyMemoryPolicy();
  }

  /** 记录切换并预测预解冻 */
  switchActive(newActiveId: string, previousId?: string): void {
    this.activity.recordSwitch(newActiveId);
    if (previousId) this.markov.recordTransition(previousId, newActiveId);

    // Markov 预测: 预解冻下一个可能的 tab
    const predicted = this.markov.predict(newActiveId);
    if (predicted && this.frozenInstances.has(predicted)) {
      this.thaw(predicted);
    }

    // 冻结旧的
    for (const [id, xterm] of this.activeInstances) {
      if (id !== newActiveId) this._freeze(id, xterm);
    }
    this.activeInstances.clear();

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

    // Zipf 约束优化: 根据切换频率动态决定活跃数
    const candidateIds = Array.from(this.activeInstances.keys());
    const zipfScores = candidateIds.map(id => ({ id, score: this.activity.getScore(id) }));
    zipfScores.sort((a, b) => b.score - a.score);

    // 动态阈值: 高频切换 → 保持 3+ 活跃, 低频 → 只保持 1 活跃
    const recentSwitchCount = Array.from(candidateIds).reduce((sum, id) => sum + this.activity.getScore(id), 0);
    const activeTarget = recentSwitchCount > 5 ? 3 : 1;

    if (total >= 6) {
      const toFreeze: Array<[string, XtermTerminal]> = [];
      for (const [id, xterm] of this.activeInstances) {
        if (this.activeInstances.size > activeTarget) {
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
