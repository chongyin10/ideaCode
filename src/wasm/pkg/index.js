/**
 * WASM 模块占位文件
 *
 * 此文件在 `wasm-pack build` 之前作为空模块占位，
 * 确保 TypeScript 和 Vite 能正常解析 `import('../wasm/pkg')`。
 *
 * 运行 `wasm-pack build --target web --release` 后，
 * wasm-pack 会生成 `ideacode_wasm.js` + `package.json`（main 指向它），
 * 此占位文件将被自动旁路（package.json main 字段优先于 index.js）。
 *
 * 加载器 (wasmLoader.ts) 会检测导出函数是否存在，
 * 若不存在则保持 null，自动降级到 JS 实现。
 */
export {};
