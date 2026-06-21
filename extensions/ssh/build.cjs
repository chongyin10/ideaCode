const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['./extension.js'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'extension.cjs',
  // cpu-features 是可选原生模块，打包会失败；运行时不需要它，ssh2 会回退到 JS 实现
  external: ['cpu-features'],
  minify: false,
  sourcemap: false,
}).catch((err) => {
  console.error('[SSH Plugin Build] 打包失败:', err);
  process.exit(1);
});
