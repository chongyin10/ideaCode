import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Puzzle } from 'lucide-react';
import { getPluginManager } from '../../plugin';
import type { PluginState } from '../../plugin';
import './ExtensionsPanel.css';

/**
 * 扩展面板
 *
 * 展示已安装/已注册的插件列表，支持查看状态、激活/停用。
 */
const ExtensionsPanel = () => {
  const { t } = useTranslation();
  const [plugins, setPlugins] = useState<PluginState[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 刷新插件列表
  const refresh = () => {
    const manager = getPluginManager();
    if (manager) {
      setPlugins(manager.getAllPlugins());
    }
  };

  useEffect(() => {
    refresh();
    const manager = getPluginManager();
    if (manager) {
      return manager.onChange(refresh);
    }
  }, []);

  const filteredPlugins = useMemo(() => {
    if (!searchQuery) return plugins;
    const q = searchQuery.toLowerCase();
    return plugins.filter(
      (p) =>
        p.manifest.name.toLowerCase().includes(q) ||
        p.manifest.id.toLowerCase().includes(q)
    );
  }, [plugins, searchQuery]);

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
        <div className="extensions-actions">
          <button onClick={refresh}>{t('extensionsPanel.refresh')}</button>
          <button
            onClick={() => {
              // 触发示例命令
              const manager = getPluginManager();
              if (manager) {
                try {
                  manager.getCommandManager().executeCommand('hello-world.sayHello');
                } catch (err) {
                  console.error(err);
                }
              }
            }}
          >
            {t('extensionsPanel.testCommand')}
          </button>
        </div>
      </div>

      <div className="extensions-list">
        {filteredPlugins.length === 0 ? (
          <div className="extensions-empty">
            {searchQuery ? t('extensionsPanel.noMatching') : t('extensionsPanel.noInstalled')}
          </div>
        ) : (
          filteredPlugins.map((plugin) => (
            <div
              key={plugin.id}
              className={`extension-item ${selectedId === plugin.id ? 'active' : ''}`}
              onClick={() => setSelectedId(plugin.id)}
            >
              <div className="extension-item__header">
                <div className="extension-item__icon">
                  <Puzzle size={16} strokeWidth={1.5} />
                </div>
                <div className="extension-item__info">
                  <div className="extension-item__name">
                    {plugin.manifest.name}
                  </div>
                  <div className="extension-item__meta">
                    v{plugin.manifest.version} · {plugin.manifest.author || t('extensionsPanel.unknownAuthor')}
                  </div>
                </div>
                <span
                  className={`extension-item__status ${
                    plugin.error
                      ? 'extension-item__status--error'
                      : plugin.isActive
                      ? 'extension-item__status--active'
                      : 'extension-item__status--inactive'
                  }`}
                >
                  {plugin.error ? t('extensionsPanel.statusError') : plugin.isActive ? t('extensionsPanel.statusActive') : t('extensionsPanel.statusInactive')}
                </span>
              </div>
              {plugin.manifest.description && (
                <div className="extension-item__description">
                  {plugin.manifest.description}
                </div>
              )}
              {plugin.error && (
                <div
                  className="extension-item__description"
                  style={{ color: '#f44747' }}
                >
                  {plugin.error}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default ExtensionsPanel;
