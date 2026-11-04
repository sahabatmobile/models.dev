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

  listModels: () => ipcRenderer.invoke('models:list'),
  startChat: (payload) => ipcRenderer.invoke('chat:start', payload),
  abortChat: (requestId) => ipcRenderer.invoke('chat:abort', requestId),
  completeChat: (payload) => ipcRenderer.invoke('chat:complete', payload),
  onChunk: subscribe('chat:chunk'),
  onDone: subscribe('chat:done'),
  onError: subscribe('chat:error'),

  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  workspaceInfo: () => ipcRenderer.invoke('workspace:info'),
  workspaceTree: () => ipcRenderer.invoke('workspace:tree'),
  readFile: (path) => ipcRenderer.invoke('fs:read', path),
  writeFile: (path, content) => ipcRenderer.invoke('fs:write', { path, content }),
  removeFile: (path) => ipcRenderer.invoke('fs:remove', path),

  startTerminal: (payload) => ipcRenderer.invoke('term:start', payload),
  terminalInput: (id, data) => ipcRenderer.invoke('term:input', { id, data }),
  stopTerminal: (id) => ipcRenderer.invoke('term:stop', id),
  onTermData: subscribe('term:data'),
  onTermExit: subscribe('term:exit'),

  agentListDir: (dir) => ipcRenderer.invoke('agent:listDir', dir),
  agentReadFile: (path) => ipcRenderer.invoke('agent:readFile', path),
  agentWriteFile: (path, content) => ipcRenderer.invoke('agent:writeFile', { path, content }),
  agentRunCommand: (command, cwd, timeoutMs) => ipcRenderer.invoke('agent:runCommand', { command, cwd, timeoutMs }),

  sshConnect: (cfg) => ipcRenderer.invoke('ssh:connect', cfg),
  sshShell: (id, cols, rows) => ipcRenderer.invoke('ssh:shell', { id, cols, rows }),
  sshInput: (id, data) => ipcRenderer.invoke('ssh:input', { id, data }),
  sshResize: (id, cols, rows) => ipcRenderer.invoke('ssh:resize', { id, cols, rows }),
  sshListDir: (id, dir) => ipcRenderer.invoke('ssh:listDir', { id, dir }),
  sshReadFile: (id, path) => ipcRenderer.invoke('ssh:readFile', { id, path }),
  sshWriteFile: (id, path, content) => ipcRenderer.invoke('ssh:writeFile', { id, path, content }),
  sshDisconnect: (id) => ipcRenderer.invoke('ssh:disconnect', id),
  onSshData: subscribe('ssh:data'),
  onSshExit: subscribe('ssh:exit'),
  onSshClosed: subscribe('ssh:closed')
});
