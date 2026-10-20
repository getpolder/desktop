const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tabs', {
    onState: (callback) => ipcRenderer.on('tabs:state', (_event, state) => callback(state)),
    activate: (id) => ipcRenderer.send('tabs:activate', id),
    close: (id) => ipcRenderer.send('tabs:close', id),
    create: () => ipcRenderer.send('tabs:new'),
    ready: () => ipcRenderer.send('tabs:ready'),
});
