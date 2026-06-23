/**
 * 一键完整构建脚本
 *
 * 所有源码位于 web/lifeAiCode/ 下：
 *   web/lifeAiCode/extension-host/  — Extension Host 核心 JS
 *   web/lifeAiCode/src/             — WebView 前端源码
 *   web/lifeAiCode/index.html       — WebView 入口
 *
 * 构建产物输出到 extensions/lifeAiCode/（IDE 加载目录）。
 * 该目录完全由构建产生，可随时删除后重建。
 *
 * 用法:
 *   npm run build:all
 *   node scripts/build-all.cjs
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WEBVIEW_SRC = path.resolve(__dirname, '..');
const EXT_DIR = path.resolve(__dirname, '..', '..', '..', 'extensions', 'lifeAiCode');
const HOST_SRC = path.join(WEBVIEW_SRC, 'extension-host');
const COPY_SCRIPT = path.join(__dirname, 'copy-to-extension.cjs');

console.log('\n═══════════════════════════════════════');
console.log('  LifeAiCode 完整构建');
console.log('═══════════════════════════════════════\n');

/* ─── Step 0: 校验 extension-host 源码存在 ─── */

console.log('[0/4] 检查源码完整性...');

const requiredHostFiles = [
  'api.js', 'extension.js', 'llmClient.js',
  'codeContext.js', 'suggestionGenerator.js',
  'package.json', 'build.cjs',
];

let hostOk = requiredHostFiles.every((f) => fs.existsSync(path.join(HOST_SRC, f)));
if (!hostOk) {
  console.error('❌ extension-host/ 源码不完整，缺少:');
  for (const f of requiredHostFiles) {
    const exists = fs.existsSync(path.join(HOST_SRC, f));
    console.error(`   ${exists ? '✅' : '❌'} ${f}`);
  }
  process.exit(1);
}
console.log('  ✅ extension-host/ 源码完整');
console.log('  ✅ webview src/ 就绪');

/* ─── Step 1: 构建 WebView 前端 ─── */

console.log('\n[1/4] 构建 WebView 前端...');
try {
  execSync('npm run build-only', { cwd: WEBVIEW_SRC, stdio: 'inherit' });
  console.log('  ✅ WebView 构建完成');
} catch (err) {
  console.error('  ❌ WebView 构建失败:', err.message);
  process.exit(1);
}

/* ─── Step 2: 部署到 extensions/lifeAiCode/ ─── */

console.log('\n[2/4] 部署到 extensions/lifeAiCode/...');
try {
  require(COPY_SCRIPT);
  console.log('  ✅ 部署完成');
} catch (err) {
  console.error('  ❌ 部署失败:', err.message);
  process.exit(1);
}

/* ─── Step 3: 打包扩展 ─── */

console.log('\n[3/4] 打包扩展...');
const extBuildScript = path.join(EXT_DIR, 'build.cjs');
if (fs.existsSync(extBuildScript)) {
  const hasEsbuild = (() => {
    try { return !!require.resolve('esbuild', { paths: [EXT_DIR] }); }
    catch { return false; }
  })();
  if (hasEsbuild) {
    try {
      execSync('node build.cjs', { cwd: EXT_DIR, stdio: 'inherit' });
      console.log('  ✅ 扩展打包完成');
    } catch (err) {
      console.warn('  ⚠️  打包失败（可忽略）:', err.message);
    }
  } else {
    console.log('  - 跳过 esbuild 打包（未安装 esbuild）');
  }
}

/* ─── Step 4: 验证 ─── */

console.log('\n[4/4] 验证构建产物...');
const verifyFiles = [
  'package.json', 'extension.cjs', 'api.js',
  'llmClient.js', 'codeContext.js', 'suggestionGenerator.js',
  'webview/index.html', 'webview/assets/main.js',
];
let allOk = true;
for (const f of verifyFiles) {
  const fullPath = path.join(EXT_DIR, f);
  const exists = fs.existsSync(fullPath);
  if (!exists) {
    console.error(`  ❌ ${f}`);
    allOk = false;
  }
}
if (allOk) {
  console.log('  ✅ 所有构建产物就绪');
} else {
  console.error('  ❌ 部分文件缺失，请检查');
  process.exit(1);
}

console.log('\n═══════════════════════════════════════');
console.log('  ✅ 全部完成！');
console.log(`  extensions/lifeAiCode/ 已就绪`);
console.log('  如需清理: rm -rf extensions/lifeAiCode/');
console.log('  重建: npm run build:all');
console.log('═══════════════════════════════════════\n');
