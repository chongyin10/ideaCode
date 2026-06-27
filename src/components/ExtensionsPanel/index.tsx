import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Puzzle, RefreshCw } from 'lucide-react';
import { useAppDispatch } from '../../store/hooks';
import { openExtensionDetail } from '../../store/slices/workspaceSlice';
import type { ExtensionState } from '../../plugin/extensionBridge';
import './ExtensionsPanel.css';

function getBridge() {
  return (window as unknown as Record<string, unknown>).__extensionBridge as {
    getAllExtensions?: () => ExtensionState[];
    scanExtensions?: () => Promise<ExtensionState[]>;
    activateExtension?: (id: string) => Promise<boolean>;
    deactivateExtension?: (id: string) => Promise<boolean>;
  } | undefined;
}

interface SectionState {
  installed: boolean;
  discovered: boolean;
}

const ExtensionsPanel = () => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const [extensions, setExtensions] = useState<ExtensionState[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [expanded, setExpanded] = useState<SectionState>({ installed: true, discovered: true });
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge) return;
    setLoading(true);
    try {
      await bridge.scanExtensions?.();
      setExtensions(bridge.getAllExtensions?.() || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    // 定时刷新状态（扩展可能在后台被激活）。
    // 用签名浅比较：仅当扩展数量或激活状态变化时才 setState，
    // 避免每次轮询都生成新数组引用触发无谓重渲染。
    const timer = setInterval(() => {
      const bridge = getBridge();
      if (!bridge?.getAllExtensions) return;
      const next = bridge.getAllExtensions();
      setExtensions((prev) => {
        if (prev.length !== next.length) return next;
        // 比较每项的 name + activated 签名
        for (let i = 0; i < next.length; i++) {
          if (prev[i]?.manifest?.name !== next[i]?.manifest?.name) return next;
          if (prev[i]?.activated !== next[i]?.activated) return next;
        }
        return prev; // 签名相同，返回旧引用，不触发重渲染
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  const filtered = useMemo(() => {
    if (!searchQuery) return extensions;
    const q = searchQuery.toLowerCase();
    return extensions.filter(
      (ext) =>
        ext.manifest.name?.toLowerCase().includes(q) ||
        ext.manifest.displayName?.toLowerCase().includes(q) ||
        ext.manifest.description?.toLowerCase().includes(q)
    );
  }, [extensions, searchQuery]);

  const installed = filtered.filter((ext) => ext.activated);
  const discovered = filtered.filter((ext) => !ext.activated);

  const openDetail = (ext: ExtensionState) => {
    dispatch(
      openExtensionDetail({
        extId: ext.id,
        name: ext.manifest.displayName || ext.manifest.name,
        description: ext.manifest.description,
      })
    );
  };

  const toggleSection = (section: keyof SectionState) => {
    setExpanded((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  const renderSection = (
    title: string,
    sectionKey: keyof SectionState,
    list: ExtensionState[]
  ) => (
    <div className="extensions-section">
      <div className="extensions-section__header" onClick={() => toggleSection(sectionKey)}>
        <span className={`extensions-section__chevron ${expanded[sectionKey] ? 'expanded' : ''}`}>▶</span>
        <span className="extensions-section__title">{title}</span>
        <span className="extensions-section__count">{list.length}</span>
      </div>
      {expanded[sectionKey] && (
        <div className="extensions-section__list">
          {list.length === 0 ? (
            <div className="extensions-section__empty">
              {sectionKey === 'installed' ? '暂无已启用扩展' : '暂无未启用扩展'}
            </div>
          ) : (
            list.map((ext) => {
              const manifest = ext.manifest;
              const displayName = manifest.displayName || manifest.name;
              const publisher = manifest.publisher || manifest.author || t('extensionsPanel.unknownAuthor');
              return (
                <div
                  key={ext.id}
                  className="extension-item"
                  onClick={() => openDetail(ext)}
                >
                  <div className="extension-item__icon">
                    <Puzzle size={20} strokeWidth={1.5} />
                  </div>
                  <div className="extension-item__info">
                    <div className="extension-item__name-row">
                      <span className="extension-item__name" title={displayName}>
                        {displayName}
                      </span>
                      <span className={`extension-item__status ${ext.activated ? 'active' : 'inactive'}`}>
                        {ext.activated ? '已启用' : '未启用'}
                      </span>
                    </div>
                    <div className="extension-item__meta">
                      v{manifest.version} · {publisher}
                    </div>
                    {manifest.description && (
                      <div className="extension-item__description" title={manifest.description}>
                        {manifest.description}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="extensions-panel">
      <div className="extensions-panel__header">
        <div className="extensions-search">
          <Search size={12} strokeWidth={1.5} />
          <input
            type="text"
            placeholder={t('extensionsPanel.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <button className="extensions-refresh" onClick={refresh} disabled={loading}>
          <RefreshCw size={12} className={loading ? 'spin' : ''} />
          {t('extensionsPanel.refresh')}
        </button>
      </div>

      <div className="extensions-list">
        {extensions.length === 0 && !loading ? (
          <div className="extensions-empty">{t('extensionsPanel.noInstalled')}</div>
        ) : (
          <>
            {renderSection('已安装', 'installed', installed)}
            {renderSection('已发现', 'discovered', discovered)}
          </>
        )}
      </div>
    </div>
  );
};

export default ExtensionsPanel;
