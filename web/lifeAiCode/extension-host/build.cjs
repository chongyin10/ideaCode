const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['./extension.js'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'extension.cjs',
  external: ['https', 'http', 'events', 'fs', 'path'],
  minify: false,
  sourcemap: false,
}).catch((err) => {
  console.error('[LifeAiCode Build] 打包失败:', err);
  process.exit(1);
});
