import { Outlet } from 'react-router-dom';
import { useElectronEvents } from './hooks';
import TopBar from './components/TopBar';
import ActivityBar from './components/ActivityBar';
import SidePanel from './components/SidePanel';
import RightPanel from './components/RightPanel';
import BottomPanel from './components/BottomPanel';
import StatusBar from './components/StatusBar';
import ModalWebview from './components/ModalWebview';
import TerminalModal from './components/TerminalModal';
import './App.css';

function App() {
  // 挂载 Electron 系统事件监听（菜单、窗口焦点、文件变更）
  useElectronEvents();

  return (
    <div className="app-layout">
      <TopBar />
      <div className="app-layout__body">
        <ActivityBar />
        <SidePanel />
        <div className="app-layout__main">
          <div className="app-layout__content">
            <Outlet />
          </div>
          <BottomPanel />
        </div>
        <RightPanel />
      </div>
      <StatusBar />
      <ModalWebview />
      <TerminalModal />
    </div>
  );
}

export default App;
