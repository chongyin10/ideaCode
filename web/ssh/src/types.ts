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
  status: 'connected' | 'disconnected' | 'connecting';
  output: string[];
}

export interface WebviewMessage {
  command: string;
  [key: string]: unknown;
}
