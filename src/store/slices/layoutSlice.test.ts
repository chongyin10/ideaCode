import { describe, it, expect } from 'vitest';
import reducer, { layoutActions, MIN_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH } from './layoutSlice';
import type { PanelId, BottomTabId } from './layoutSlice';

const actions = layoutActions;

describe('layoutSlice', () => {
  it('初始状态侧栏折叠、资源管理器激活', () => {
    const state = reducer(undefined, { type: 'init' });
    expect(state.sidePanelVisible).toBe(false);
    expect(state.activePanel).toBe('explorer');
    expect(state.sidePanelWidth).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(state.panelOrder).toContain('explorer');
  });

  it('switchPanel 激活面板并展开侧栏', () => {
    const state = reducer(undefined, { type: 'init' });
    const next = reducer(state, actions.switchPanel('search' as PanelId));
    expect(next.activePanel).toBe('search');
    expect(next.sidePanelVisible).toBe(true);
  });

  it('重复点击当前面板切换为折叠', () => {
    const state = reducer(undefined, { type: 'init' });
    const opened = reducer(state, actions.switchPanel('explorer' as PanelId));
    expect(opened.sidePanelVisible).toBe(true);
    const closed = reducer(opened, actions.switchPanel('explorer' as PanelId));
    expect(closed.sidePanelVisible).toBe(false);
  });

  it('动态面板加入 panelOrder 末尾', () => {
    const state = reducer(undefined, { type: 'init' });
    const next = reducer(state, actions.switchPanel('custom-panel' as PanelId));
    expect(next.panelOrder[next.panelOrder.length - 1]).toBe('custom-panel');
  });

  it('setSidePanelWidth 保留下限', () => {
    const state = reducer(undefined, { type: 'init' });
    const next = reducer(state, actions.setSidePanelWidth(50));
    expect(next.sidePanelWidth).toBe(MIN_SIDEBAR_WIDTH);
    const widened = reducer(state, actions.setSidePanelWidth(800));
    expect(widened.sidePanelWidth).toBe(800);
  });

  it('toggleSidePanel 翻转可见性', () => {
    const state = reducer(undefined, { type: 'init' });
    const opened = reducer(state, actions.toggleSidePanel());
    expect(opened.sidePanelVisible).toBe(true);
    expect(reducer(opened, actions.toggleSidePanel()).sidePanelVisible).toBe(false);
  });

  it('activateVirtualPanel 选中但不展开侧栏', () => {
    const state = reducer(undefined, { type: 'init' });
    const next = reducer(state, actions.activateVirtualPanel('workflow' as PanelId));
    expect(next.activePanel).toBe('workflow');
    expect(next.sidePanelVisible).toBe(false);
  });

  it('toggleBottomPanel 与 switchBottomTab', () => {
    const state = reducer(undefined, { type: 'init' });
    expect(state.bottomPanelVisible).toBe(false);
    const withTab = reducer(state, actions.switchBottomTab('terminal' as BottomTabId));
    expect(withTab.activeBottomTab).toBe('terminal');
    expect(withTab.bottomPanelVisible).toBe(true);
    const closed = reducer(withTab, actions.toggleBottomPanel());
    expect(closed.bottomPanelVisible).toBe(false);
  });

  it('toggleRightPanel 关闭时同时退出全屏', () => {
    let state = reducer(undefined, { type: 'init' });
    state = reducer(state, actions.toggleRightPanel()); // 打开
    state = reducer(state, actions.setRightPanelMaximized(true)); // 全屏
    state = reducer(state, actions.toggleRightPanel()); // 关闭
    expect(state.rightPanelVisible).toBe(false);
    expect(state.rightPanelMaximized).toBe(false);
  });
});
