const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('zivbotDesktop', {
  platform: process.platform,
  lanUrl: () => ipcRenderer.invoke('lan-url'),
});
