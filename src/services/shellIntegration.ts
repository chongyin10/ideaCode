/**
 * Shell Integration — bash 脚本
 * 
 * 注入到 bash shell 中，实现：
 * 1. 命令边界检测（OSC 633 序列）
 * 2. 当前工作目录 (CWD) 追踪
 * 3. 命令退出码检测
 * 4. Prompt 标记
 * 
 * 参考 VS Code shellIntegration-bash.sh 的实现。
 * OSC 633 序列格式：
 *   OSC 633 ; A      → 标记 Prompt 开始
 *   OSC 633 ; B      → 标记命令输入开始
 *   OSC 633 ; C      → 标记命令执行完成
 *   OSC 633 ; D ; exitCode  → 标记命令退出码
 *   OSC 633 ; E ; cwd ; [hostname]  → 标记 CWD
 */

export const SHELL_INTEGRATION_BASH_SCRIPT = `
# IDEACODE Shell Integration for Bash
if [[ -n "$IDEA_SHELL_INTEGRATION" ]]; then
  return;
fi
export IDEA_SHELL_INTEGRATION=1

__idea_prompt_start() {
  printf "\\033]633;A\\007"
}

__idea_command_start() {
  printf "\\033]633;B\\007"
}

__idea_command_finished() {
  local exit_code=$?
  printf "\\033]633;C\\007"
  printf "\\033]633;D;%s\\007" "$exit_code"
  printf "\\033]633;E;%s\\007" "$PWD"
}

__idea_update_cwd() {
  printf "\\033]633;E;%s\\007" "$PWD"
}

# 注入到 PROMPT_COMMAND 和 PS1
if [[ "$PROMPT_COMMAND" != *__idea_prompt_start* ]]; then
  PROMPT_COMMAND="__idea_prompt_start;$PROMPT_COMMAND"
fi
if [[ "$PROMPT_COMMAND" != *__idea_command_finished* ]]; then
  PROMPT_COMMAND="$PROMPT_COMMAND;__idea_command_finished"
fi

# 捕获 DEBUG 陷阱以检测命令开始
trap '__idea_command_start' DEBUG
# 目录改变时更新
trap '__idea_update_cwd' SIGWINCH
`;

export const SHELL_INTEGRATION_ZSH_SCRIPT = `
# IDEACODE Shell Integration for Zsh
if [[ -n "$IDEA_SHELL_INTEGRATION" ]]; then
  return;
fi
export IDEA_SHELL_INTEGRATION=1

__idea_prompt_start() {
  printf "\\033]633;A\\007"
}

__idea_command_start() {
  printf "\\033]633;B\\007"
}

__idea_command_finished() {
  local exit_code=$?
  printf "\\033]633;C\\007"
  printf "\\033]633;D;%s\\007" "$exit_code"
  printf "\\033]633;E;%s\\007" "$PWD"
}

__idea_update_cwd() {
  printf "\\033]633;E;%s\\007" "$PWD"
}

# Zsh precmd/preexec hooks
autoload -Uz add-zsh-hook
add-zsh-hook precmd __idea_prompt_start
add-zsh-hook precmd __idea_command_finished
add-zsh-hook preexec __idea_command_start
add-zsh-hook chpwd __idea_update_cwd
`;
