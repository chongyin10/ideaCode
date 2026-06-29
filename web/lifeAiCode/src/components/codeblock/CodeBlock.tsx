/* ─────────────────────────────────────────────────────────────────── */
/*  CodeBlock 主组件                                                   */
/* ─────────────────────────────────────────────────────────────────── */
/*  渲染代码块骨架（header: dots + lang + skill actions + copy；
 *  body: 语法高亮；footer: skill 输出区）。
 *
 *  Skill 扩展点：通过 getMatchingSkills 查找当前语言匹配的 Skill，
 *  调用 skill.renderActions / skill.renderOutput 渲染专属行为。
 *  新增语言行为只需在 skills/ 下新建文件 + registerSkill。
 *
 *  Skill 的 state（execId、outputCollapsed 等）通过 skillStates
 *  统一管理，skill 通过 ctx.getSkillState/setSkillState 读写，
 *  避免在 render 函数里用 hooks。                            */

import { useContext, useState } from 'react';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Copy, Check, Terminal } from 'lucide-react';

import { ShellContext } from './ShellContext';
import { REGISTERED_LANGUAGES, LANGUAGE_DISPLAY_NAMES, detectCodeLanguage } from './languages';
import { getMatchingSkills } from './skills/registry';
import type { CodeBlockSkillContext } from './skills/types';
import { isShellCommand } from './shellDetect';

/* shell 系列语言集合——当 markdown fence 标了其中之一，但代码本体并不是
* shell 命令（被 isShellCommand 否决）时，就回退到 detectCodeLanguage
* 重新识别为真实语言（如 typescript / javascript / python 等）。
* 这样可以避免 LLM 把 JS/TS 代码误标为 ```bash 时，仍然显示 bash 高亮
* + 错误语言标签。ShellSkill.canActivate 已经在按钮层做了同样判断，这里
* 把"语言显示/语法高亮"层也对齐，保证 UI 与执行风险判断一致。      */
const SHELL_LANGUAGE_SET = new Set(['bash', 'shell', 'sh', 'zsh', 'fish']);

interface CodeBlockProps {
  language: string;
  children: React.ReactNode;
}

export function CodeBlock({ language, children }: CodeBlockProps) {
  // 从 ShellContext 获取 shell 执行能力（绕过自定义 hast 渲染的 prop 链）
  const { shellOutputs, onExecuteShell, onKillShell } = useContext(ShellContext);
  const code = String(children).replace(/\n$/, '');
  const [copied, setCopied] = useState(false);
  // Skill 专属 state 容器：每个 skill 用自己的 id 作为 key 存取 state
  const [skillStates, setSkillStates] = useState<Record<string, Record<string, unknown>>>({});

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* ignore */ }
  };

  // 语言归一化：已注册用原值，未注册尝试自动检测，最后回退 text。
  // 关键：shell 系列语言（bash/shell/sh/zsh/fish）必须通过 isShellCommand
  // 强确认；否则 LLM 把 JS/TS 错标为 ```bash 时，仍会渲染为 bash 高亮
  // + 显示 bash 标签（虽然 ShellSkill 会否决执行按钮，但视觉上已经误导用户）。
  const isKnownLang = !!(language && REGISTERED_LANGUAGES.has(language));
  const isShellLang = isKnownLang && SHELL_LANGUAGE_SET.has(language);
  const actuallyShell = isShellLang ? isShellCommand(code) : true;

  let resolvedLang: string;
  if (isShellLang && !actuallyShell) {
    // 显式 shell 语言但代码本体不是 shell → 重新识别，避免误显示 bash
    const detected = detectCodeLanguage(code);
    // 二次保险：detectCodeLanguage 偶尔也会把 import 错判成 bash，
    // 这里再剥掉一次 shell 系列结果，强制回到非 shell 语言
    resolvedLang = detected && !SHELL_LANGUAGE_SET.has(detected)
      ? detected
      : 'text';
  } else if (isKnownLang) {
    resolvedLang = language!;
  } else {
    resolvedLang = detectCodeLanguage(code) || 'text';
  }

  const displayLang = resolvedLang && resolvedLang !== 'text'
    ? (LANGUAGE_DISPLAY_NAMES[resolvedLang] || resolvedLang)
    : '';

  // 构造 Skill 上下文
  const skillCtx: CodeBlockSkillContext = {
    language: resolvedLang,
    code,
    shellOutputs,
    onExecuteShell,
    onKillShell,
    getSkillState: (skillId) => skillStates[skillId],
    setSkillState: (skillId, state) => setSkillStates((prev) => ({ ...prev, [skillId]: state })),
  };

  const matchedSkills = getMatchingSkills(skillCtx);
  const hasActions = matchedSkills.some((s) => s.renderActions);
  // 任意 skill 处于 running 状态时，dots 闪烁
  // （当前只有 shell skill 有 running 概念，未来可扩展）
  const isRunning = matchedSkills.some((s) => {
    const state = skillStates[s.id];
    return state && typeof state === 'object' && 'running' in state ? state.running : false;
  });

  return (
    <div className="codeblock" data-lang={resolvedLang}>
      {displayLang && (
        <div className="codeblock-header">
          <div className={`codeblock-dots ${isRunning ? 'codeblock-dots--running' : ''}`}>
            <Terminal size={12} strokeWidth={2} />
          </div>
          <span className="codeblock-lang">{displayLang}</span>
          <div className="codeblock-header-actions">
            {matchedSkills.map((skill) =>
              skill.renderActions ? (
                <span key={skill.id} className="codeblock-skill-actions">
                  {skill.renderActions(skillCtx)}
                </span>
              ) : null
            )}
            <button
              className={`codeblock-copy codeblock-copy--icon ${copied ? 'codeblock-copy--copied' : ''}`}
              onClick={handleCopy}
              title={copied ? '已复制' : '复制代码'}
            >
              {copied ? <Check size={13} strokeWidth={2.5} /> : <Copy size={13} strokeWidth={2} />}
            </button>
          </div>
        </div>
      )}
      <div className="codeblock-body">
        {resolvedLang === 'text' ? (
          <pre className="codeblock-plain">{code}</pre>
        ) : (
          <SyntaxHighlighter
            language={resolvedLang}
            style={oneDark}
            PreTag="div"
            customStyle={{
              margin: 0,
              background: 'transparent',
              padding: '10px 16px',
              fontSize: '11px',
              lineHeight: '1.55',
            }}
            codeTagProps={{
              style: {
                fontFamily: 'var(--font-mono)',
                fontSize: '11px',
              }
            }}
          >
            {code}
          </SyntaxHighlighter>
        )}
      </div>
      {matchedSkills.map((skill) =>
        skill.renderOutput ? (
          <div key={skill.id}>{skill.renderOutput(skillCtx)}</div>
        ) : null
      )}
    </div>
  );
}
