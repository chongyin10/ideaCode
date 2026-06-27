export interface SshConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  authType: 'password' | 'key';
}

export interface SshSession {
  id: string;
  connectionId: string;
  name: string;
  status: 'connected' | 'disconnected' | 'connecting' | 'failed';
  output: string[];
}

export interface WebviewMessage {
  command: string;
  /** sshLog 消息的级别：log / info / error，控制操作日志渲染颜色 */
  level?: string;
  [key: string]: unknown;
}
