/**
 * 进程管理器
 *
 * 管理所有子进程的生命周期：
 * - 扩展宿主进程 (Extension Host)
 * - Worker 线程
 * - 其他服务子进程
 *
 * 职责：
 * - 进程 fork/启动
 * - 进程健康检查
 * - 崩溃自动重启
 * - 进程优雅关闭
 */

export interface ChildProcess {
  readonly pid: number;
  readonly alive: boolean;
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): () => void;
  onExit(handler: (code: number | null, signal: string | null) => void): () => void;
  onError(handler: (err: Error) => void): () => void;
  kill(signal?: string): void;
}

export interface ProcessConfig {
  id: string;
  entry: string;
  args?: string[];
  env?: Record<string, string>;
  autoRestart?: boolean;
  restartDelayMs?: number;
  maxRestarts?: number;
}

export interface ProcessInfo {
  id: string;
  pid: number | null;
  status: 'stopped' | 'starting' | 'running' | 'stopping';
  restartCount: number;
  startTime: number | null;
  config: ProcessConfig;
}

export class ProcessManager {
  private processes: Map<string, ProcessInfo> = new Map();
  private childProcesses: Map<string, ChildProcess> = new Map();
  private spawnFn: ((config: ProcessConfig, onMessage: (msg: unknown) => void) => ChildProcess) | null = null;

  /**
   * 注入进程创建函数 (解耦平台依赖)
   * Electron 环境用 child_process.fork，Web 环境用 Worker
   */
  setSpawnFn(fn: (config: ProcessConfig, onMessage: (msg: unknown) => void) => ChildProcess): void {
    this.spawnFn = fn;
  }

  /**
   * 启动子进程
   */
  start(config: ProcessConfig): Promise<ProcessInfo> {
    return new Promise((resolve, reject) => {
      if (!this.spawnFn) {
        reject(new Error('未设置进程创建函数'));
        return;
      }

      const existing = this.processes.get(config.id);
      if (existing && existing.status === 'running') {
        resolve(existing);
        return;
      }

      const info: ProcessInfo = {
        id: config.id,
        pid: null,
        status: 'starting',
        restartCount: existing?.restartCount || 0,
        startTime: null,
        config,
      };
      this.processes.set(config.id, info);

      try {
        const child = this.spawnFn(config, () => {
          // 子类或桥接层处理消息
        });

        info.pid = child.pid;
        info.status = 'running';
        info.startTime = Date.now();
        this.childProcesses.set(config.id, child);

        child.onExit((code, signal) => {
          info.status = 'stopped';
          info.pid = null;
          console.log(`[ProcessManager] 进程退出: ${config.id} code=${code} signal=${signal}`);

          if (config.autoRestart && (info.restartCount < (config.maxRestarts ?? 5))) {
            const delay = config.restartDelayMs ?? 1000;
            console.log(`[ProcessManager] 自动重启: ${config.id} 延迟 ${delay}ms`);
            setTimeout(() => {
              info.restartCount++;
              this.start(config).catch(console.error);
            }, delay);
          }
        });

        child.onError((err) => {
          console.error(`[ProcessManager] 进程错误: ${config.id}`, err.message);
        });

        console.log(`[ProcessManager] 进程已启动: ${config.id} pid=${child.pid}`);
        resolve(info);
      } catch (err) {
        info.status = 'stopped';
        reject(err);
      }
    });
  }

  /**
   * 停止子进程
   */
  stop(id: string, signal: string = 'SIGTERM'): void {
    const child = this.childProcesses.get(id);
    if (!child || !child.alive) return;

    const info = this.processes.get(id);
    if (info) info.status = 'stopping';

    child.kill(signal);
  }

  /**
   * 停止所有进程
   */
  stopAll(signal: string = 'SIGTERM'): void {
    for (const id of this.childProcesses.keys()) {
      this.stop(id, signal);
    }
  }

  /**
   * 发送消息到子进程
   */
  send(id: string, message: unknown): boolean {
    const child = this.childProcesses.get(id);
    if (!child || !child.alive) return false;
    child.send(message);
    return true;
  }

  /**
   * 获取进程信息
   */
  getInfo(id: string): ProcessInfo | undefined {
    return this.processes.get(id);
  }

  /**
   * 获取所有进程信息
   */
  getAll(): ProcessInfo[] {
    return Array.from(this.processes.values());
  }

  /**
   * 是否有运行中的进程
   */
  hasRunning(id: string): boolean {
    const info = this.processes.get(id);
    return info?.status === 'running' && info.pid !== null;
  }
}
