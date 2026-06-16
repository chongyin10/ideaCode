#!/usr/bin/env node
/**
 * node-pty 在 darwin 平台的 prebuild 中 spawn-helper 可能缺少可执行权限，
 * 导致 Electron 主进程中调用 pty.spawn 时抛出 posix_spawnp failed。
 * 此脚本在 postinstall 阶段为所有平台的 spawn-helper 添加执行权限。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nodePtyDir = path.resolve(__dirname, '../node_modules/node-pty');
const prebuildsDir = path.join(nodePtyDir, 'prebuilds');

function chmodSpawnHelpers(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const helperPath = path.join(dir, entry.name, 'spawn-helper');
      if (fs.existsSync(helperPath)) {
        try {
          fs.chmodSync(helperPath, 0o755);
          console.log(`[fix-node-pty] chmod +x ${helperPath}`);
        } catch (err) {
          console.warn(`[fix-node-pty] 无法修改 ${helperPath} 权限:`, err.message);
        }
      }
    }
  }
}

chmodSpawnHelpers(prebuildsDir);
