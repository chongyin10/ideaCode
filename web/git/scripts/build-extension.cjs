const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..', '..');
// 源是 web/git/extension（与 scripts 同级的 ../extension）
const sourceDir = path.resolve(__dirname, '..', 'extension');
// 目标是 extensions/git
const targetDir = path.join(projectRoot, 'extensions', 'git');

// 源文件列表（扩展宿主侧代码）
const files = ['api.js', 'build.cjs', 'extension.js', 'gitCLI.js', 'repository.js', 'statusParser.js', 'package.json'];

// 确保目标目录存在
fs.mkdirSync(targetDir, { recursive: true });

// 复制扩展源文件
for (const file of files) {
  const srcPath = path.join(sourceDir, file);
  const destPath = path.join(targetDir, file);
  if (!fs.existsSync(srcPath)) {
    console.error(`[Git Plugin] 源文件不存在: ${srcPath}`);
    process.exit(1);
  }
  fs.copyFileSync(srcPath, destPath);
}

console.log('[Git Plugin] 扩展源文件已复制到:', targetDir);

// 打包扩展（不需要安装依赖，git 扩展无外部依赖）
console.log('[Git Plugin] 打包扩展...');
try {
  require('child_process').execSync('node build.cjs', { cwd: targetDir, stdio: 'inherit' });
} catch (err) {
  console.error('[Git Plugin] 打包扩展失败:', err.message);
  process.exit(1);
}

console.log('[Git Plugin] 扩展构建完成');