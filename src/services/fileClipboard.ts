import type { FileSource } from './fileService';

export interface FileClipboardItem {
  source: FileSource;
  name: string;
  kind: 'file' | 'directory';
  parentSource: FileSource;
  action: 'cut' | 'copy';
}

export interface FileClipboardState {
  action: 'cut' | 'copy';
  items: FileClipboardItem[];
}

let fileClipboard: FileClipboardState | null = null;

export function setFileClipboard(action: 'cut' | 'copy', items: FileClipboardItem[]) {
  fileClipboard = { action, items };
}

export function getFileClipboard(): FileClipboardState | null {
  return fileClipboard;
}

export function clearFileClipboard() {
  fileClipboard = null;
}
