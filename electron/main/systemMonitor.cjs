const si = require('systeminformation');
const { Channels } = require('../shared/channels.cjs');

/**
 * 系统资源监控器
 *
 * 定期采集 CPU / 内存 / GPU 使用率，并通过 IPC 广播给所有渲染窗口。
 * 采集逻辑运行在主进程，避免渲染进程直接访问系统 API。
 */
class SystemMonitor {
  /**
   * @param {import('./windowManager.cjs').WindowManager} windowManager
   * @param {object} [options]
   * @param {number} [options.intervalMs=2000]
   */
  constructor(windowManager, options = {}) {
    this.windowManager = windowManager;
    this.intervalMs = options.intervalMs || 2000;
    /** @type {NodeJS.Timeout | null} */
    this.timer = null;
    this.lastCpuLoad = 0;
  }

  start() {
    if (this.timer) return;
    // 立即采集一次，随后周期性采集
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
    const [load, mem, graphics] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.graphics(),
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

    let gpu = null;
    const controllers = graphics?.controllers || [];
    if (controllers.length > 0) {
      let utilSum = 0;
      let utilCount = 0;
      let memTotal = 0;
      let memUsed = 0;

      for (const c of controllers) {
        if (typeof c.utilizationGpu === 'number') {
          utilSum += c.utilizationGpu;
          utilCount++;
        }
        if (c.memoryTotal && c.memoryUsed) {
          memTotal += c.memoryTotal;
          memUsed += c.memoryUsed;
        }
      }

      if (utilCount > 0) {
        gpu = utilSum / utilCount;
      } else if (memTotal > 0) {
        gpu = (memUsed / memTotal) * 100;
      }
    }

    return {
      cpu: Math.max(0, Math.min(100, cpu)),
      memory: Math.max(0, Math.min(100, memory)),
      gpu: gpu === null ? null : Math.max(0, Math.min(100, gpu)),
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
