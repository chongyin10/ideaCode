import { Outlet } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { useElectronEvents, useTsServerLifecycle } from './hooks';
import TopBar from './components/TopBar';
import ActivityBar from './components/ActivityBar';
import SidePanel from './components/SidePanel';
import RightPanel from './components/RightPanel';
import BottomPanel from './components/BottomPanel';
import StatusBar from './components/StatusBar';
import './App.css';

// ─── 按需加载组件（React.lazy + Suspense）───
// ModalWebview / TerminalModal 仅在用户触发对应操作时才需要，
// 不在首屏 bundle 中加载，减少首屏体积。
const ModalWebview = lazy(() => import('./components/ModalWebview'));
const TerminalModal = lazy(() => import('./components/TerminalModal'));

function App() {
  // 挂载 Electron 系统事件监听（菜单、窗口焦点、文件变更）
  useElectronEvents();

  // 监听根目录变化，提前启动/重启 tsserver，缩短打开文件后语义高亮（变量/方法/属性着色）
  // 出现的延迟。
  useTsServerLifecycle();

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
      <Suspense fallback={null}>
        <ModalWebview />
        <TerminalModal />
      </Suspense>
    </div>
  );
}

export default App;
