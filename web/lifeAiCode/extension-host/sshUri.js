/**
 * SSH URI 解析与构造工具
 *
 * 项目中的 SSH 资源使用统一格式：
 *   ssh://<connectionId><absoluteRemotePath>
 *
 * 例如：ssh://my-server/home/user/project/src/index.js
 *
 * 注意：路径部分是远端绝对路径，前面没有额外斜杠（即 <connectionId> 后直接跟 /home/...）。
 */

const SSH_SCHEME = 'ssh';

/**
 * 判断一个值是否为 SSH URI 字符串
 * @param {string} uri
 * @returns {boolean}
 */
function isRemoteUri(uri) {
  return typeof uri === 'string' && uri.startsWith(`${SSH_SCHEME}://`);
}

/**
 * 解析 SSH URI
 * @param {string} uri
 * @returns {{ isRemote: boolean, scheme?: string, connectionId?: string, remotePath?: string, fsPath?: string }}
 */
function parseSshUri(uri) {
  if (!isRemoteUri(uri)) {
    return { isRemote: false };
  }
  const content = uri.slice(`${SSH_SCHEME}://`.length);
  // connectionId 不能包含斜杠；第一个斜杠之后就是远端绝对路径
  const slashIdx = content.indexOf('/');
  if (slashIdx === -1) {
    return {
      isRemote: true,
      scheme: SSH_SCHEME,
      connectionId: content,
      remotePath: '/',
      fsPath: content,
    };
  }
  const connectionId = content.slice(0, slashIdx);
  const remotePath = content.slice(slashIdx);
  return {
    isRemote: true,
    scheme: SSH_SCHEME,
    connectionId,
    remotePath,
    fsPath: content,
  };
}

/**
 * 构造 SSH URI
 * @param {string} connectionId
 * @param {string} remotePath 远端绝对路径
 * @returns {string}
 */
function buildSshUri(connectionId, remotePath) {
  const normalizedPath = remotePath.startsWith('/') ? remotePath : `/${remotePath}`;
  return `${SSH_SCHEME}://${connectionId}${normalizedPath}`;
}

module.exports = {
  isRemoteUri,
  parseSshUri,
  buildSshUri,
  SSH_SCHEME,
};
