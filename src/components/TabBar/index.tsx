import { X, Columns2 } from 'lucide-react';
import './TabBar.css';

interface TabBarProps {
  tabs: { id: string; name: string; isDirty?: boolean; isPreview?: boolean; gitStatus?: string }[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onPin?: (id: string) => void;
  onSplitView?: () => void;
  splitActive?: boolean;
  focused?: boolean;
}

const TabBar = ({ tabs, activeId, onActivate, onClose, onPin, onSplitView, splitActive, focused = true }: TabBarProps) => {
  if (tabs.length === 0) return null;

  return (
    <div className="tab-bar">
      <div className="tab-bar__tabs">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab-bar__item ${focused && activeId === tab.id ? 'active' : ''} ${tab.isPreview ? 'preview' : ''}`}
            onClick={() => onActivate(tab.id)}
            onDoubleClick={() => {
              if (tab.isPreview) {
                onPin?.(tab.id);
              }
            }}
          >
            <span className={`tab-bar__name ${tab.isDirty ? 'dirty' : ''} ${tab.gitStatus ? 'git-' + tab.gitStatus.toLowerCase() : ''}`}>{tab.name}</span>
            {tab.isDirty && <span className="tab-bar__dirty">●</span>}
            <span
              className="tab-bar__close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
            >
              <X size={14} strokeWidth={1.5} />
            </span>
          </div>
        ))}
      </div>
      {onSplitView && focused && (
        <div className={`tab-bar__actions ${splitActive ? 'split-active' : ''}`}>
          <button
            className="tab-bar__action-btn"
            onClick={onSplitView}
            title="分屏编辑"
          >
            <Columns2 size={14} strokeWidth={1.5} />
          </button>
        </div>
      )}
    </div>
  );
};

export default TabBar;
