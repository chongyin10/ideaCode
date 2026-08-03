/**
 * 统一扩展上下文
 *
 * 为扩展提供标准化的 API 接口。
 * 底层通过 ServiceBus 与各个服务通信。
 * 替代现有的 4 套互不兼容的 API (git api.js, ssh api.js, lifeAiCode api.js, PluginContext)
 */

import type { IServiceBus } from '@ideacode/kernel';
import type {
  ExtensionContext as IExtensionContext,
  ExtensionManifest,
  Disposable,
  Uri,
  WebviewPanel,
  Webview,
  ExtensionStorage,
  SecretStorage,
  WindowApi,
  WorkspaceApi,
  CommandApi,
  EditorApi,
  TerminalApi,
  FileSystemApi,
  LanguageApi,
  EnvironmentApi,
  WorkspaceConfiguration,
  TextDocument,
  TextEditor,
  Terminal,
} from '@ideacode/types';

class UriImpl implements Uri {
  readonly scheme: string;
  readonly fsPath: string;

  constructor(scheme: string, fsPath: string) {
    this.scheme = scheme;
    this.fsPath = fsPath;
  }

  toString(): string { return `${this.scheme}://${this.fsPath}`; }
}

export class ExtensionContextImpl implements IExtensionContext {
  readonly extensionId: string;
  readonly extensionPath: string;
  readonly extensionUri: Uri;
  readonly globalState: ExtensionStorage;
  readonly workspaceState: ExtensionStorage;
  readonly secrets: SecretStorage;
  readonly subscriptions: Disposable[] = [];
  readonly window: WindowApi;
  readonly workspace: WorkspaceApi;
  readonly commands: CommandApi;
  readonly editor: EditorApi;
  readonly terminal: TerminalApi;
  readonly fs: FileSystemApi;
  readonly languages: LanguageApi;
  readonly env: EnvironmentApi;

  private bus: IServiceBus;

  constructor(bus: IServiceBus, manifest: ExtensionManifest, extPath: string) {
    this.bus = bus;
    this.extensionId = manifest.name || manifest.id;
    this.extensionPath = extPath;
    this.extensionUri = new UriImpl('file', extPath);

    // 存储
    this.globalState = this._createStorage(this.extensionId);
    this.workspaceState = this._createStorage(`workspace:${this.extensionId}`);
    this.secrets = this._createSecrets();

    // 子 API
    this.window = this._createWindowApi();
    this.workspace = this._createWorkspaceApi();
    this.commands = this._createCommandApi();
    this.editor = this._createEditorApi();
    this.terminal = this._createTerminalApi();
    this.fs = this._createFileSystemApi();
    this.languages = this._createLanguageApi();
    this.env = this._createEnvApi();
  }

  private _createStorage(prefix: string): ExtensionStorage {
    return {
      get: async <T>(key: string, defaultValue?: T) => {
        const result = await this.bus.request<{ value: T }>('storage', 'get', { prefix, key, defaultValue });
        return result?.value ?? defaultValue as T;
      },
      update: async (key: string, value: unknown) => {
        await this.bus.request('storage', 'set', { prefix, key, value });
      },
    };
  }

  private _createSecrets(): SecretStorage {
    return {
      get: async (key: string) => {
        const result = await this.bus.request<{ value?: string }>('secrets', 'get', {
          extensionId: this.extensionId, key,
        });
        return result?.value;
      },
      store: async (key: string, value: string) => {
        await this.bus.request('secrets', 'store', { extensionId: this.extensionId, key, value });
      },
      delete: async (key: string) => {
        await this.bus.request('secrets', 'delete', { extensionId: this.extensionId, key });
      },
    };
  }

  // ─── Window API ───

  private _createWindowApi(): WindowApi {
    const self = this;
    return {
      showInformationMessage(message, ...items) {
        return self.bus.request('window', 'showInformationMessage', { message, items });
      },
      showErrorMessage(message, ...items) {
        return self.bus.request('window', 'showErrorMessage', { message, items });
      },
      showWarningMessage(message, ...items) {
        return self.bus.request('window', 'showWarningMessage', { message, items });
      },
      createWebviewPanel(viewType, title, showOptions, options) {
        const panelId = `webview-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        self.bus.notify('webview', 'create', {
          id: panelId, viewType, title,
          showOptions: showOptions || {},
          options: {
            ...options,
            extensionId: options?.extensionId || self.extensionId,
            extensionPath: options?.extensionPath || self.extensionPath,
          },
        });

        const webview: Webview = {
          html: '',
          options: options || {},
          cspSource: 'ideacode-webview-resource:',
          postMessage(message) {
            self.bus.notify('webview', 'postMessage', { id: panelId, message });
          },
          get onDidReceiveMessage() {
            return (listener: (data: unknown) => void) => {
              const unsub = self.bus.subscribe(`webview:${panelId}:message`, listener);
              return { dispose: unsub.dispose };
            };
          },
          asWebviewUri(localResource) {
            return `ideacode-webview-resource://${localResource.fsPath}`;
          },
        };

        return {
          id: panelId,
          viewType,
          title,
          webview,
          reveal() { self.bus.notify('webview', 'reveal', { id: panelId }); },
          dispose() { self.bus.notify('webview', 'dispose', { id: panelId }); },
          get onDidDispose() {
            return ((_listener: () => void) => {
              return { dispose: () => {} };
            }) as any;
          },
          get onDidChangeViewState() {
            return ((_listener: (data: { active: boolean; visible: boolean }) => void) => {
              return { dispose: () => {} };
            }) as any;
          },
        } as WebviewPanel;
      },
      createTerminal(options) {
        const name = options?.name || 'Terminal';
        const tabId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        self.bus.notify('terminal', 'create', { ...options, tabId, name });
        return {
          name,
          processId: Promise.resolve(0),
          sendText(text, addNewLine = true) {
            self.bus.notify('terminal', 'sendInput', { tabId, text: addNewLine ? text + '\n' : text });
          },
          show() { self.bus.notify('terminal', 'show', { tabId }); },
          hide() { self.bus.notify('terminal', 'hide', {}); },
          dispose() { self.bus.notify('terminal', 'dispose', { tabId }); },
          get onDidWrite() {
            return (listener: (data: string) => void) => {
              return self.bus.subscribe(`terminal:${tabId}:output`, listener);
            };
          },
          get onDidClose() {
            return (listener: () => void) => {
              return self.bus.subscribe(`terminal:${tabId}:exit`, listener);
            };
          },
        } as Terminal;
      },
      showInputBox(options) {
        return self.bus.request('window', 'showInputBox', options);
      },
      showQuickPick(items, options) {
        return self.bus.request('window', 'showQuickPick', { items, options });
      },
      showOpenDialog(options) {
        return self.bus.request('window', 'showOpenDialog', options);
      },
      showSaveDialog(options) {
        return self.bus.request('window', 'showSaveDialog', options);
      },
      registerTreeDataProvider(viewId, treeDataProvider) {
        self.bus.notify('tree', 'register', { viewId, treeDataProvider });
        return { dispose: () => { self.bus.notify('tree', 'unregister', { viewId }); } };
      },
      registerWebviewViewProvider(viewId, _provider) {
        self.bus.notify('webviewView', 'register', { viewId });
        return { dispose: () => { self.bus.notify('webviewView', 'unregister', { viewId }); } };
      },
      setStatusBarMessage(text, hideAfterTimeout) {
        const id = `ext-status-${self.extensionId}`;
        self.bus.notify('ui', 'statusBar.update', { id, text });
        if (hideAfterTimeout) {
          setTimeout(() => {
            self.bus.notify('ui', 'statusBar.hide', { id });
          }, hideAfterTimeout);
        }
        return { dispose: () => { self.bus.notify('ui', 'statusBar.hide', { id }); } };
      },
    };
  }

  // ─── Workspace API ───

  private _createWorkspaceApi(): WorkspaceApi {
    const self = this;
    return {
      getConfiguration(section) {
        return {
          get<T>(key: string, defaultValue?: T): T {
            // 同步 get 降级为默认值；扩展应直接使用 bus.request
            return defaultValue as T;
          },
          async update(key: string, value: unknown) {
            await self.bus.request('configuration', 'set', { section, key, value });
          },
          has(_key: string): boolean {
            return false;
          },
          inspect<_T>(_key: string) {
            return undefined;
          },
        } as WorkspaceConfiguration;
      },
      openTextDocument(uri) {
        return self.bus.request('workspace', 'openTextDocument', { uri });
      },
      saveAll() {
        return self.bus.request('workspace', 'saveAll', {});
      },
      getWorkspaceFolders() {
        return self.bus.request('workspace', 'getWorkspaceFolders', {});
      },
      registerFileSystemProvider(scheme, _provider) {
        self.bus.notify('workspace', 'registerFileSystemProvider', { scheme, extensionId: self.extensionId });
        return { dispose: () => { self.bus.notify('workspace', 'unregisterFileSystemProvider', { scheme }); } };
      },
      get onDidChangeConfiguration() {
        return (listener: () => void) => self.bus.subscribe('workspace:configChange', listener);
      },
      get onDidOpenTextDocument() {
        return (listener: (doc: TextDocument) => void) => self.bus.subscribe('workspace:didOpen', listener);
      },
      get onDidCloseTextDocument() {
        return (listener: (doc: TextDocument) => void) => self.bus.subscribe('workspace:didClose', listener);
      },
      get onDidSaveTextDocument() {
        return (listener: (doc: TextDocument) => void) => self.bus.subscribe('workspace:didSave', listener);
      },
    };
  }

  // ─── Command API ───

  private _createCommandApi(): CommandApi {
    const self = this;
    return {
      registerCommand(command, handler) {
        const fullMethod = `command.${command}`;
        self.bus.handle(fullMethod, async (params: unknown) => {
          const p = params as { args?: unknown[] };
          return handler(...(p?.args || []));
        });
        return { dispose: () => { self.bus.removeHandler(fullMethod); } };
      },
      executeCommand(command, ...args) {
        return self.bus.request('commands', 'execute', { command, args });
      },
      getCommands() {
        return self.bus.request('commands', 'getCommands', {});
      },
    };
  }

  // ─── Editor API ───

  private _createEditorApi(): EditorApi {
    const self = this;
    return {
      getActiveTextEditor() {
        return undefined; // 异步，需要 await
      },
      getVisibleTextEditors() {
        return [];
      },
      get onDidChangeActiveTextEditor() {
        return (listener: (editor: TextEditor | undefined) => void) =>
          self.bus.subscribe('editor:activeChange', listener);
      },
    };
  }

  // ─── Terminal API ───

  private _createTerminalApi(): TerminalApi {
    const self = this;
    return {
      createTerminal(options) {
        return self.window.createTerminal(options);
      },
      get onDidCloseTerminal() {
        return (listener: (term: Terminal) => void) =>
          self.bus.subscribe('terminal:didClose', listener);
      },
    };
  }

  // ─── FileSystem API ───

  private _createFileSystemApi(): FileSystemApi {
    const self = this;
    return {
      readFile(uri) {
        return self.bus.request('fs', 'readFile', { path: uri.fsPath });
      },
      writeFile(uri, content) {
        return self.bus.request('fs', 'writeFile', { path: uri.fsPath, content });
      },
      createDirectory(uri) {
        return self.bus.request('fs', 'createDir', { path: uri.fsPath });
      },
      delete(uri, options) {
        return self.bus.request('fs', 'delete', { path: uri.fsPath, recursive: options?.recursive });
      },
      rename(source, target, options) {
        return self.bus.request('fs', 'rename', { oldPath: source.fsPath, newPath: target.fsPath, overwrite: options?.overwrite });
      },
      stat(uri) {
        return self.bus.request('fs', 'stat', { path: uri.fsPath });
      },
      readDirectory(uri) {
        return self.bus.request('fs', 'readDir', { path: uri.fsPath });
      },
    };
  }

  // ─── Language API ───

  private _createLanguageApi(): LanguageApi {
    return {
      registerCompletionItemProvider(_selector, _provider) {
        return { dispose: () => {} };
      },
      registerHoverProvider(_selector, _provider) {
        return { dispose: () => {} };
      },
      registerDefinitionProvider(_selector, _provider) {
        return { dispose: () => {} };
      },
      registerDocumentSemanticTokensProvider(_selector, _provider) {
        return { dispose: () => {} };
      },
    };
  }

  // ─── Environment API ───

  private _createEnvApi(): EnvironmentApi {
    const self = this;
    return {
      appName: 'IDEACODE',
      appRoot: '',
      language: 'zh-CN',
      shell: '',
      clipboard: {
        writeText(text) { return self.bus.request('env', 'clipboard.writeText', { text }); },
        readText() { return self.bus.request<string>('env', 'clipboard.readText', {}); },
      },
      openExternal(uri) {
        return self.bus.request<boolean>('env', 'openExternal', { uri: uri.toString() });
      },
    };
  }
}
