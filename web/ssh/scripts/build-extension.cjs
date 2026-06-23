const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..', '..', '..');
const sourceDir = path.join(__dirname, '..', 'extension');
const targetDir = path.join(projectRoot, 'extensions', 'ssh');

// 源文件列表（扩展宿主侧代码）
const files = ['api.js', 'build.cjs', 'extension.js', 'package.json'];

// 确保目标目录存在
fs.mkdirSync(targetDir, { recursive: true });

// 复制扩展源文件
for (const file of files) {
  const srcPath = path.join(sourceDir, file);
  const destPath = path.join(targetDir, file);
  if (!fs.existsSync(srcPath)) {
    console.error(`[SSH Plugin] 源文件不存在: ${srcPath}`);
    process.exit(1);
  }
  fs.copyFileSync(srcPath, destPath);
}

console.log('[SSH Plugin] 扩展源文件已复制到:', targetDir);

// 安装扩展依赖
console.log('[SSH Plugin] 安装扩展依赖...');
execSync('npm install', { cwd: targetDir, stdio: 'inherit' });

// 打包扩展
console.log('[SSH Plugin] 打包扩展...');
execSync('node build.cjs', { cwd: targetDir, stdio: 'inherit' });

console.log('[SSH Plugin] 扩展构建完成');
