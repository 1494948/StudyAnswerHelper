'use strict';
/* 渲染进程桥：只暴露白名单 API，渲染层拿不到 Node */
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, payload) => ipcRenderer.invoke(ch, payload);
const on = (evt, cb) => {
  const handler = (_e, data) => { try { cb(data); } catch (e) { console.error(e); } };
  ipcRenderer.on(evt, handler);
  return () => ipcRenderer.removeListener(evt, handler);
};

contextBridge.exposeInMainWorld('sp', {
  getState: () => invoke('app:getState'),
  setSettings: (patch) => invoke('app:setSettings', patch),
  setDraft: (text) => invoke('app:setDraft', text),
  cleanText: (text) => invoke('app:cleanText', text),
  probe: () => invoke('app:probe'),
  clipboardRead: () => invoke('app:clipboardRead'),
  openDataDir: () => invoke('app:openDataDir'),
  quit: () => invoke('app:quit'),
  restartEngine: () => invoke('app:restartEngine'),
  addCurrentToMatch: () => invoke('match:addCurrent'),
  inputNow: () => invoke('input:now'),
  inputNext: () => invoke('input:next'),
  inputCancel: () => invoke('input:cancel'),
  autoSet: (on2) => invoke('auto:set', !!on2),
  autoCancel: () => invoke('auto:cancel'),
  themeApply: (mode) => invoke('theme:apply', mode),
  queue: {
    add: (label, text) => invoke('queue:add', { label: label, text: text }),
    update: (id, patch) => invoke('queue:update', { id: id, patch: patch }),
    remove: (id) => invoke('queue:remove', id),
    clear: () => invoke('queue:clear'),
    setIndex: (i) => invoke('queue:setIndex', i),
    setMode: (on2) => invoke('queue:setMode', !!on2)
  },
  history: {
    clear: () => invoke('history:clear'),
    remove: (at) => invoke('history:remove', at)
  },
  onState: (cb) => on('state', cb),
  onFg: (cb) => on('fg', cb),
  onAuto: (cb) => on('auto', cb),
  onToast: (cb) => on('toast', cb),
  onDraft: (cb) => on('draft', cb)
});
