const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sahabat', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (payload) => ipcRenderer.invoke('settings:set', payload),
  copyKey: () => ipcRenderer.invoke('settings:copyKey'),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  listModels: () => ipcRenderer.invoke('models:list'),
  startChat: (payload) => ipcRenderer.invoke('chat:start', payload),
  abortChat: (requestId) => ipcRenderer.invoke('chat:abort', requestId),
  onChunk: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('chat:chunk', listener);
    return () => ipcRenderer.removeListener('chat:chunk', listener);
  },
  onDone: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('chat:done', listener);
    return () => ipcRenderer.removeListener('chat:done', listener);
  },
  onError: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('chat:error', listener);
    return () => ipcRenderer.removeListener('chat:error', listener);
  }
});
