const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * 历史记录管理器
 *
 * 存储用户最近打开的项目/文件夹路径，持久化到磁盘：
 * - macOS: ~/Library/Application Support/IDEACODE/ideaCodeHistory.json
 * - Windows: %APPDATA%/IDEACODE/ideaCodeHistory.json
 * - Linux: ~/.config/IDEACODE/ideaCodeHistory.json
 *
 * 数据结构：
 * [
 *   { path: "/Users/xxx/project", name: "project", timestamp: 1700000000000, openedCount: 5 }
 * ]
 */

const MAX_RECENT_COUNT = 20;
const HISTORY_FILE_NAME = 'ideaCodeHistory.json';

class HistoryManager {
  constructor() {
    this.dataDir = path.join(app.getPath('userData'));
    this.filePath = path.join(this.dataDir, HISTORY_FILE_NAME);
    /** @type {RecentProject[]|null} */
    this.cache = null;
  }

  /**
   * 获取历史记录文件路径（调试用）
   */
  getFilePath() {
    return this.filePath;
  }

  /**
   * 读取历史记录
   * @returns {Promise<RecentProject[]>}
   */
  async getRecent() {
    if (this.cache !== null) {
      return this.cache;
    }

    try {
      const data = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        // 过滤掉已不存在的路径
        const valid = await this.filterExisting(parsed);
        this.cache = valid;
        return valid;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[HistoryManager] 读取历史记录失败:', err.message);
      }
    }

    this.cache = [];
    return [];
  }

  /**
   * 添加/更新最近项目
   * @param {string} projectPath
   * @param {string} name
   */
  async addRecent(projectPath, name) {
    const recent = await this.getRecent();
    const now = Date.now();

    const existingIndex = recent.findIndex((r) => r.path === projectPath);

    if (existingIndex >= 0) {
      // 更新已有记录：提到最前，增加计数
      const item = recent[existingIndex];
      item.timestamp = now;
      item.openedCount = (item.openedCount || 1) + 1;
      // 移到数组开头
      recent.splice(existingIndex, 1);
      recent.unshift(item);
    } else {
      // 新增记录
      recent.unshift({
        path: projectPath,
        name: name || projectPath.split(/[\\/]/).pop() || projectPath,
        timestamp: now,
        openedCount: 1,
      });
    }

    // 限制数量
    if (recent.length > MAX_RECENT_COUNT) {
      recent.length = MAX_RECENT_COUNT;
    }

    this.cache = recent;
    await this.save();
  }

  /**
   * 移除指定历史记录
   * @param {string} projectPath
   */
  async removeRecent(projectPath) {
    const recent = await this.getRecent();
    const filtered = recent.filter((r) => r.path !== projectPath);
    this.cache = filtered;
    await this.save();
  }

  /**
   * 清空历史记录
   */
  async clearAll() {
    this.cache = [];
    try {
      await fs.unlink(this.filePath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  /**
   * 保存到磁盘
   */
  async save() {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      await fs.writeFile(
        this.filePath,
        JSON.stringify(this.cache, null, 2),
        'utf-8'
      );
    } catch (err) {
      console.error('[HistoryManager] 保存历史记录失败:', err.message);
    }
  }

  /**
   * 过滤掉已不存在的路径
   */
  async filterExisting(items) {
    const results = [];
    for (const item of items) {
      try {
        await fs.access(item.path);
        results.push(item);
      } catch {
        // 路径不存在，跳过
      }
    }
    return results;
  }
}

module.exports = { HistoryManager };
