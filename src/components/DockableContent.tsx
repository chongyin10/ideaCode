import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, History, Settings } from 'lucide-react';
import { useAppSelector } from '../store/hooks';
import { HistoryPopover } from './HistoryPopover';
import { getPluginManager } from '../plugin/core';
import ExplorerContent from './SidePanel/ExplorerContent';
import SearchPanel from './SearchPanel';
import ExtensionsPanel from './ExtensionsPanel';
import WebViewPanel from './WebViewPanel';
import type { DockableItem } from '../store/slices/layoutSlice';
import type { ExtensionView, ExtensionViewAction, ExtensionWebViewPanel } from '../store/slices/extensionUISlice';

interface DockableContentProps {
  item: DockableItem;
  /** 是否在 viewContainer 内容顶部显示扩展自带的 header actions（右侧面板会关闭，改由 tab 栏统一渲染） */
  showViewHeader?: boolean;
}

/**
 * Git 扩展的 Source Control 视图
 *
 * 渲染 web/git 扩展创建的 WebView（viewType='git.changesView'）。
 * Git 功能完全由该扩展提供，不再有内置回退。
 */
function GitExtensionView() {
  const webviewPanels = useAppSelector((s) => s.extensionUI.webviewPanels);
  const { t } = useTranslation();

  // 找到 git 扩展创建的 WebView
  const gitWebview: ExtensionWebViewPanel | undefined = webviewPanels.find(
    (p) => p.extensionId === 'ideacode-git'
  );

  if (gitWebview && gitWebview.html) {
    return (
      <WebViewPanel
        html={gitWebview.html}
        panelId={gitWebview.id}
        extensionPath={gitWebview.extensionPath}
      />
    );
  }

  // WebView 还未挂载时显示占位
  return (
    <div className="panel-placeholder">
      {gitWebview
        ? t('common.loading') || '加载中…'
        : 'Git 扩展正在加载…'}
    </div>
  );
}

const ACTION_ICONS: Record<string, JSX.Element> = {
  'lifeAiCode.newChat': <Plus size={14} strokeWidth={1.5} />,
  'lifeAiCode.showHistory': <History size={14} strokeWidth={1.5} />,
  'lifeAiCode.openConfig': <Settings size={14} strokeWidth={1.5} />,
};

function HistoryActionButton({ action }: { action: ExtensionViewAction }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <span className="extension-view__action-popover-anchor">
      <button
        ref={btnRef}
        className="extension-view__action-btn"
        title={action.tooltip || action.title || action.command}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="extension-view__action-icon">
          {ACTION_ICONS[action.command] || action.icon || action.title}
        </span>
      </button>
      <HistoryPopover open={open} onClose={() => setOpen(false)} anchorRef={btnRef} />
    </span>
  );
}

export function ExtensionViewActions({
  actions,
  renderAction,
}: {
  actions: ExtensionViewAction[];
  renderAction?: (action: ExtensionViewAction, idx: number) => React.ReactNode | null;
}) {
  const aiEditMode = useAppSelector((s) => s.workspace.aiEditMode);

  const handleAction = (action: ExtensionViewAction) => {
    try {
      getPluginManager()?.getCommandManager().executeCommand(action.command);
    } catch (err) {
      console.error(`[ExtensionViewActions] 执行命令失败: ${action.command}`, err);
    }
  };

  return (
    <>
      {actions.map((action, idx) => {
        const custom = renderAction?.(action, idx);
        if (custom) return <span key={`${action.command}-${idx}`}>{custom}</span>;

        // 历史记录：默认弹出 HistoryPopover，不再转发命令
        if (action.command === 'lifeAiCode.showHistory') {
          return <HistoryActionButton key={`${action.command}-${idx}`} action={action} />;
        }

        if (action.type === 'switch') {
          const readonly = !aiEditMode;
          return (
            <label
              key={`${action.command}-${idx}`}
              className="extension-view__action-switch"
              title={action.tooltip || action.title || action.command}
            >
              <input type="checkbox" checked={readonly} onChange={() => handleAction(action)} />
              <span className="extension-view__action-switch-slider" />
            </label>
          );
        }
        const svgIcon = ACTION_ICONS[action.command];
        return (
          <button
            key={`${action.command}-${idx}`}
            className="extension-view__action-btn"
            title={action.tooltip || action.title || action.command}
            onClick={() => handleAction(action)}
          >
            {svgIcon ? (
              <span className="extension-view__action-icon">{svgIcon}</span>
            ) : action.icon ? (
              <span className="extension-view__action-icon">{action.icon}</span>
            ) : (
              <span className="extension-view__action-label">{action.title || '•'}</span>
            )}
          </button>
        );
      })}
    </>
  );
}

function ExtensionViewContent({ view, showHeader = true }: { view: ExtensionView; showHeader?: boolean }) {
  const webviewPanels = useAppSelector((s) => s.extensionUI.webviewPanels);

  const webview = webviewPanels.find(
    (p) => p.viewType === view.id || p.id.startsWith(`webview-${view.id}`)
  );

  return (
    <div className="extension-view" style={{ height: '100%' }}>
      {showHeader && view.actions && view.actions.length > 0 && (
        <div className="extension-view__header">
          <span className="extension-view__title">{view.name}</span>
          <div className="extension-view__actions">
            <ExtensionViewActions actions={view.actions} />
          </div>
        </div>
      )}
      <div
        className="extension-view__content"
        style={{ borderTop: showHeader && view.actions && view.actions.length > 0 ? undefined : 'none' }}
      >
        {webview ? (
          <WebViewPanel html={webview.html} panelId={webview.id} extensionPath={webview.extensionPath} />
        ) : (
          <div className="panel-placeholder">{view.name}</div>
        )}
      </div>
    </div>
  );
}

export function DockableContent({ item, showViewHeader = true }: DockableContentProps) {
  const { t } = useTranslation();
  const views = useAppSelector((s) => s.extensionUI.views);

  switch (item.type) {
    case 'explorer':
      return <ExplorerContent />;
    case 'search':
      return <SearchPanel />;
    case 'extensions':
      return <ExtensionsPanel />;
    case 'debug':
      return (
        <div className="panel-placeholder">
          {t('sidePanel.runAndDebug')}
        </div>
      );
    case 'viewContainer': {
      const containerViews = views.filter((v) => v.containerId === item.sourceContainerId);
      if (containerViews.length === 0) {
        return <div className="panel-placeholder">{t(item.title) || item.title}</div>;
      }
      // Git 扩展的特殊处理：直接渲染其 WebView
      if (item.sourceContainerId === 'workbench.scm') {
        return <GitExtensionView />;
      }
      return (
        <div className="extension-views" style={{ height: '100%' }}>
          {containerViews.map((view) => (
            <ExtensionViewContent key={view.id} view={view} showHeader={showViewHeader} />
          ))}
        </div>
      );
    }
    case 'terminal':
    case 'output':
    case 'problems':
    case 'debug-console':
    case 'ports':
      return (
        <div className="panel-placeholder">
          {t(item.title) || item.title}
        </div>
      );
    case 'custom':
    default:
      return (
        <div className="panel-placeholder">
          {t(item.title) || item.title}
        </div>
      );
  }
}
