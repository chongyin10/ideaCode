const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..', '..');
// 源是 web/git 的 vite 输出（与脚本同级的 webview-dist）
const sourceDir = path.resolve(__dirname, '..', 'webview-dist');
// 目标是 extensions/git/webview（被 extension.js 在运行时读取）
const targetDir = path.join(projectRoot, 'extensions', 'git', 'webview');

// 确保目标目录存在
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

// 复制文件
function copyDir(src, dest) {
  if (!fs.existsSync(src)) {
    console.error(`源目录不存在: ${src}`);
    process.exit(1);
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (!fs.existsSync(destPath)) {
        fs.mkdirSync(destPath, { recursive: true });
      }
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// 清理目标目录中源目录已不存在的旧文件（防止 hash 变更后遗留无效资源导致 404）
function pruneStaleFiles(src, dest) {
  if (!fs.existsSync(dest)) return;
  const srcFiles = new Set();
  function collect(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(src, full);
      if (entry.isDirectory()) {
        collect(full);
      } else {
        srcFiles.add(rel);
      }
    }
  }
  collect(src);

  function walk(d) {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      const rel = path.relative(dest, full);
      if (entry.isDirectory()) {
        walk(full);
        // 如果子目录已为空，删除
        if (fs.readdirSync(full).length === 0) {
          fs.rmdirSync(full);
        }
      } else if (!srcFiles.has(rel)) {
        // 源目录中不存在的旧文件，删除
        fs.unlinkSync(full);
        console.log(`[Git Plugin] 清理过期资源: ${rel}`);
      }
    }
  }
  walk(dest);
}

copyDir(sourceDir, targetDir);
pruneStaleFiles(sourceDir, targetDir);
console.log(`[Git Plugin] WebView 资源已复制到: ${targetDir}`);