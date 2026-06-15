import { Files, Search, GitBranch, Bug, Blocks, User, Settings } from 'lucide-react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import { switchPanel } from '../../store/slices/layoutSlice';
import type { PanelId } from '../../store/slices/layoutSlice';
import { setSettingsVisible } from '../../store/slices/workspaceSlice';
import './ActivityBar.css';

const panels: { id: PanelId; icon: React.ReactNode; title: string }[] = [
  { id: 'explorer', icon: <Files size={20} strokeWidth={1.5} />, title: '资源管理器' },
  { id: 'search', icon: <Search size={20} strokeWidth={1.5} />, title: '搜索' },
  { id: 'git', icon: <GitBranch size={20} strokeWidth={1.5} />, title: '源代码管理' },
  { id: 'debug', icon: <Bug size={20} strokeWidth={1.5} />, title: '运行和调试' },
  { id: 'extensions', icon: <Blocks size={20} strokeWidth={1.5} />, title: '扩展' },
];

const bottomItems: { icon: React.ReactNode; title: string }[] = [
  { icon: <User size={20} strokeWidth={1.5} />, title: '账户' },
  { icon: <Settings size={20} strokeWidth={1.5} />, title: '设置' },
];

const ActivityBar = () => {
  const dispatch = useAppDispatch();
  const activePanel = useAppSelector((state) => state.layout.activePanel);
  const gitStagedCount = Object.keys(useAppSelector((s) => s.git.staged)).length;
  const gitChangesCount = Object.keys(useAppSelector((s) => s.git.changes)).length;
  const gitMergeCount = Object.keys(useAppSelector((s) => s.git.merge)).length;
  const gitUntrackedCount = Object.keys(useAppSelector((s) => s.git.untracked)).length;
  const gitBadgeCount = gitStagedCount + gitChangesCount + gitMergeCount + gitUntrackedCount;

  return (
    <div className="activity-bar">
      <div className="activity-bar__top">
        {panels.map((p) => (
          <div
            key={p.id}
            className={`activity-bar__item ${activePanel === p.id ? 'active' : ''}`}
            title={p.title}
            onClick={() => dispatch(switchPanel(p.id))}
          >
            {p.icon}
            {p.id === 'git' && gitBadgeCount > 0 && (
              <span className="activity-bar__badge">{gitBadgeCount}</span>
            )}
          </div>
        ))}
      </div>
      <div className="activity-bar__bottom">
        {bottomItems.map((item, idx) => (
          <div
            key={idx}
            className="activity-bar__item"
            title={item.title}
            onClick={() => {
              if (item.title === '设置') dispatch(setSettingsVisible(true));
            }}
          >
            {item.icon}
          </div>
        ))}
      </div>
    </div>
  );
};

export default ActivityBar;
