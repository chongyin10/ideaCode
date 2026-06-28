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

interface CodeBlockProps {
  language: string;
  children: React.ReactNode;
}

export function CodeBlock({ language, children }: CodeBlockProps) {
  // 从 ShellContext 获取 shell 执行能力（绕过 ReactMarkdown prop 链）
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

  // 语言归一化：已注册用原值，未注册尝试自动检测，最后回退 text
  const isKnownLang = language && REGISTERED_LANGUAGES.has(language);
  const detectedLang = !isKnownLang ? detectCodeLanguage(code) : undefined;
  const resolvedLang = isKnownLang ? language : (detectedLang || 'text');
  const displayLang = isKnownLang
    ? (LANGUAGE_DISPLAY_NAMES[language] || language)
    : (detectedLang ? (LANGUAGE_DISPLAY_NAMES[detectedLang] || detectedLang) : '');

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
