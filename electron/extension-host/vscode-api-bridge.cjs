/**
 * VSCode API 桥接模块
 *
 * 在 Extension Host 进程中加载统一的 vscode-api 模块，
 * 替代原有的 index.cjs 中内联的 vscode 对象。
 *
 * 架构变更：
 *   之前: vscode 对象直接在 index.cjs 中内联定义 (~300行)
 *   现在: 从 @ideacode/extensions-shared 包加载统一 API
 */

const path = require('path');

/**
 * 加载统一 vscode-api 模块
 * 优先从 packages/extensions-shared 加载，回退到传统方式
 */
function loadVscodeApi() {
  const sharedApiPath = path.resolve(__dirname, '..', '..', 'packages', 'extensions-shared', 'src', 'vscode-api.js');
  
  try {
    const vscode = require(sharedApiPath);
    console.log('[ExtensionHost] 已加载统一 vscode-api (微内核模式)');
    return vscode;
  } catch (err) {
    console.warn('[ExtensionHost] 无法加载统一 vscode-api，使用传统内联 API:', err.message);
    return null;
  }
}

module.exports = { loadVscodeApi };
