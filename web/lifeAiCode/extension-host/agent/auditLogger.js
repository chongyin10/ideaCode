/**
 * Audit Logger
 *
 * 记录 Agent 的所有 Tool 调用，用于安全审计与问题排查。
 * 默认写入 ~/.lifeAiCode-agent-audit.log（用户家目录下，多平台都可用）。
 * 也可由调用方通过 setLogPath() 自定义。
 *
 * 未来可扩展：限制文件大小、按日期轮转、上报到远端审计服务等。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

class AuditLogger {
  /**
   * @param {string} [logPath] 自定义日志路径；为空时使用默认 ~/.lifeAiCode-agent-audit.log
   */
  constructor(logPath) {
    this.logPath = logPath || '';
  }

  setLogPath(logPath) {
    this.logPath = logPath;
  }

  /**
   * 返回默认日志路径：~/.lifeAiCode-agent-audit.log
   */
  static defaultPath() {
    return path.join(os.homedir(), '.lifeAiCode-agent-audit.log');
  }

  _ensureLogFile() {
    if (!this.logPath) return false;
    try {
      const dir = path.dirname(this.logPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // 用 fs.openSync 探测可写性
      const fd = fs.openSync(this.logPath, 'a');
      fs.closeSync(fd);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 记录一次 Tool 调用
   * @param {object} entry
   *   - timestamp: number
   *   - tool: string
   *   - args: object
   *   - status: 'running' | 'success' | 'error'
   *   - result?: object
   *   - confirmed?: boolean
   *   - error?: string
   */
  log(entry) {
    if (!this.logPath) return;
    if (!this._ensureLogFile()) return;

    const line = JSON.stringify({
      timestamp: Date.now(),
      ...entry,
    });

    try {
      fs.appendFileSync(this.logPath, line + '\n', 'utf-8');
    } catch (err) {
      console.error('[AuditLogger] 写入日志失败:', err.message);
    }
  }
}

module.exports = { AuditLogger };
