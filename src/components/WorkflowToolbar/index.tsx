import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, FileDown, FileUp, Save } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { loadDirectory, refreshDirectory } from '../../store/slices/workspaceSlice';
import { isElectron, writeFile } from '../../services/fileService';
import {
  getWorkflowInstance,
  getWorkflowRuntime,
  getWorkflowSavedFilePath,
  setWorkflowSavedFilePath,
  subscribeWorkflowRuntime,
} from '../../services/workflowRuntime';
import {
  loadGraphFromData,
  parseWorkflowFile,
  serializeGraph,
} from '../../services/workflowPersistence';
import './WorkflowToolbar.css';

const JSON_FILTERS = [{ name: 'JSON', extensions: ['json'] }];

/** 从文件完整路径取所在目录与目录名（兼容 Windows / POSIX 分隔符） */
function splitDir(filePath: string): { dir: string; name: string } {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const dir = idx > 0 ? filePath.slice(0, idx) : filePath;
  const name = dir.split(/[\\/]/).pop() || dir;
  return { dir, name };
}

/** 取路径中的文件名部分 */
function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

/**
 * 工作流画布顶部工具条
 *
 * 顶部居中的下拉箭头按钮，点击后向下展开一条横向工具面板（CSS 过渡动画）：
 * - 保存到资源管理器：已加载项目时写入项目根目录——首次保存弹命名对话框，
 *   之后同一画布再次保存直接覆盖已关联的文件；未加载项目时弹保存对话框，
 *   保存后自动把所在目录加载进资源管理器。
 * - 导出：把画布 JSON 写到本地任意位置。
 * - 导入：读取之前导出的 JSON，重建画布内容。
 */
const WorkflowToolbar = ({ tabId }: { tabId: string }) => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const [open, setOpen] = useState(false);
  /** 已加载项目时的命名对话框（保存到项目根目录） */
  const [saveDialog, setSaveDialog] = useState<{ value: string } | null>(null);
  /** 操作成功后的轻量提示（自动消失） */
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootSource = useAppSelector((state) => state.workspace.rootSource);
  const tabName = useAppSelector(
    (state) => state.workspace.openedFiles.find((f) => f.id === tabId)?.name
  );
  const runtime = useSyncExternalStore(subscribeWorkflowRuntime, getWorkflowRuntime);
  // 优先用当前挂载的运行时；未挂载时（理论上本组件随画布一起挂载）退回实例注册表
  const graph = runtime?.scope === tabId ? runtime.graph : getWorkflowInstance(tabId)?.graph;

  const defaultName = tabName || t('activityBar.workflow');
  const fileName = `${defaultName}.workflow.json`;

  /** 显示一条 2 秒后自动消失的提示 */
  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = setTimeout(() => setToast(null), 2000);
  }, []);

  // 卸载时清理定时器
  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  /** 写入指定文件路径并刷新资源管理器 */
  const saveToPath = useCallback(
    async (filePath: string) => {
      if (!graph || !rootSource) return;
      const json = JSON.stringify(serializeGraph(graph), null, 2);
      try {
        // fileService.writeFile 兼容本地路径与远程 URI
        await writeFile(filePath, json);
        // 通知资源管理器精准刷新（根目录未默认 watch）
        dispatch(refreshDirectory(rootSource));
        showToast(t('workflow.savedTo', { name: baseName(filePath) }));
      } catch (err) {
        console.error('保存工作流失败:', err);
        window.alert(t('workflow.saveFailed'));
      }
    },
    [graph, rootSource, dispatch, showToast, t]
  );

  /** 保存到资源管理器 */
  const handleSaveToExplorer = useCallback(async () => {
    if (!graph || !isElectron()) return;
    if (rootSource) {
      // 已保存过且关联文件在当前项目内：同一份数据直接覆盖，不再弹命名框
      const rootStr = String(rootSource);
      const savedPath = getWorkflowSavedFilePath(tabId);
      if (savedPath && savedPath.startsWith(`${rootStr}/`)) {
        await saveToPath(savedPath);
        return;
      }
      // 已加载项目但未保存过：弹命名对话框，确认后写入项目根目录
      setSaveDialog({ value: defaultName });
      return;
    }
    const json = JSON.stringify(serializeGraph(graph), null, 2);
    try {
      // 未加载项目：弹出保存位置对话框，保存后把所在目录加载进资源管理器
      const filePath = await window.electronAPI!.dialog.saveFile({
        defaultPath: fileName,
        filters: JSON_FILTERS,
      });
      if (!filePath) return;
      await window.electronAPI!.fs.writeFile(filePath, json);
      setWorkflowSavedFilePath(tabId, filePath);
      const { dir, name } = splitDir(filePath);
      // preserveSession：只加载目录到资源管理器，不重置编辑会话，
      // 工作流 tab 保持打开，避免整屏抖动
      await dispatch(loadDirectory({ source: dir, name, preserveSession: true }));
      showToast(t('workflow.savedTo', { name: baseName(filePath) }));
    } catch (err) {
      console.error('保存工作流失败:', err);
      window.alert(t('workflow.saveFailed'));
    }
  }, [graph, rootSource, tabId, defaultName, fileName, saveToPath, showToast, dispatch, t]);

  /** 命名对话框确认：补齐 .workflow.json 后缀后写入根目录，并记录关联路径 */
  const handleConfirmSaveDialog = useCallback(async () => {
    if (!saveDialog || !rootSource) return;
    // 去掉路径分隔符，防止写出根目录
    const base = saveDialog.value.trim().replace(/[\\/]/g, '');
    if (!base) return;
    setSaveDialog(null);
    const filePath = `${String(rootSource)}/${base.endsWith('.json') ? base : `${base}.workflow.json`}`;
    await saveToPath(filePath);
    setWorkflowSavedFilePath(tabId, filePath);
  }, [saveDialog, rootSource, tabId, saveToPath]);

  /** 导出 JSON 到本地任意位置 */
  const handleExport = useCallback(async () => {
    if (!graph || !isElectron()) return;
    const json = JSON.stringify(serializeGraph(graph), null, 2);
    try {
      const filePath = await window.electronAPI!.dialog.saveFile({
        defaultPath: fileName,
        filters: JSON_FILTERS,
      });
      if (!filePath) return;
      await window.electronAPI!.fs.writeFile(filePath, json);
      showToast(t('workflow.exportedTo', { name: baseName(filePath) }));
    } catch (err) {
      console.error('导出工作流失败:', err);
      window.alert(t('workflow.saveFailed'));
    }
  }, [graph, fileName, showToast, t]);

  /** 导入之前导出的 JSON 到画布 */
  const handleImport = useCallback(async () => {
    if (!graph || !isElectron()) return;
    try {
      const filePath = await window.electronAPI!.dialog.openFile({ filters: JSON_FILTERS });
      if (!filePath) return;
      const json = await window.electronAPI!.fs.readFile(filePath);
      const data = parseWorkflowFile(json);
      if (!data) {
        window.alert(t('workflow.importInvalid'));
        return;
      }
      loadGraphFromData(graph, data, tabId);
      showToast(t('workflow.imported'));
    } catch (err) {
      console.error('导入工作流失败:', err);
      window.alert(t('workflow.importInvalid'));
    }
  }, [graph, tabId, showToast, t]);

  return (
    <div className="workflow-toolbar">
      <button
        type="button"
        className={`workflow-toolbar__toggle ${open ? 'open' : ''}`}
        title={t('workflow.toolbar')}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronDown size={13} strokeWidth={1.5} />
      </button>
      <div className={`workflow-toolbar__panel ${open ? 'open' : ''}`}>
        <button type="button" className="workflow-toolbar__action" onClick={handleSaveToExplorer}>
          <Save size={13} strokeWidth={1.5} />
          <span>{t('workflow.saveToExplorer')}</span>
        </button>
        <button type="button" className="workflow-toolbar__action" onClick={handleExport}>
          <FileDown size={13} strokeWidth={1.5} />
          <span>{t('workflow.exportJson')}</span>
        </button>
        <button type="button" className="workflow-toolbar__action" onClick={handleImport}>
          <FileUp size={13} strokeWidth={1.5} />
          <span>{t('workflow.importJson')}</span>
        </button>
      </div>
      {toast && <div className="workflow-toolbar__toast">{toast}</div>}
      {saveDialog && (
        <div className="workflow-save-dialog__overlay" onClick={() => setSaveDialog(null)}>
          <div className="workflow-save-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="workflow-save-dialog__title">{t('workflow.saveToExplorer')}</div>
            <input
              className="workflow-save-dialog__input"
              autoFocus
              value={saveDialog.value}
              placeholder={t('workflow.saveNamePlaceholder')}
              onChange={(e) => setSaveDialog({ value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleConfirmSaveDialog();
                if (e.key === 'Escape') setSaveDialog(null);
              }}
            />
            <div className="workflow-save-dialog__actions">
              <button
                type="button"
                className="workflow-save-dialog__btn workflow-save-dialog__btn--primary"
                disabled={!saveDialog.value.trim()}
                onClick={handleConfirmSaveDialog}
              >
                {t('confirm')}
              </button>
              <button
                type="button"
                className="workflow-save-dialog__btn"
                onClick={() => setSaveDialog(null)}
              >
                {t('cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default WorkflowToolbar;
