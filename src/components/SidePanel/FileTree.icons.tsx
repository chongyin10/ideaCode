import { memo } from 'react';
import {
  FileText, FileCode, FileImage, Globe,
  Braces, Coffee, Palette, Terminal, Settings,
  LucideIcon,
} from 'lucide-react';

/* ─── 文件图标映射 ─── */

interface FileIconConfig {
  Icon: LucideIcon;
  color: string;
}

/** 按扩展名和文件名匹配 */
function getExtConfig(name: string): FileIconConfig | null {
  const lower = name.toLowerCase();
  const dotIdx = lower.lastIndexOf('.');
  const ext = dotIdx >= 0 ? lower.slice(dotIdx + 1) : '';

  // 特殊文件名匹配
  if (lower === 'package.json' || lower === 'package-lock.json' || lower === 'tsconfig.json') {
    return { Icon: Braces, color: '#f5a623' };
  }
  if (lower === '.gitignore' || lower === '.gitattributes' || lower === '.editorconfig') {
    return { Icon: Settings, color: '#f14e32' };
  }
  if (lower.startsWith('.env')) {
    return { Icon: Settings, color: '#ecd157' };
  }
  if (lower === 'readme.md' || lower === 'changelog.md' || lower === 'license') {
    return { Icon: FileText, color: '#42a5f5' };
  }

  // 扩展名匹配
  switch (ext) {
    // TypeScript
    case 'ts':  return { Icon: FileCode, color: '#3178c6' };
    case 'tsx': return { Icon: FileCode, color: '#61dafb' };

    // JavaScript
    case 'js':  return { Icon: FileCode, color: '#f0db4f' };
    case 'jsx': return { Icon: FileCode, color: '#f0db4f' };
    case 'mjs': return { Icon: FileCode, color: '#f0db4f' };
    case 'cjs': return { Icon: FileCode, color: '#f0db4f' };

    // CSS & preprocessors
    case 'css':   return { Icon: Palette, color: '#2965f1' };
    case 'scss':  return { Icon: Palette, color: '#cc6699' };
    case 'sass':  return { Icon: Palette, color: '#cc6699' };
    case 'less':  return { Icon: Palette, color: '#1d365d' };

    // HTML
    case 'html': return { Icon: Globe, color: '#e44d26' };
    case 'htm':  return { Icon: Globe, color: '#e44d26' };

    // JSON
    case 'json': return { Icon: Braces, color: '#f5a623' };

    // Markdown
    case 'md':   return { Icon: FileText, color: '#42a5f5' };
    case 'mdx':  return { Icon: FileText, color: '#42a5f5' };

    // Python
    case 'py':   return { Icon: Terminal, color: '#3776ab' };

    // Java
    case 'java': return { Icon: Coffee, color: '#b07219' };
    case 'class': return { Icon: Coffee, color: '#b07219' };
    case 'jar':   return { Icon: Coffee, color: '#b07219' };

    // Images
    case 'png':  return { Icon: FileImage, color: '#4caf50' };
    case 'jpg':  return { Icon: FileImage, color: '#4caf50' };
    case 'jpeg': return { Icon: FileImage, color: '#4caf50' };
    case 'gif':  return { Icon: FileImage, color: '#4caf50' };
    case 'svg':  return { Icon: FileImage, color: '#ff9800' };
    case 'webp': return { Icon: FileImage, color: '#4caf50' };
    case 'ico':  return { Icon: FileImage, color: '#4caf50' };
    case 'bmp':  return { Icon: FileImage, color: '#4caf50' };

    // Config / other
    case 'yml':  return { Icon: Settings, color: '#6b8e23' };
    case 'yaml': return { Icon: Settings, color: '#6b8e23' };
    case 'toml': return { Icon: Settings, color: '#6b8e23' };
    case 'xml':  return { Icon: Braces, color: '#f5a623' };
    case 'sql':  return { Icon: Braces, color: '#336791' };
    case 'sh':   return { Icon: Terminal, color: '#4eaa25' };
    case 'bash': return { Icon: Terminal, color: '#4eaa25' };
    case 'zsh':  return { Icon: Terminal, color: '#4eaa25' };
    case 'bat':  return { Icon: Terminal, color: '#cccccc' };
    case 'cmd':  return { Icon: Terminal, color: '#cccccc' };
    case 'ps1':  return { Icon: Terminal, color: '#0078d6' };

    // Documents
    case 'txt':  return { Icon: FileText, color: '#888888' };
    case 'log':  return { Icon: FileText, color: '#888888' };
    case 'pdf':  return { Icon: FileText, color: '#e74c3c' };

    // Lock files
    case 'lock': return { Icon: Settings, color: '#888888' };

    // Git
    case 'gitignore': return { Icon: Settings, color: '#f14e32' };

    default: return null;
  }
}

/* ─── 图标组件 ─── */

interface FileIconProps {
  name: string;
  kind: 'file' | 'directory';
  expanded?: boolean;
}

export const FileIcon = memo(({ name, kind, expanded }: FileIconProps) => {
  if (kind === 'directory') {
    return expanded ? (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
        <path d="M2 10h20" />
      </svg>
    ) : (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
      </svg>
    );
  }

  const config = getExtConfig(name);
  if (config) {
    return <config.Icon size={14} strokeWidth={1.5} color={config.color} />;
  }
  // fallback: 无扩展名匹配时使用默认图标
  return <FileText size={14} strokeWidth={1.5} color="#888888" />;
});
FileIcon.displayName = 'FileIcon';

/** 文件夹闭合图标（用于内联创建） */
export const ClosedFolderIcon = memo(() => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
  </svg>
));
ClosedFolderIcon.displayName = 'ClosedFolderIcon';

/** 默认文件图标（无扩展名匹配时的 fallback） */
export const DefaultFileIcon = memo(() => (
  <FileText size={14} strokeWidth={1.5} color="#888888" />
));
DefaultFileIcon.displayName = 'DefaultFileIcon';
