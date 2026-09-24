'use strict';
/* 框选截图窗口的桥：只暴露三个动作 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cap', {
  onBg: (cb) => ipcRenderer.on('capture:bg', (_e, d) => { try { cb(d); } catch (e) { console.error(e); } }),
  onFail: (cb) => ipcRenderer.on('capture:fail', (_e, msg) => { try { cb(String(msg)); } catch (e) { console.error(e); } }),
  done: (rect) => ipcRenderer.send('capture:done', rect || {}),
  cancel: () => ipcRenderer.send('capture:cancel')
});
