import { X } from 'lucide-react';
import './TabBar.css';

interface TabBarProps {
  tabs: { id: string; name: string; isDirty?: boolean }[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}

const TabBar = ({ tabs, activeId, onActivate, onClose }: TabBarProps) => {
  if (tabs.length === 0) return null;

  return (
    <div className="tab-bar">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`tab-bar__item ${activeId === tab.id ? 'active' : ''}`}
          onClick={() => onActivate(tab.id)}
        >
          <span className="tab-bar__name">
            {tab.name}
            {tab.isDirty && <span className="tab-bar__dirty">●</span>}
          </span>
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
  );
};

export default TabBar;
