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
  search: {
    run: (payload) => invoke('search:run', payload || {}),
    fromClipboard: () => invoke('search:fromClipboard'),
    results: () => invoke('search:results'),
    cancel: () => invoke('search:cancel'),
    useCandidate: (index, text) => invoke('search:run', { useTop: index, text: text }),
    openUrl: (url) => invoke('search:openUrl', url),
    copy: (text) => invoke('search:copy', text)
  },
  bank: {
    list: (keyword, limit) => invoke('bank:list', { keyword: keyword, limit: limit }),
    add: (payload) => invoke('bank:add', payload || {}),
    update: (payload) => invoke('bank:update', payload || {}),
    remove: (id) => invoke('bank:remove', id),
    clear: () => invoke('bank:clear'),
    importText: (text) => invoke('bank:importText', text),
    importFile: () => invoke('bank:importFile'),
    exportFile: () => invoke('bank:exportFile')
  },
  aiTest: (cfg) => invoke('ai:test', cfg),
  capture: {
    start: () => invoke('capture:start')
  },
  ocr: {
    rerun: () => invoke('ocr:rerun'),
    test: () => invoke('ocr:test'),
    langs: () => invoke('ocr:langs')
  },
  question: {
    /* 题目只由图片识别产生；这里只用于"识别错了手动修正" */
    set: (text) => invoke('question:set', text)
  },
  autoInput: {
    now: () => invoke('autoInput:now'),
    cancel: () => invoke('autoInput:cancel')
  },
  subject: {
    /* id 传空字符串表示"回到自动识别" */
    set: (id) => invoke('subject:set', id)
  },
  choice: {
    /* 手动点选当前题目的正确选项；payload 可带 answer / hwnd 覆盖缺省值 */
    click: (payload) => invoke('choice:click', payload || {}),
    state: () => invoke('choice:state')
  },
  onState: (cb) => on('state', cb),
  onFg: (cb) => on('fg', cb),
  onAuto: (cb) => on('auto', cb),
  onToast: (cb) => on('toast', cb),
  onDraft: (cb) => on('draft', cb),
  onSearch: (cb) => on('search', cb),
  onOcr: (cb) => on('ocr', cb),
  onQuestion: (cb) => on('question', cb),
  onAutoInput: (cb) => on('autoinput', cb),
  onChoice: (cb) => on('choice', cb)
});
