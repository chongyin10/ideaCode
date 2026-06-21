import { useState, useEffect, useCallback } from 'react';
import { Puzzle, Loader2, AlertCircle, Play, Square, RefreshCw, Trash2 } from 'lucide-react';
import type { ExtensionState } from '../../plugin/extensionBridge';
import './ExtensionDetail.css';

type DetailTab = 'details' | 'features' | 'changelog' | 'dependencies';

interface ExtensionDetailProps {
  extensionId: string;
}

function getBridge() {
  return (window as unknown as Record<string, unknown>).__extensionBridge as {
    getExtension?: (id: string) => ExtensionState | undefined;
    scanExtensions?: () => Promise<ExtensionState[]>;
    enableExtension?: (id: string) => Promise<{ success: boolean; error?: string }>;
    disableExtension?: (id: string) => Promise<{ success: boolean; error?: string }>;
    uninstallExtension?: (id: string) => Promise<{ success: boolean; error?: string }>;
  } | undefined;
}

function ExtensionDetail({ extensionId }: ExtensionDetailProps) {
  const [ext, setExt] = useState<ExtensionState | undefined>(getBridge()?.getExtension?.(extensionId));
  const [activeTab, setActiveTab] = useState<DetailTab>('details');
  const [installLog, setInstallLog] = useState<string>('');
  const [readme, setReadme] = useState<string>('');
  const [changelog, setChangelog] = useState<string>('');
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [actionLoading, setActionLoading] = useState<'enable' | 'disable' | 'uninstall' | null>(null);

  const refresh = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge) return;
    await bridge.scanExtensions?.();
    setExt(bridge.getExtension?.(extensionId));
  }, [extensionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 读取 README / CHANGELOG
  useEffect(() => {
    if (!ext?.path) return;
    let cancelled = false;

    const readText = async (fileName: string) => {
      try {
        const result = await window.electronAPI?.fs?.readFile(`${ext.path}/${fileName}`);
        return typeof result === 'string' ? result : '';
      } catch {
        return '';
      }
    };

    (async () => {
      const [r, c] = await Promise.all([readText('README.md'), readText('CHANGELOG.md')]);
      if (cancelled) return;
      setReadme(r);
      setChangelog(c);
    })();

    return () => { cancelled = true; };
  }, [ext?.path]);

  const manifest = ext?.manifest;
  const displayName = manifest?.displayName || manifest?.name || extensionId;
  const publisher = manifest?.publisher || manifest?.author || 'Unknown';
  const version = manifest?.version || '0.0.0';
  const description = manifest?.description || '';

  const handleEnable = async () => {
    const bridge = getBridge();
    if (!bridge?.enableExtension) return;
    setActionLoading('enable');
    setInstallLog('开始启用扩展...\n');
    try {
      const result = await bridge.enableExtension(extensionId);
      if (result.success) {
        setInstallLog('扩展已启用\n');
      } else {
        setInstallLog(`启用失败: ${result.error || '未知错误'}\n`);
      }
    } catch (err) {
      setInstallLog(`启用失败: ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      await refresh();
      setActionLoading(null);
    }
  };

  const handleDisable = async () => {
    const bridge = getBridge();
    if (!bridge?.disableExtension) return;
    setActionLoading('disable');
    setInstallLog('正在禁用扩展...\n');
    try {
      const result = await bridge.disableExtension(extensionId);
      if (result.success) {
        setInstallLog('扩展已禁用，依赖已删除\n');
      } else {
        setInstallLog(`禁用失败: ${result.error || '未知错误'}\n`);
      }
    } catch (err) {
      setInstallLog(`禁用失败: ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      await refresh();
      setActionLoading(null);
    }
  };

  const handleUninstall = async () => {
    const bridge = getBridge();
    if (!bridge?.uninstallExtension) return;
    setActionLoading('uninstall');
    try {
      const result = await bridge.uninstallExtension(extensionId);
      if (result.success) {
        setInstallLog('扩展已卸载\n');
      } else {
        setInstallLog(`卸载失败: ${result.error || '未知错误'}\n`);
      }
    } catch (err) {
      setInstallLog(`卸载失败: ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      await refresh();
      setActionLoading(null);
    }
  };

  const commands = manifest?.contributes?.commands || [];
  const viewsContainers = manifest?.contributes?.viewsContainers || {};
  const views = manifest?.contributes?.views || {};
  const dependencies = manifest?.dependencies || {};
  const devDependencies = manifest?.devDependencies || {};

  if (!ext) {
    return (
      <div className="extension-detail">
        <div className="extension-detail__empty">
          <AlertCircle size={24} />
          <p>扩展未找到: {extensionId}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="extension-detail">
      <div className="extension-detail__header">
        <div className="extension-detail__icon">
          <Puzzle size={48} strokeWidth={1.2} />
        </div>
        <div className="extension-detail__info">
          <h1 className="extension-detail__name">{displayName}</h1>
          <div className="extension-detail__meta">
            <span className="extension-detail__publisher">{publisher}</span>
            <span className="extension-detail__version">v{version}</span>
            <span className={`extension-detail__status ${ext.activated ? 'active' : 'inactive'}`}>
              {ext.activated ? '已激活' : '未启用'}
            </span>
          </div>
          <p className="extension-detail__description">{description}</p>
          <div className="extension-detail__actions">
            {ext.activated ? (
              <>
                <button
                  className="extension-detail__btn extension-detail__btn--secondary"
                  onClick={handleDisable}
                  disabled={actionLoading === 'disable'}
                >
                  {actionLoading === 'disable' ? <Loader2 size={14} className="spin" /> : <Square size={14} />}
                  禁用
                </button>
                <button
                  className="extension-detail__btn extension-detail__btn--danger"
                  onClick={handleUninstall}
                  disabled={actionLoading === 'uninstall'}
                >
                  {actionLoading === 'uninstall' ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
                  卸载
                </button>
                <label className="extension-detail__btn extension-detail__btn--secondary extension-detail__auto-update">
                  <input
                    type="checkbox"
                    checked={autoUpdate}
                    onChange={(e) => setAutoUpdate(e.target.checked)}
                  />
                  <span>自动更新</span>
                </label>
              </>
            ) : (
              <>
                <button
                  className="extension-detail__btn extension-detail__btn--primary"
                  onClick={handleEnable}
                  disabled={actionLoading === 'enable'}
                >
                  {actionLoading === 'enable' ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
                  启用
                </button>
                <button
                  className="extension-detail__btn extension-detail__btn--danger"
                  onClick={handleUninstall}
                  disabled={actionLoading === 'uninstall'}
                >
                  {actionLoading === 'uninstall' ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
                  卸载
                </button>
                <button className="extension-detail__btn extension-detail__btn--secondary" onClick={refresh}>
                  <RefreshCw size={14} />
                  刷新
                </button>
              </>
            )}
          </div>
          {installLog && (
            <pre className="extension-detail__log">{installLog}</pre>
          )}
        </div>
      </div>

      <div className="extension-detail__tabs">
        {[
          { key: 'details', label: '细节' },
          { key: 'features', label: '功能' },
          { key: 'changelog', label: '更改日志' },
          { key: 'dependencies', label: '依赖项' },
        ].map((tab) => (
          <button
            key={tab.key}
            className={`extension-detail__tab ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.key as DetailTab)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="extension-detail__content">
        {activeTab === 'details' && (
          <div className="extension-detail__section">
            {readme ? (
              <pre className="extension-detail__readme">{readme}</pre>
            ) : (
              <div className="extension-detail__empty-text">
                <p>{description || '暂无详细说明'}</p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'features' && (
          <div className="extension-detail__section">
            {commands.length > 0 && (
              <div className="extension-detail__feature-group">
                <h3>命令</h3>
                <ul>
                  {commands.map((cmd) => (
                    <li key={cmd.command}>
                      <code>{cmd.command}</code>
                      <span>{cmd.title}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {Object.keys(viewsContainers).length > 0 && (
              <div className="extension-detail__feature-group">
                <h3>视图容器</h3>
                {Object.entries(viewsContainers).map(([location, containers]) => (
                  <div key={location}>
                    <strong>{location}</strong>
                    <ul>
                      {containers.map((container) => (
                        <li key={container.id}>{container.title}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
            {Object.keys(views).length > 0 && (
              <div className="extension-detail__feature-group">
                <h3>视图</h3>
                {Object.entries(views).map(([containerId, viewList]) => (
                  <div key={containerId}>
                    <strong>{containerId}</strong>
                    <ul>
                      {viewList.map((view) => (
                        <li key={view.id}>{view.name}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
            {commands.length === 0 && Object.keys(viewsContainers).length === 0 && Object.keys(views).length === 0 && (
              <p className="extension-detail__empty-text">未声明功能贡献</p>
            )}
          </div>
        )}

        {activeTab === 'changelog' && (
          <div className="extension-detail__section">
            {changelog ? (
              <pre className="extension-detail__changelog">{changelog}</pre>
            ) : (
              <p className="extension-detail__empty-text">暂无更改日志</p>
            )}
          </div>
        )}

        {activeTab === 'dependencies' && (
          <div className="extension-detail__section">
            {Object.keys(dependencies).length > 0 && (
              <div className="extension-detail__feature-group">
                <h3>运行时依赖</h3>
                <ul>
                  {Object.entries(dependencies).map(([name, version]) => (
                    <li key={name}>
                      <code>{name}</code>
                      <span>{version as string}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {Object.keys(devDependencies).length > 0 && (
              <div className="extension-detail__feature-group">
                <h3>开发依赖</h3>
                <ul>
                  {Object.entries(devDependencies).map(([name, version]) => (
                    <li key={name}>
                      <code>{name}</code>
                      <span>{version as string}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {Object.keys(dependencies).length === 0 && Object.keys(devDependencies).length === 0 && (
              <p className="extension-detail__empty-text">无额外依赖</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default ExtensionDetail;
