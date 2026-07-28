import { useEffect, useState } from 'react';
import { FileWarning, FileQuestion } from 'lucide-react';
import { convertToHtml } from 'mammoth';
import type { FileSource } from '../../services/fileService';
import { readFileBase64 } from '../../services/fileService';
import { getPreviewMime, type FileKind } from '../../utils/fileType';
import './MediaViewer.css';

interface MediaViewerProps {
  /** 文件源：本地路径 / FileSystemHandle */
  source: FileSource;
  name: string;
  /** 预览类型：pdf / image / video / audio / word；binary 表示无法预览的二进制 */
  kind: Exclude<FileKind, 'text'>;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const KIND_LABEL: Record<string, string> = {
  pdf: 'PDF',
  image: '图片',
  video: '视频',
  audio: '音频',
  word: 'Word',
  binary: '二进制',
};

/**
 * 通用二进制文件预览：
 * - pdf   → Blob URL + iframe（Chromium 内置 PDFium 查看器，需 webPreferences.plugins = true）
 * - image → Blob URL + <img>
 * - video → Blob URL + <video controls>
 * - audio → Blob URL + <audio controls>
 * - word  → mammoth 解析 docx 为 HTML 渲染（仅 .docx；旧版 .doc 走 binary 兜底）
 * - binary → 不可预览的兜底提示页（不读取内容）
 */
export default function MediaViewer({ source, name, kind }: MediaViewerProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [wordHtml, setWordHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (kind === 'binary') return;
    let cancelled = false;
    let url: string | null = null;

    readFileBase64(source)
      .then(async (base64) => {
        if (cancelled) return;
        if (kind === 'word') {
          // mammoth 把 docx 转成 HTML（内嵌图片转为 data URL），直接渲染
          const bytes = base64ToBytes(base64);
          const result = await convertToHtml({ arrayBuffer: bytes.buffer as ArrayBuffer });
          if (cancelled) return;
          setWordHtml(result.value);
          setError(null);
          return;
        }
        url = URL.createObjectURL(new Blob([base64ToBytes(base64).buffer as ArrayBuffer], { type: getPreviewMime(name, kind) }));
        setBlobUrl(url);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [source, name, kind]);

  if (kind === 'binary') {
    return (
      <div className="media-viewer media-viewer--message">
        <FileQuestion size={32} strokeWidth={1.5} />
        <p>{name}</p>
        <p className="media-viewer__detail">该文件是二进制文件，暂不支持预览</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="media-viewer media-viewer--message">
        <FileWarning size={32} strokeWidth={1.5} />
        <p>无法预览 {name}</p>
        <p className="media-viewer__detail">{error}</p>
      </div>
    );
  }

  if (kind === 'word') {
    if (wordHtml === null) {
      return (
        <div className="media-viewer media-viewer--message">
          <p>加载中…</p>
        </div>
      );
    }
    return (
      <div className="media-viewer">
        <div className="media-viewer__doc-scroll">
          {/* mammoth 输出为可信的文档结构 HTML（无脚本），直接注入渲染 */}
          <div className="media-viewer__doc" dangerouslySetInnerHTML={{ __html: wordHtml }} />
        </div>
      </div>
    );
  }

  if (!blobUrl) {
    return (
      <div className="media-viewer media-viewer--message">
        <p>加载中…</p>
      </div>
    );
  }

  return (
    <div className="media-viewer">
      {kind === 'pdf' && (
        <iframe className="media-viewer__frame" src={blobUrl} title={name} />
      )}
      {kind === 'image' && (
        <div className="media-viewer__scroll">
          <img className="media-viewer__image" src={blobUrl} alt={name} />
        </div>
      )}
      {kind === 'video' && (
        <div className="media-viewer__center">
          <video className="media-viewer__video" src={blobUrl} controls title={KIND_LABEL.video} />
        </div>
      )}
      {kind === 'audio' && (
        <div className="media-viewer__center">
          <audio src={blobUrl} controls />
        </div>
      )}
    </div>
  );
}
