const si = require('systeminformation');
const { Channels } = require('../shared/channels.cjs');

/**
 * 系统资源监控器
 *
 * 定期采集 CPU / 内存，并通过 IPC 广播给所有渲染窗口。
 * 采集逻辑运行在主进程，避免渲染进程直接访问系统 API。
 *
 * ─── 性能要点（macOS） ───
 * 1. systeminformation.graphics() 内部 spawn `system_profiler SPDisplaysDataType`，
 *    该命令在 macOS 上同步阻塞 1~3 秒，且 system_profiler 自身吃满一个 CPU 核。
 *    每 2 秒调用一次会让主进程持续阻塞 + 子进程持续 100% CPU。
 * 2. macOS 上 system_profiler 也不返回 GPU 利用率（utilizationGpu 始终为 undefined），
 *    历史代码反复调用纯属浪费。
 * 3. currentLoad() 在 macOS 上 spawn `top -l 1`，也有数百毫秒开销。
 *
 * 修复策略：
 * - GPU 信息只在启动时采集一次（型号基本不变），周期采集不再调用 graphics()。
 * - 周期采集只跑 currentLoad + mem，并把默认间隔从 2s 放宽到 5s。
 * - 单次采集失败不影响后续，避免连环雪崩。
 */
class SystemMonitor {
  /**
   * @param {import('./windowManager.cjs').WindowManager} windowManager
   * @param {object} [options]
   * @param {number} [options.intervalMs=5000]
   */
  constructor(windowManager, options = {}) {
    this.windowManager = windowManager;
    this.intervalMs = options.intervalMs || 5000;
    /** @type {NodeJS.Timeout | null} */
    this.timer = null;
    /** @type {{ gpu: number | null } | null} */
    this.staticGpu = null;
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    // GPU 静态信息：仅启动时采集一次（macOS 上 system_profiler 极慢，且利用率字段不支持）
    this.collectStaticGpu();
    // 周期采集 CPU/内存
    this.collectAndBroadcast();
    this.timer = setInterval(() => {
      this.collectAndBroadcast();
    }, this.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  /** 启动时一次性采集 GPU 静态信息（型号/显存），后续周期不再调用 graphics() */
  async collectStaticGpu() {
    try {
      const graphics = await si.graphics();
      const controllers = graphics?.controllers || [];
      let memTotal = 0;
      let memUsed = 0;
      for (const c of controllers) {
        if (c.memoryTotal && c.memoryUsed) {
          memTotal += c.memoryTotal;
          memUsed += c.memoryUsed;
        }
      }
      // macOS 无法获取 GPU 利用率，这里只保留显存占用比作为静态参考
      const gpu = memTotal > 0 ? (memUsed / memTotal) * 100 : null;
      this.staticGpu = { gpu: gpu === null ? null : Math.max(0, Math.min(100, gpu)) };
    } catch (err) {
      this.staticGpu = { gpu: null };
    }
  }

  async collectAndBroadcast() {
    try {
      const stats = await this.collect();
      this.broadcast(stats);
    } catch (err) {
      // 采集失败时不影响主进程运行，静默忽略
      console.warn('[SystemMonitor] 采集系统资源失败:', err.message);
    }
  }

  async collect() {
    // 仅采集 CPU + 内存，避免 macOS 上 system_profiler 阻塞
    const [load, mem] = await Promise.all([
      si.currentLoad(),
      si.mem(),
    ]);

    const cpu = typeof load.currentLoad === 'number' ? load.currentLoad : 0;
    // 使用“已用且不可回收”的内存更贴近用户感知：
    // 优先用 total - available（macOS/Linux 均可），取不到时回退 active
    let memory = 0;
    if (mem.total > 0) {
      if (typeof mem.available === 'number' && mem.available > 0) {
        memory = ((mem.total - mem.available) / mem.total) * 100;
      } else if (typeof mem.active === 'number') {
        memory = (mem.active / mem.total) * 100;
      } else {
        memory = (mem.used / mem.total) * 100;
      }
    }

    return {
      cpu: Math.max(0, Math.min(100, cpu)),
      memory: Math.max(0, Math.min(100, memory)),
      gpu: this.staticGpu?.gpu ?? null,
    };
  }

  broadcast(stats) {
    if (!this.windowManager) return;
    try {
      this.windowManager.broadcast(Channels.SYSTEM_STATS, stats);
    } catch (err) {
      console.warn('[SystemMonitor] 广播失败:', err.message);
    }
  }
}

module.exports = { SystemMonitor };
