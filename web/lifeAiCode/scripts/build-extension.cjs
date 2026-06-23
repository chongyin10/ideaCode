/**
 * 打包 Extension Host 端核心代码
 *
 * 构建产物在 web/lifeAiCode/extension-host/ 中维护，
 * 通过 copy-to-extension 拷贝到 extensions/lifeAiCode/。
 * 此脚本打包 extension.cjs（可选，非必须）。
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const EXT_DIR = path.join(ROOT, 'extensions', 'lifeAiCode');
const HOST_SRC = path.resolve(__dirname, '..', 'extension-host');

// 确保扩展目录存在
if (!fs.existsSync(EXT_DIR)) {
  fs.mkdirSync(EXT_DIR, { recursive: true });
}

// 先拷贝最新源码
const copyScript = path.resolve(__dirname, 'copy-to-extension.cjs');
if (fs.existsSync(copyScript)) {
  require(copyScript);
}

// 然后打包
const BUILD_SCRIPT = path.join(EXT_DIR, 'build.cjs');
if (!fs.existsSync(BUILD_SCRIPT)) {
  console.warn('[build-extension] ⚠️ build.cjs 不存在，跳过打包');
  return;
}

const hasEsbuild = (() => {
  try { return !!require.resolve('esbuild', { paths: [EXT_DIR] }); }
  catch { return false; }
})();

if (!hasEsbuild) {
  console.log('[build-extension] esbuild 未安装，跳过打包');
  return;
}

console.log('[build-extension] 打包扩展...');
try {
  execSync('node build.cjs', { cwd: EXT_DIR, stdio: 'inherit' });
  console.log('[build-extension] ✅ 打包完成');
} catch (err) {
  console.error('[build-extension] ❌ 打包失败:', err.message);
  process.exit(1);
}
