// File System Access API type declarations

interface FileSystemHandle {
  kind: 'file' | 'directory';
  name: string;
}

interface FileSystemFileHandle extends FileSystemHandle {
  kind: 'file';
  getFile(): Promise<File>;
}

interface FileSystemDirectoryHandle extends FileSystemHandle {
  kind: 'directory';
  values(): AsyncIterableIterator<FileSystemHandle>;
}

interface Window {
  showDirectoryPicker(): Promise<FileSystemDirectoryHandle>;
  showOpenFilePicker(): Promise<FileSystemFileHandle[]>;
}
