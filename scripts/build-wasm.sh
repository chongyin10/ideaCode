#!/usr/bin/env bash
#
# WASM 构建脚本 — 编译 Rust → WebAssembly
#
# 前置条件：
#   1. Rust 工具链:  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
#   2. wasm-pack:    curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
#   3. wasm32 target: rustup target add wasm32-unknown-unknown
#
# 用法:
#   ./scripts/build-wasm.sh          # 构建 release 版本
#   ./scripts/build-wasm.sh --dev    # 构建 debug 版本（更快编译，体积更大）
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WASM_DIR="$PROJECT_ROOT/src/wasm"

cd "$WASM_DIR"

# 检查 wasm-pack 是否安装
if ! command -v wasm-pack &>/dev/null; then
  echo "❌ wasm-pack 未安装。请运行:"
  echo "   curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh"
  exit 1
fi

# 检查 wasm32 target
if ! rustup target list --installed 2>/dev/null | grep -q wasm32-unknown-unknown; then
  echo "📦 安装 wasm32-unknown-unknown target..."
  rustup target add wasm32-unknown-unknown
fi

if [[ "${1:-}" == "--dev" ]]; then
  echo "🔨 构建 WASM (debug)..."
  wasm-pack build --target web --dev
else
  echo "🔨 构建 WASM (release)..."
  wasm-pack build --target web --release
fi

echo ""
echo "✅ WASM 构建完成！"
echo "   产物目录: src/wasm/pkg/"
echo "   - ideacode_wasm.js     (JS 绑定)"
echo "   - ideacode_wasm_bg.wasm (WASM 二进制, $(du -h "$WASM_DIR/pkg/ideacode_wasm_bg.wasm" | cut -f1))"
echo "   - ideacode_wasm.d.ts    (TypeScript 类型)"
echo ""

# 删除 wasm-pack 生成的 .gitignore（包含 * 会误忽略占位文件）
# 项目级 .gitignore 已配置正确的忽略规则
rm -f "$WASM_DIR/pkg/.gitignore"

echo "应用启动时会自动加载 WASM 模块，模糊搜索切换到 WASM 加速。"
