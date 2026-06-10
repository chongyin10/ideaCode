#!/usr/bin/env node
import { createServer } from 'vite';
import { spawn } from 'child_process';

async function start() {
  // 启动 Vite 开发服务器
  const server = await createServer({
    root: process.cwd(),
  });
  await server.listen();

  const urls = server.resolvedUrls;
  const localUrl = urls.local[0];

  console.log(`\n[dev] Vite server ready at ${localUrl}\n`);

  // 启动 Electron
  const electronProcess = spawn('npx', ['electron', 'electron/main.cjs'], {
    env: { ...process.env, VITE_DEV_SERVER_URL: localUrl },
    stdio: 'inherit',
    shell: true,
  });

  electronProcess.on('close', (code) => {
    console.log(`\n[dev] Electron exited with code ${code}`);
    server.close();
    process.exit(code || 0);
  });

  // 优雅关闭
  process.on('SIGINT', () => {
    console.log('\n[dev] Shutting down...');
    electronProcess.kill();
    server.close();
  });

  process.on('SIGTERM', () => {
    electronProcess.kill();
    server.close();
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
