/**
 * 构建产物拷贝脚本
 *
 * 将 web/lifeAiCode/ 下的源代码和构建产物，
 * 拷贝到 extensions/lifeAiCode/（IDE 实际加载的目录）。
 */

const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..', '..');
const extDir = path.join(projectRoot, 'extensions', 'lifeAiCode');
const extHostSrc = path.resolve(__dirname, '..', 'extension-host');
const webviewDist = path.join(extDir, 'webview-dist');

function copyDir(src, dest) {
  if (!fs.existsSync(src)) {
    console.error(`源目录不存在: ${src}`);
    process.exit(1);
  }
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/* ── 1. 拷贝 Extension Host 核心源码 (JS / JSON) ── */
console.log('[LifeAiCode] 拷贝 Extension Host 核心文件...');
copyDir(extHostSrc, extDir);
console.log(`  → ${extDir}`);

/* ── 2. 拷贝 WebView 前端资源 (webview-dist → webview) ── */
const webviewTarget = path.join(extDir, 'webview');
if (fs.existsSync(webviewDist)) {
  console.log('[LifeAiCode] 拷贝 WebView 前端资源...');
  copyDir(webviewDist, webviewTarget);
  console.log(`  → ${webviewTarget}`);
} else {
  console.warn('[LifeAiCode] ⚠️ webview-dist 不存在，跳过 WebView 拷贝');
}

console.log('[LifeAiCode] 构建产物部署完成');
