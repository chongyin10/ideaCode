import { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { X, FileText, Search, ChevronRight, Hash, Files } from 'lucide-react';
import type { FileSearchResult, FindResult } from '../../services/searchService';
import { FileIcon } from '../SidePanel/FileTree.icons';
import './FileReferencesModal.css';

interface FileReferencesModalProps {
  results: FileSearchResult[];
  onClose: () => void;
  onOpenResult: (relativePath: string) => void;
}

/** 退出动画时长 (ms)，需与 CSS 中 frOverlayOut / frPanelOut 保持一致 */
const EXIT_DURATION = 220;

const FileReferencesModal = ({ results, onClose, onOpenResult }: FileReferencesModalProps) => {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 退出动画进行中：true 时给 DOM 添加 is-closing 类播放退场动画 */
  const [closing, setClosing] = useState(false);
  /**
   * closing 的 ref 镜像：供 requestClose 内部读取最新值，
   * 避免 closing 进入 useCallback 依赖导致函数重建、
   * 进而触发 effect cleanup 误清关闭定时器。
   */
  const closingRef = useRef(false);
  // onClose 的 ref：保持 requestClose 稳定，不随父组件渲染而重建
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // 统计汇总
  const stats = useMemo(() => {
    const fileCount = results.length;
    const totalMatches = results.reduce((sum, r) => sum + r.matchCount, 0);
    return { fileCount, totalMatches };
  }, [results]);

  /**
   * 触发关闭：先播放退出动画，动画结束后再真正 unmount。
   *
   * 关键：requestClose 不依赖 closing state（用 ref 读取），
   * 因此函数引用在组件生命周期内稳定不变，
   * 不会因 setClosing(true) 触发 effect cleanup 误清定时器。
   */
  const requestClose = useCallback(() => {
    if (closingRef.current) return; // 防止重复触发
    closingRef.current = true;
    setClosing(true);
    closeTimerRef.current = setTimeout(() => {
      onCloseRef.current();
    }, EXIT_DURATION);
  }, []); // ← 空依赖，函数永久稳定

  // Esc 键监听：依赖稳定的 requestClose，仅在 mount/unmount 时注册/注销
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, [requestClose]);

  const handleOpenResult = useCallback((relativePath: string) => {
    // 打开结果后也先播放关闭动画
    requestClose();
    // 立即通知父组件打开文件（不阻塞），关闭动画并行进行
    onOpenResult(relativePath);
  }, [requestClose, onOpenResult]);

  return (
    <div
      className={`file-refs-overlay ${closing ? 'is-closing' : ''}`}
      onClick={requestClose}
    >
      <div
        className={`file-refs-panel ${closing ? 'is-closing' : ''}`}
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── 头部 ── */}
        <div className="file-refs-header">
          <div className="file-refs-header__left">
            <span className="file-refs-header__icon">
              <Search size={16} strokeWidth={2} />
            </span>
            <span className="file-refs-title">
              {t('tabBar.referencesModal.title')}
            </span>
            {/* 统计徽章 */}
            <div className="file-refs-badges">
              <span className="file-refs-badge file-refs-badge--files" title={t('tabBar.referencesModal.files')}>
                <Files size={11} strokeWidth={2} />
                {stats.fileCount}
              </span>
              <span className="file-refs-badge file-refs-badge--matches" title={t('tabBar.referencesModal.matches')}>
                <Hash size={11} strokeWidth={2} />
                {stats.totalMatches}
              </span>
            </div>
          </div>
          <button className="file-refs-close" onClick={requestClose} title={t('close')}>
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>

        {/* ── 结果列表 ── */}
        <div className="file-refs-list" ref={listRef}>
          {results.length === 0 ? (
            <div className="file-refs-empty">
              <div className="file-refs-empty__icon">
                <Search size={32} strokeWidth={1.2} />
              </div>
              <p className="file-refs-empty__text">
                {t('tabBar.referencesModal.noResults')}
              </p>
            </div>
          ) : (
            results.map((result, fileIdx) => (
              <div
                key={result.filePath}
                className="file-refs-card"
                style={{ animationDelay: `${Math.min(fileIdx * 35, 280)}ms` }}
                onClick={() => handleOpenResult(result.filePath)}
              >
                {/* 文件行 */}
                <div className="file-refs-card__header">
                  <span className="file-refs-card__icon">
                    <FileIcon name={result.fileName} kind="file" />
                  </span>
                  <span className="file-refs-card__name">{result.fileName}</span>
                  <span className="file-refs-card__sep">·</span>
                  <span className="file-refs-card__path" title={result.filePath}>
                    {result.filePath}
                  </span>
                  <span className="file-refs-card__count" title={`${result.matchCount} matches`}>
                    {result.matchCount}
                  </span>
                  <ChevronRight size={14} className="file-refs-card__arrow" strokeWidth={1.5} />
                </div>

                {/* 匹配预览 */}
                {result.matches.length > 0 && (
                  <div className="file-refs-card__matches">
                    {result.matches.slice(0, 3).map((match, idx) => (
                      <MatchLine
                        key={`${match.line}-${idx}`}
                        match={match}
                        rank={fileIdx + 1}
                      />
                    ))}
                    {result.matches.length > 3 && (
                      <div className="file-refs-card__more">
                        +{result.matches.length - 3} {t('tabBar.referencesModal.moreMatches')}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* ── 底部状态栏 ── */}
        {results.length > 0 && (
          <div className="file-refs-footer">
            <span className="file-refs-footer__text">
              {t('tabBar.referencesModal.footer', {
                files: stats.fileCount,
                matches: stats.totalMatches,
              })}
            </span>
            <span className="file-refs-footer__hint">
              <kbd>Esc</kbd> {t('tabBar.referencesModal.close')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

const MatchLine = ({ match }: { match: FindResult; rank?: number }) => {
  return (
    <div className="file-refs-match">
      <span className="file-refs-match__line">{match.line}</span>
      <span className="file-refs-match__icon">
        <FileText size={11} strokeWidth={1.5} />
      </span>
      <span className="file-refs-match__text" title={match.text}>
        {match.text}
      </span>
    </div>
  );
};

export default FileReferencesModal;
