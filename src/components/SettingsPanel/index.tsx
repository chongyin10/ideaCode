import { useState, useMemo } from 'react';
import { X, Search, ChevronRight } from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import {
  setTheme,
  setFontSize,
  setSemanticHighlightingEnabled,
  setWordWrap,
  setMinimapEnabled,
  resetSettings,
  type EditorTheme,
  type WordWrapOption,
} from '../../store/slices/settingsSlice';
import { closeSettings } from '../../store/slices/workspaceSlice';
import './SettingsPanel.css';

type Category = { id: string; label: string };

const categories: Category[] = [
  { id: 'commonlyUsed', label: '常用设置' },
  { id: 'editor', label: '文本编辑器' },
  { id: 'appearance', label: '外观' },
];

const themeOptions: { value: EditorTheme; label: string }[] = [
  { value: 'vs', label: '浅色 (Light)' },
  { value: 'vs-dark', label: '深色 (Dark)' },
  { value: 'hc-black', label: '高对比度 (High Contrast)' },
];

const wordWrapOptions: { value: WordWrapOption; label: string }[] = [
  { value: 'on', label: '开启' },
  { value: 'off', label: '关闭' },
  { value: 'bounded', label: '视区宽度' },
];

interface SettingItemData {
  id: string;
  category: 'commonlyUsed' | 'editor' | 'appearance';
  label: string;
  desc: string;
  keywords: string;
  render: () => React.ReactNode;
}

const SettingsPanel = () => {
  const dispatch = useAppDispatch();
  const settings = useAppSelector((state) => state.settings);
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('commonlyUsed');

  const settingItems: SettingItemData[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all: SettingItemData[] = [
      {
        id: 'theme',
        category: 'appearance',
        label: '颜色主题',
        desc: '选择编辑器的语法高亮主题',
        keywords: 'theme color 主题 颜色 浅色 深色',
        render: () => (
          <select
            className="setting-item__control"
            value={settings.theme}
            onChange={(e) => dispatch(setTheme(e.target.value as EditorTheme))}
          >
            {themeOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        ),
      },
      {
        id: 'fontSize',
        category: 'editor',
        label: '字体大小',
        desc: '编辑器中的字体大小（像素）',
        keywords: 'font size 字体 大小',
        render: () => (
          <input
            type="number"
            className="setting-item__control setting-item__control--number"
            min={8}
            max={32}
            value={settings.fontSize}
            onChange={(e) => dispatch(setFontSize(Number(e.target.value)))}
          />
        ),
      },
      {
        id: 'wordWrap',
        category: 'editor',
        label: '自动换行',
        desc: '超出视区时是否自动换行',
        keywords: 'word wrap 自动换行',
        render: () => (
          <select
            className="setting-item__control"
            value={settings.wordWrap}
            onChange={(e) => dispatch(setWordWrap(e.target.value as WordWrapOption))}
          >
            {wordWrapOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        ),
      },
      {
        id: 'semanticHighlighting',
        category: 'commonlyUsed',
        label: '语义高亮',
        desc: '根据语言服务提供的语义信息为符号着色（方法、变量、类型等）',
        keywords: 'semantic highlighting 语义 高亮 颜色',
        render: () => (
          <label className="setting-item__toggle">
            <input
              type="checkbox"
              checked={settings.semanticHighlightingEnabled}
              onChange={(e) => dispatch(setSemanticHighlightingEnabled(e.target.checked))}
            />
            <span className="setting-item__toggle-slider" />
          </label>
        ),
      },
      {
        id: 'minimap',
        category: 'appearance',
        label: 'Minimap',
        desc: '在编辑器右侧显示代码缩略图',
        keywords: 'minimap 缩略图 小地图',
        render: () => (
          <label className="setting-item__toggle">
            <input
              type="checkbox"
              checked={settings.minimapEnabled}
              onChange={(e) => dispatch(setMinimapEnabled(e.target.checked))}
            />
            <span className="setting-item__toggle-slider" />
          </label>
        ),
      },
    ];

    if (!q) {
      return all.filter((item) => item.category === activeCategory);
    }
    return all.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        item.desc.toLowerCase().includes(q) ||
        item.keywords.toLowerCase().includes(q)
    );
  }, [activeCategory, query, settings, dispatch]);

  const handleClose = () => dispatch(closeSettings());

  return (
    <div className="settings-panel">
      {/* 标题栏 */}
      <div className="settings-panel__header">
        <h2 className="settings-panel__title">设置</h2>
        <button className="settings-panel__close" onClick={handleClose} aria-label="关闭设置">
          <X size={16} strokeWidth={1.5} />
        </button>
      </div>

      {/* 搜索栏 */}
      <div className="settings-panel__search">
        <Search size={14} strokeWidth={1.5} />
        <input
          type="text"
          placeholder="搜索设置"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button className="settings-panel__search-clear" onClick={() => setQuery('')}>
            清除
          </button>
        )}
      </div>

      <div className="settings-panel__body">
        {/* 左侧分类 */}
        <div className="settings-panel__sidebar">
          {categories.map((cat) => (
            <div
              key={cat.id}
              className={`settings-panel__category ${activeCategory === cat.id && !query ? 'active' : ''}`}
              onClick={() => {
                setActiveCategory(cat.id);
                setQuery('');
              }}
            >
              <ChevronRight size={14} strokeWidth={1.5} />
              <span>{cat.label}</span>
            </div>
          ))}
        </div>

        {/* 右侧设置项 */}
        <div className="settings-panel__content">
          <div className="settings-section">
            <h3 className="settings-section__title">
              {query ? '搜索结果' : categories.find((c) => c.id === activeCategory)?.label}
            </h3>
            <p className="settings-section__desc">
              {query
                ? `找到 ${settingItems.length} 个匹配设置`
                : '控制 Monaco 编辑器的外观和行为'}
            </p>

            {settingItems.length === 0 ? (
              <div className="settings-panel__empty">未找到匹配设置</div>
            ) : (
              settingItems.map((item) => (
                <div key={item.id} className="setting-item">
                  <div className="setting-item__info">
                    <label className="setting-item__label">{item.label}</label>
                    <span className="setting-item__desc">{item.desc}</span>
                  </div>
                  {item.render()}
                </div>
              ))
            )}
          </div>

          <div className="settings-panel__actions">
            <button className="settings-panel__reset" onClick={() => dispatch(resetSettings())}>
              恢复默认设置
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsPanel;
