import { GitBranch, AlertCircle, XCircle } from 'lucide-react';
import './StatusBar.css';

const StatusBar = () => {
  return (
    <div className="status-bar">
      <div className="status-bar__left">
        <span className="status-bar__branch">
          <GitBranch size={12} strokeWidth={1.5} />
          master*
        </span>
        <span className="status-bar__item">
          <AlertCircle size={12} strokeWidth={1.5} />
          0
        </span>
        <span className="status-bar__item">
          <XCircle size={12} strokeWidth={1.5} />
          0
        </span>
      </div>
      <div className="status-bar__right">
        <span>Ln 12, Col 34</span>
        <span>UTF-8</span>
        <span>TypeScript</span>
        <span>Prettier</span>
      </div>
    </div>
  );
};

export default StatusBar;
