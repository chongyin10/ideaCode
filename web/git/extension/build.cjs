const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['./extension.js'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'extension.cjs',
  // 把 api.js 作为外部（它在同一目录），或者一起打包；这里选择一起打包简化部署
  minify: false,
  sourcemap: false,
  // 允许从 git 子目录的 node_modules 解析依赖（虽然目前没有外部依赖）
  nodePaths: ['../../node_modules'],
}).catch((err) => {
  console.error('[Git Plugin Build] 打包失败:', err);
  process.exit(1);
});