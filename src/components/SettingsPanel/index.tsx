import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
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
import { SUPPORTED_LANGUAGES, saveLanguage, type LanguageCode } from '../../i18n';
import i18n from '../../i18n';
import './SettingsPanel.css';

const SettingsPanel = () => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const settings = useAppSelector((state) => state.settings);
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('commonlyUsed');

  const categories = useMemo(
    () => [
      { id: 'commonlyUsed', label: t('settingsPanel.categories.commonlyUsed') },
      { id: 'editor', label: t('settingsPanel.categories.editor') },
      { id: 'appearance', label: t('settingsPanel.categories.appearance') },
    ],
    [t]
  );

  const themeOptions: { value: EditorTheme; label: string }[] = useMemo(
    () => [
      { value: 'vs', label: t('settingsPanel.theme.light') },
      { value: 'vs-dark', label: t('settingsPanel.theme.dark') },
      { value: 'hc-black', label: t('settingsPanel.theme.hc') },
    ],
    [t]
  );

  const wordWrapOptions: { value: WordWrapOption; label: string }[] = useMemo(
    () => [
      { value: 'on', label: t('settingsPanel.wordWrap.on') },
      { value: 'off', label: t('settingsPanel.wordWrap.off') },
      { value: 'bounded', label: t('settingsPanel.wordWrap.bounded') },
    ],
    [t]
  );

  interface SettingItemData {
    id: string;
    category: 'commonlyUsed' | 'editor' | 'appearance';
    label: string;
    desc: string;
    keywords: string;
    render: () => React.ReactNode;
  }

  const settingItems: SettingItemData[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all: SettingItemData[] = [
      {
        id: 'displayLanguage',
        category: 'commonlyUsed',
        label: t('settingsPanel.displayLanguage.label'),
        desc: t('settingsPanel.displayLanguage.desc'),
        keywords: 'language 语言 語言 display',
        render: () => (
          <select
            className="setting-item__control"
            value={i18n.language}
            onChange={(e) => {
              const lng = e.target.value as LanguageCode;
              i18n.changeLanguage(lng);
              saveLanguage(lng);
            }}
          >
            {SUPPORTED_LANGUAGES.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.name}
              </option>
            ))}
          </select>
        ),
      },
      {
        id: 'theme',
        category: 'appearance',
        label: t('settingsPanel.theme.label'),
        desc: t('settingsPanel.theme.desc'),
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
        label: t('settingsPanel.fontSize.label'),
        desc: t('settingsPanel.fontSize.desc'),
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
        label: t('settingsPanel.wordWrap.label'),
        desc: t('settingsPanel.wordWrap.desc'),
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
        label: t('settingsPanel.semanticHighlighting.label'),
        desc: t('settingsPanel.semanticHighlighting.desc'),
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
        label: t('settingsPanel.minimap.label'),
        desc: t('settingsPanel.minimap.desc'),
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
  }, [activeCategory, query, settings, dispatch, t, themeOptions, wordWrapOptions]);

  const handleClose = () => dispatch(closeSettings());

  return (
    <div className="settings-panel">
      {/* 标题栏 */}
      <div className="settings-panel__header">
        <h2 className="settings-panel__title">{t('settingsPanel.title')}</h2>
        <button className="settings-panel__close" onClick={handleClose} aria-label={t('close')}>
          <X size={16} strokeWidth={1.5} />
        </button>
      </div>

      {/* 搜索栏 */}
      <div className="settings-panel__search">
        <Search size={14} strokeWidth={1.5} />
        <input
          type="text"
          placeholder={t('settingsPanel.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button className="settings-panel__search-clear" onClick={() => setQuery('')}>
            {t('clear')}
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
              {query ? t('settingsPanel.searchResults') : categories.find((c) => c.id === activeCategory)?.label}
            </h3>
            <p className="settings-section__desc">
              {query
                ? t('settingsPanel.matchedSettings', { count: settingItems.length })
                : t('settingsPanel.sectionDesc')}
            </p>

            {settingItems.length === 0 ? (
              <div className="settings-panel__empty">{t('settingsPanel.noResults')}</div>
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
              {t('settingsPanel.reset')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsPanel;
