/**
 * 文件类型分类与二进制嗅探
 *
 * 设计原则：
 * - 单点维护"扩展名 → 预览类型"映射，openFile / TabBar / MediaViewer 共用
 * - 文本文件之外的二进制文件不进 Monaco（utf-8 读取会产生乱码且撑爆内存）
 * - 对扩展名不可信的文件（如网盘临时文件 xxx.png.baiduyun.uploading.cfg）
 *   通过魔数嗅探兜底：二进制内容以只读预览或"无法预览"提示呈现
 */

/** 可预览/识别的文件大类 */
export type FileKind = 'pdf' | 'image' | 'video' | 'audio' | 'binary' | 'text';

/** 图片扩展名 → MIME（svg 除外：svg 是文本，保留在 Monaco 中编辑） */
const IMAGE_MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

/** 视频扩展名 → MIME */
const VIDEO_MIME_MAP: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  m4v: 'video/x-m4v',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
};

/** 音频扩展名 → MIME */
const AUDIO_MIME_MAP: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
};

/** 不走 Monaco 的 language 集合（workspaceSlice 刷新/重载逻辑据此跳过） */
export const BINARY_VIEWER_LANGS: ReadonlySet<string> = new Set(['pdf', 'image', 'video', 'audio', 'binary']);

function getExt(name: string): string {
  const dotIdx = name.lastIndexOf('.');
  if (dotIdx <= 0) return '';
  return name.slice(dotIdx + 1).toLowerCase();
}

/** 按扩展名分类；未识别返回 'text'（交给 Monaco，后续再由内容嗅探兜底） */
export function getFileKind(name: string): FileKind {
  const ext = getExt(name);
  if (!ext) return 'text';
  if (ext === 'pdf') return 'pdf';
  if (ext in IMAGE_MIME_MAP) return 'image';
  if (ext in VIDEO_MIME_MAP) return 'video';
  if (ext in AUDIO_MIME_MAP) return 'audio';
  return 'text';
}

/** 预览用 MIME：优先按扩展名精确匹配，其次按 kind 给兜底值 */
export function getPreviewMime(name: string, kind: FileKind): string {
  const ext = getExt(name);
  switch (kind) {
    case 'pdf':
      return 'application/pdf';
    case 'image':
      return IMAGE_MIME_MAP[ext] || 'image/png';
    case 'video':
      return VIDEO_MIME_MAP[ext] || 'video/mp4';
    case 'audio':
      return AUDIO_MIME_MAP[ext] || 'audio/mpeg';
    default:
      return 'application/octet-stream';
  }
}

/**
 * 内容魔数嗅探：从 utf-8 解码后的文本开头识别真实文件类型。
 *
 * 注意：Node fs.readFile(utf-8) 会把非法字节替换为 U+FFFD，但 ASCII 部分的
 * 魔数（%PDF-、PNG、ftyp、RIFF....WEBP、OggS、ID3）会原样保留，可安全匹配。
 * 用于扩展名不可信的场景（网盘临时文件、无扩展名文件）。
 *
 * @returns 识别出的预览 kind；无法识别返回 null
 */
export function sniffKindFromContent(content: string): FileKind | null {
  if (!content) return null;
  if (content.startsWith('%PDF-')) return 'pdf';
  // PNG: 0x89 被替换为 U+FFFD，其后 'PNG' 为 ASCII
  if (content.charCodeAt(0) === 0xfffd && content.startsWith('PNG', 1)) return 'image';
  // WebP: 'RIFF' + 4 字节长度 + 'WEBP'
  if (content.startsWith('RIFF') && content.slice(8, 12) === 'WEBP') return 'image';
  // GIF: 'GIF87a' / 'GIF89a'
  if (content.startsWith('GIF8')) return 'image';
  // MP4/MOV: 第 5~8 字节为 'ftyp'
  if (content.slice(4, 8) === 'ftyp') return 'video';
  // Ogg 容器（音频/视频，按音频兜底）
  if (content.startsWith('OggS')) return 'audio';
  // MP3 (ID3 标签)
  if (content.startsWith('ID3')) return 'audio';
  return null;
}

/**
 * 二进制内容启发式判断：前 8KB 内出现 NUL 或高比例控制字符即视为二进制。
 * 对标 VSCode 的二进制检测策略。
 */
export function isBinaryContent(content: string): boolean {
  const sampleSize = Math.min(content.length, 8192);
  if (sampleSize === 0) return false;
  let controlCount = 0;
  for (let i = 0; i < sampleSize; i++) {
    const code = content.charCodeAt(i);
    if (code === 0) return true; // NUL 一票否决
    // 控制字符（排除 \t \n \r）与 U+FFFD 替换符
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 0xfffd) {
      controlCount++;
    }
  }
  return controlCount / sampleSize > 0.1;
}
