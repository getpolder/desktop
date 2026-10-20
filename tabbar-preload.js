const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tabs', {
    onState: (callback) => ipcRenderer.on('tabs:state', (_event, state) => callback(state)),
    activate: (id) => ipcRenderer.send('tabs:activate', id),
    close: (id) => ipcRenderer.send('tabs:close', id),
    move: (id, to) => ipcRenderer.send('tabs:move', id, to),
    menu: (id) => ipcRenderer.send('tabs:menu', id),
    hover: (id) => ipcRenderer.send('tabs:hover', id),
    unhover: () => ipcRenderer.send('tabs:unhover'),
    onPreview: (callback) => ipcRenderer.on('tabs:preview', (_event, preview) => callback(preview)),
    create: () => ipcRenderer.send('tabs:new'),
    ready: () => ipcRenderer.send('tabs:ready'),
});
