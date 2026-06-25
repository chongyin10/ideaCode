/**
 * Audit Logger
 *
 * 记录 Agent 的所有 Tool 调用，用于安全审计与问题排查。
 * 当前实现：写入 Extension Host 工作目录下的 .lifeAiCode-agent-audit.log
 * 未来可扩展：发送到远端审计服务、限制文件大小、按日期轮转等。
 */

const fs = require('fs');
const path = require('path');

class AuditLogger {
  constructor(logPath) {
    this.logPath = logPath || '';
  }

  setLogPath(logPath) {
    this.logPath = logPath;
  }

  _ensureLogFile() {
    if (!this.logPath) return false;
    try {
      const dir = path.dirname(this.logPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
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
