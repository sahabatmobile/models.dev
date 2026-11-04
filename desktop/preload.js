const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel) {
  return (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('sahabat', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (payload) => ipcRenderer.invoke('settings:set', payload),
  copyKey: () => ipcRenderer.invoke('settings:copyKey'),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  entryCopy: (payload) => ipcRenderer.invoke('entry:copy', payload),
  entryMove: (payload) => ipcRenderer.invoke('entry:move', payload),

  listModels: () => ipcRenderer.invoke('models:list'),
  startChat: (payload) => ipcRenderer.invoke('chat:start', payload),
  abortChat: (requestId) => ipcRenderer.invoke('chat:abort', requestId),
  completeChat: (payload) => ipcRenderer.invoke('chat:complete', payload),
  onChunk: subscribe('chat:chunk'),
  onDone: subscribe('chat:done'),
  onError: subscribe('chat:error'),

  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  cloneRepo: (url, dir) => ipcRenderer.invoke('repo:clone', { url, dir }),
  workspaceInfo: () => ipcRenderer.invoke('workspace:info'),
  workspaceTree: () => ipcRenderer.invoke('workspace:tree'),
  readFile: (path) => ipcRenderer.invoke('fs:read', path),
  writeFile: (path, content) => ipcRenderer.invoke('fs:write', { path, content }),
  mkdir: (path) => ipcRenderer.invoke('fs:mkdir', path),
  removeFile: (path) => ipcRenderer.invoke('fs:remove', path),

  startTerminal: (payload) => ipcRenderer.invoke('term:start', payload),
  terminalInput: (id, data) => ipcRenderer.invoke('term:input', { id, data }),
  stopTerminal: (id) => ipcRenderer.invoke('term:stop', id),
  onTermData: subscribe('term:data'),
  onTermExit: subscribe('term:exit'),

  remoteConnect: (cfg) => ipcRenderer.invoke('remote:connect', cfg),
  remoteListDir: (id, dir) => ipcRenderer.invoke('remote:listDir', { id, dir }),
  remoteReadFile: (id, path) => ipcRenderer.invoke('remote:readFile', { id, path }),
  remoteWriteFile: (id, path, content) => ipcRenderer.invoke('remote:writeFile', { id, path, content }),
  remoteMkdir: (id, path) => ipcRenderer.invoke('remote:mkdir', { id, path }),
  remoteRemove: (id, path, dir) => ipcRenderer.invoke('remote:remove', { id, path, dir }),
  remoteShell: (id, cols, rows) => ipcRenderer.invoke('remote:shell', { id, cols, rows }),
  remoteInput: (id, data) => ipcRenderer.invoke('remote:input', { id, data }),
  remoteResize: (id, cols, rows) => ipcRenderer.invoke('remote:resize', { id, cols, rows }),
  remoteDisconnect: (id) => ipcRenderer.invoke('remote:disconnect', id),
  onRemoteData: subscribe('remote:data'),
  onRemoteExit: subscribe('remote:exit'),
  onRemoteClosed: subscribe('remote:closed'),

  agentListDir: (dir, target) => ipcRenderer.invoke('agent:listDir', { dir, target }),
  agentReadFile: (path, target) => ipcRenderer.invoke('agent:readFile', { path, target }),
  agentWriteFile: (path, content, target) => ipcRenderer.invoke('agent:writeFile', { path, content, target }),
  agentRunCommand: (command, cwd, timeoutMs, target) => ipcRenderer.invoke('agent:runCommand', { command, cwd, timeoutMs, target })
});
