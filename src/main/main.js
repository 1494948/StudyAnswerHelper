'use strict';
/* ------------------------------------------------------------------
 * 学习通答题助手 — 主进程
 *   主界面：大输入框 + 答案队列 + 历史 + 设置 + 搜答案
 *   触发：全局热键（默认 Ctrl+Alt+Enter）/ 自动模式（切到学习通后倒计时输入）
 *   输入：交给 engine/input-engine.js 子进程（koffi + SendInput 逐字输入）
 *   搜答案：lib/answer-search.js（本地题库 / 网络检索 / AI 解答 三源合一）
 * ------------------------------------------------------------------ */
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

const electron = require('electron');
if (!electron.app) {
  /* 本机 shell 环境可能设了 ELECTRON_RUN_AS_NODE，需要先清除再启动 */
  process.stderr.write('检测到 ELECTRON_RUN_AS_NODE，请清除该环境变量后再启动。\n');
  process.exit(1);
}
const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, shell, nativeTheme, clipboard, Notification, screen, dialog } = electron;

/* 打包后代码封在 app.asar 里，但"原生模块 / 图标 / 可被 fork 执行的脚本"必须是真实文件，
   所以统一走这个函数：优先取 app.asar.unpacked 下的同名解包副本。 */
function unpackAware(p) {
  const u = String(p).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  return (u !== p && fs.existsSync(u)) ? u : p;
}

/* ---------------- 日志 ---------------- */
const SMOKE_LOG = process.env.SP_SMOKE_LOG || process.env.SP_LOG || null;
function logLine(s) {
  const line = '[' + new Date().toISOString().slice(11, 19) + '] ' + s;
  if (SMOKE_LOG) { try { fs.appendFileSync(SMOKE_LOG, line + '\n', 'utf8'); } catch (_) { /* 忽略 */ } }
  try { console.log(line); } catch (_) { /* 忽略 */ }
}

/* ---------------- 测试模式：数据隔离（必须在单实例锁之前） ---------------- */
const TEST_MODE = !!(process.env.SP_SELFTEST || process.env.SP_SMOKE || process.env.SP_SHOT || process.env.SP_SEARCHTEST);
let TEST_DIR = null;
if (TEST_MODE) {
  TEST_DIR = path.join(app.getPath('temp'), 'study-answer-helper-test');
  try { fs.mkdirSync(TEST_DIR, { recursive: true }); } catch (_) { /* 忽略 */ }
  app.setPath('userData', TEST_DIR);
  /* 所有测试模式都从干净状态开始：
     - 断言才有确定性，不会读到上一轮残留的题库/草稿
     - 截图模式也不会把用户的真实答案内容截进公开的 preview 图里（截图用的演示数据在 runShots 里现造） */
  for (const name of ['answer-data.json', 'answer-bank.json']) {
    const f = path.join(TEST_DIR, name);
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) { /* 忽略 */ }
  }
}
if (SMOKE_LOG) {
  try { fs.writeFileSync(SMOKE_LOG, '', 'utf8'); } catch (_) { /* 忽略 */ }
  process.on('uncaughtException', (e) => logLine('UNCAUGHT ' + (e && e.stack ? e.stack : String(e))));
  process.on('unhandledRejection', (e) => logLine('UNHANDLED ' + (e && e.stack ? e.stack : String(e))));
}

const gotLock = TEST_MODE ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

/* ---------------- 状态与持久化 ---------------- */
const { Store } = require('./lib/store');

const DEFAULT_STATE = {
  settings: {
    autoMode: false,
    countdownSec: 3,
    charDelayMs: 15,
    cleanup: 'light',
    refocus: true,
    clearFirst: false,
    beep: true,
    notify: false,
    minimizeToTray: true,
    autoLaunch: false,
    hotkeyMain: 'c-alt-enter',
    hotkeyNext: 'c-alt-down',
    matchTitles: ['学习通', '超星', 'chaoxing', 'xuexitong'],
    matchProcs: ['学习通', 'chaoxing', 'xuexitong', 'xxt'],
    theme: 'system',

    /* ---- 搜答案 ---- */
    searchLocal: true,          /* 查本地题库 */
    searchWeb: true,            /* 联网检索 */
    searchAi: false,            /* 调 AI 解答（需要配置密钥） */
    searchEngine: 'auto',       /* auto | sogou | so360 | bing */
    searchMinScore: 0.55,       /* 本地题库命中阈值 */
    searchTopN: 6,              /* 返回候选条数 */
    searchTimeoutMs: 20000,     /* 单个网络请求超时 */
    searchAutoFill: true,       /* 高可信答案自动填进大框 */
    searchAutoFillScore: 0.92,  /* 自动填入的分数门槛 */
    hotkeySearch: 'c-alt-f',    /* 从剪贴板取题搜索 */

    /* ---- AI 解答（OpenAI 兼容 /chat/completions） ---- */
    aiBaseUrl: 'https://api.deepseek.com/v1',
    aiApiKey: '',
    aiModel: 'deepseek-chat',
    aiMaxTokens: 1200,
    aiTemperature: 0.2
  },
  draft: '',
  queue: [],
  queueIndex: 0,
  queueMode: false,
  history: []
};

const store = new Store(path.join(app.getPath('userData'), 'answer-data.json'), DEFAULT_STATE);
let S = store.all();

/* 本地题库：离线答案源，落盘在 userData/answer-bank.json */
const { AnswerBank } = require('./lib/answer-bank');
const searchLib = require('./lib/answer-search');
const bank = new AnswerBank(path.join(app.getPath('userData'), 'answer-bank.json'));

const HOTKEY_PRESETS = {
  'c-alt-enter': { label: 'Ctrl + Alt + Enter', accel: 'Control+Alt+Return' },
  'c-alt-s': { label: 'Ctrl + Alt + S', accel: 'Control+Alt+S' },
  'c-shift-enter': { label: 'Ctrl + Shift + Enter', accel: 'Control+Shift+Return' },
  'f9': { label: 'F9', accel: 'F9' }
};
const HOTKEY_NEXT_PRESETS = {
  'c-alt-down': { label: 'Ctrl + Alt + ↓', accel: 'Control+Alt+Down' },
  'c-alt-right': { label: 'Ctrl + Alt + →', accel: 'Control+Alt+Right' },
  'f10': { label: 'F10', accel: 'F10' }
};
const HOTKEY_SEARCH_PRESETS = {
  'c-alt-f': { label: 'Ctrl + Alt + F', accel: 'Control+Alt+F' },
  'c-alt-q': { label: 'Ctrl + Alt + Q', accel: 'Control+Alt+Q' },
  'f8': { label: 'F8', accel: 'F8' }
};
const SEARCH_ENGINE_OPTIONS = {
  auto: '自动（搜狗 → 360 → 必应）',
  sogou: '只用搜狗',
  so360: '只用 360',
  bing: '只用必应'
};
const SEARCH_SCORE_OPTIONS = { 0.45: '宽松（0.45）', 0.55: '标准（0.55）', 0.65: '严格（0.65）', 0.75: '很严格（0.75）' };
const SEARCH_TOP_OPTIONS = { 4: '4 条', 6: '6 条', 10: '10 条' };
const CLEANUP_LEVELS = {
  none: '不处理',
  light: '去首尾空白 + 合并空行',
  medium: '再合并行内多余空格',
  strong: '全部合并成一行'
};
const DELAY_OPTIONS = { 5: '很快（5ms/字）', 10: '快（10ms/字）', 15: '标准（15ms/字）', 30: '稳妥（30ms/字）', 60: '很稳（60ms/字）' };

function saveState() {
  S = store.all();
  store.flush();
}

/* ---------------- 内容清理 ---------------- */
function cleanupText(text, level) {
  let t = String(text === undefined || text === null ? '' : text).replace(/\r\n?/g, '\n');
  if (!level || level === 'none') return t;
  let lines = t.split('\n').map((s) => s.replace(/^[ \t\u3000]+/, '').replace(/[ \t\u3000]+$/, ''));
  const out = [];
  let blank = 0;
  for (const l of lines) {
    if (!l) {
      blank++;
      if (blank > 1) continue;
    } else {
      blank = 0;
    }
    out.push(l);
  }
  lines = out;
  if (level === 'medium' || level === 'strong') {
    lines = lines.map((l) => l.replace(/[ \t\u3000]{2,}/g, ' '));
  }
  let res = lines.join('\n');
  if (level === 'strong') res = res.split('\n').filter((s) => s !== '').join(' ');
  return res.replace(/^\n+/, '').replace(/\n+$/, '');
}

/* ---------------- 全局运行时状态 ---------------- */
let mainWin = null;
let tray = null;
let isQuitting = false;
let targetWin = null;            /* 仅冒烟测试用 */
let engine = null;
let engineReady = false;
let engineError = '';
let engineSeq = 0;
let engineRestarts = 0;
const pendingTypes = new Map();
let fg = { hwnd: 0, title: '', pid: 0, proc: '', matched: false, self: false, by: '', keyword: '' };
let lastMatchedHwnd = 0;
let wasMatched = false;
let lastToastAt = 0;
const auto = { active: false, remain: 0, timer: null, lastFireAt: 0, hwnd: 0 };
let lastInsert = { at: 0, ok: false, msg: '' };
let hotkeyStatus = { mainOk: false, nextOk: false, searchOk: false };

/* ---------------- 搜答案运行时状态 ---------------- */
const searchState = {
  active: false,
  seq: 0,
  at: 0,
  ms: 0,
  question: '',
  count: 0,
  engine: '',
  engineId: '',
  errors: [],
  candidates: [],
  query: ''
};

const settings = () => S.settings || DEFAULT_STATE.settings;

const SOURCE_LABEL = { local: '本地题库', web: '网络检索', ai: 'AI 解答' };

/* ---------------- 输入引擎 ---------------- */
function enginePath() {
  /* 打包后优先用解包副本：asar 内的脚本无法被 fork 直接执行 */
  return unpackAware(path.join(__dirname, 'engine', 'input-engine.js'));
}

function startEngine() {
  const p = enginePath();
  if (!fs.existsSync(p)) {
    engineError = '未找到输入引擎文件：' + p;
    logLine(engineError);
    return;
  }
  try {
    engine = fork(p, [], {
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
      execPath: process.execPath,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
      cwd: path.dirname(p)
    });
  } catch (e) {
    engineError = '输入引擎启动失败：' + (e && e.message ? e.message : String(e));
    logLine(engineError);
    return;
  }
  engine.on('message', onEngineMessage);
  if (engine.stdout) engine.stdout.on('data', (d) => logLine('engine.out ' + String(d).trim()));
  if (engine.stderr) engine.stderr.on('data', (d) => logLine('engine.err ' + String(d).trim()));
  engine.on('exit', (code, sig) => {
    engineReady = false;
    engine = null;
    logLine('输入引擎退出 code=' + code + ' sig=' + sig);
    if (!isQuitting && engineRestarts < 5) {
      engineRestarts++;
      setTimeout(() => { if (!isQuitting) startEngine(); }, 1200);
    } else if (!isQuitting) {
      engineError = '输入引擎反复退出，请重启程序';
    }
    pushState();
  });
  engine.on('error', (e) => {
    engineError = '输入引擎错误：' + (e && e.message ? e.message : String(e));
    logLine(engineError);
  });
}

function sendEngineConfig() {
  if (!engine || !engine.connected) return;
  const st = settings();
  engine.send({
    type: 'config',
    cfg: {
      matchTitles: st.matchTitles,
      matchProcs: st.matchProcs,
      selfPids: process.env.SP_SMOKE ? [] : [process.pid],
      pollMs: 220,
      watchEsc: true
    }
  });
}

function onEngineMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'ready') {
    engineReady = !!msg.ok;
    engineError = msg.ok ? '' : (msg.err || '输入引擎初始化失败');
    logLine('engine ready=' + msg.ok + (msg.ok ? '' : ' err=' + msg.err));
    sendEngineConfig();
    pushState();
  } else if (msg.type === 'fg') {
    onForeground(msg);
  } else if (msg.type === 'typed') {
    const cb = pendingTypes.get(msg.id);
    if (cb) {
      pendingTypes.delete(msg.id);
      cb(msg);
    }
  } else if (msg.type === 'esc') {
    if (auto.active) {
      autoCancel('已按 Esc 取消');
    }
  } else if (msg.type === 'fatal') {
    engineError = '输入引擎异常：' + msg.err;
    logLine(engineError);
    pushState();
  }
}

function engineType(opts) {
  return new Promise((resolve) => {
    if (!engine || !engineReady || !engine.connected) {
      resolve({ ok: false, err: '输入引擎未就绪' });
      return;
    }
    const id = ++engineSeq;
    const timer = setTimeout(() => {
      if (pendingTypes.has(id)) {
        pendingTypes.delete(id);
        resolve({ ok: false, err: '输入超时' });
      }
    }, 120000);
    pendingTypes.set(id, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
    engine.send({
      type: 'type',
      id: id,
      text: opts.text,
      delayMs: opts.delayMs,
      clearFirst: !!opts.clearFirst,
      watchEsc: true
    });
  });
}

function engineFocus(hwnd) {
  if (!engine || !engine.connected || !hwnd) return;
  try { engine.send({ type: 'focus', hwnd: hwnd }); } catch (_) { /* 忽略 */ }
}

/* ---------------- 前台窗口 / 自动模式 ---------------- */
function onForeground(ev) {
  const prevHwnd = fg.hwnd;
  fg = {
    hwnd: ev.hwnd || 0,
    title: ev.title || '',
    pid: ev.pid || 0,
    proc: ev.proc || '',
    matched: !!ev.matched,
    self: !!ev.self,
    by: ev.by || '',
    keyword: ev.keyword || ''
  };
  if (ev.lastMatchedHwnd) lastMatchedHwnd = ev.lastMatchedHwnd;
  if (fg.matched) lastMatchedHwnd = fg.hwnd;
  if (prevHwnd !== fg.hwnd) logLine('前台窗口 → [' + fg.proc + '] ' + fg.title + (fg.matched ? '  ★命中' : ''));
  pushState();

  const st = settings();
  if (!st.autoMode) {
    if (auto.active) autoCancel('自动模式已关闭');
    wasMatched = fg.matched;
    return;
  }
  if (fg.matched && !wasMatched) {
    if (Date.now() - auto.lastFireAt < 8000) {
      /* 刚自动输入过，同一窗口不重复打扰 */
    } else if (!currentRawText().trim()) {
      toast('自动模式：内容为空，已跳过（先在大框里写答案）');
    } else {
      autoStart(fg);
    }
  }
  wasMatched = fg.matched;
}

function autoStart(ev) {
  if (auto.active) return;
  const st = settings();
  auto.active = true;
  auto.remain = Math.max(1, parseInt(st.countdownSec, 10) || 3);
  auto.hwnd = ev.hwnd;
  beep(true);
  sendAuto();
  auto.timer = setInterval(() => {
    if (!settings().autoMode) { autoCancel('自动模式已关闭'); return; }
    if (!fg.matched || fg.hwnd !== auto.hwnd) { autoCancel('已切换到其他窗口'); return; }
    auto.remain--;
    if (auto.remain <= 0) {
      clearInterval(auto.timer);
      auto.timer = null;
      auto.active = false;
      auto.lastFireAt = Date.now();
      sendAuto();
      doInsert('auto');
      return;
    }
    sendAuto();
  }, 1000);
}

function autoCancel(why) {
  if (auto.timer) { clearInterval(auto.timer); auto.timer = null; }
  if (!auto.active && !why) return;
  auto.active = false;
  auto.remain = 0;
  sendAuto(why);
}

function sendAuto(why) {
  send('auto', { active: auto.active, remain: auto.remain, why: why || '' });
}

function beep(soft) {
  if (!settings().beep) return;
  try { shell.beep(); } catch (_) { /* 忽略 */ }
  if (!soft) return;
}

/* ---------------- 文本 / 插入 ---------------- */
function queueList() {
  return Array.isArray(S.queue) ? S.queue : [];
}
function queueIndex() {
  const n = queueList().length;
  const i = parseInt(S.queueIndex, 10) || 0;
  return Math.min(Math.max(0, i), Math.max(0, n - 1));
}
function currentRawText() {
  const st = settings();
  if (S.queueMode && queueList().length) {
    const item = queueList()[queueIndex()];
    if (item) return item.text || '';
  }
  return S.draft || '';
}

function toast(msg, kind) {
  lastToastAt = Date.now();
  send('toast', { msg: msg, kind: kind || 'info' });
}

function pushHistory(text) {
  const list = Array.isArray(S.history) ? S.history.slice() : [];
  if (list.length && list[0].text === text) {
    list[0].at = Date.now();
  } else {
    list.unshift({ text: text, at: Date.now() });
  }
  S.history = list.slice(0, 40);
  store.set('history', S.history);
}

async function doInsert(reason) {
  if (!engineReady) {
    toast('输入引擎未就绪：' + (engineError || '正在启动'), 'error');
    return { ok: false, err: 'engine-not-ready' };
  }
  const raw = currentRawText();
  if (!raw || !raw.trim()) {
    toast('内容是空的，先在左边大框里写答案', 'error');
    return { ok: false, err: 'empty' };
  }
  const st = settings();
  const text = cleanupText(raw, st.cleanup);
  if (!text) {
    toast('清理后内容为空，请检查内容', 'error');
    return { ok: false, err: 'empty-after-clean' };
  }

  /* 若当前焦点不在学习通（例如还停在本程序），先把学习通窗口切回来 */
  if (st.refocus && lastMatchedHwnd && !fg.matched) {
    logLine('重新聚焦学习通窗口 hwnd=' + lastMatchedHwnd);
    engineFocus(lastMatchedHwnd);
    await delay(300);
  }

  const res = await engineType({ text: text, delayMs: st.charDelayMs, clearFirst: !!st.clearFirst });
  lastInsert = { at: Date.now(), ok: !!res.ok, msg: res.err || (res.aborted ? '已取消' : '') };

  if (res.ok) {
    pushHistory(text);
    if (S.queueMode && queueList().length) {
      const list = queueList().slice();
      const i = queueIndex();
      if (list[i]) { list[i].text = text; list[i].usedAt = Date.now(); }
      let nextIdx = i;
      if (i < list.length - 1) nextIdx = i + 1;
      S.queue = list;
      S.queueIndex = nextIdx;
      store.set('queue', list);
      store.set('queueIndex', nextIdx);
      if (nextIdx === i && i === list.length - 1) {
        toast('已输入（已是最后一条）', 'ok');
      } else {
        toast('已输入，自动装入第 ' + (nextIdx + 1) + ' 条', 'ok');
      }
      setDraftFromQueue();
    } else {
      toast('已输入 ' + text.length + ' 个字', 'ok');
    }
    beep(false);
    logLine('输入完成 ' + res.sent + ' 字 / ' + res.ms + 'ms (' + reason + ')');
  } else if (res.aborted) {
    toast('已按 Esc 取消输入', 'warn');
  } else {
    toast('输入失败：' + (res.err || '未知原因'), 'error');
  }
  pushState();
  return res;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function setDraftFromQueue() {
  if (!S.queueMode) return;
  const item = queueList()[queueIndex()];
  S.draft = item ? (item.text || '') : '';
  store.set('draft', S.draft);
  send('draft', S.draft);
}

/* ================= 搜答案 ================= */

/** 把文本写进大框（与界面双向同步，走的是和队列同一条链路） */
function setDraftText(text) {
  const t = typeof text === 'string' ? text : String(text === undefined || text === null ? '' : text);
  S.draft = t.slice(0, 20000);
  store.set('draft', S.draft);
  send('draft', S.draft);
  return S.draft;
}

/** 设置对象给渲染层时要脱敏：AI 密钥不能出主进程 */
function publicSettings() {
  const st = Object.assign({}, settings());
  st.aiKeySet = !!String(st.aiApiKey || '').trim();
  st.aiKeyHint = st.aiKeySet ? ('已保存（尾号 ' + String(st.aiApiKey).slice(-4) + '）') : '';
  delete st.aiApiKey;
  return st;
}

function publicSearch(withCandidates) {
  const out = {
    active: searchState.active,
    at: searchState.at,
    ms: searchState.ms,
    question: searchState.question,
    count: searchState.count,
    engine: searchState.engine,
    errors: searchState.errors,
    query: searchState.query,
    bankCount: bank.count(),
    engines: searchLib.engineStatus()
  };
  if (withCandidates) out.candidates = searchState.candidates;
  return out;
}

/** 用当前设置拼出检索参数 */
function searchOptions(override) {
  const st = settings();
  const o = override || {};
  return {
    sources: o.sources || {
      local: !!st.searchLocal,
      web: !!st.searchWeb,
      ai: !!st.searchAi
    },
    engine: st.searchEngine || 'auto',
    minScore: Number(st.searchMinScore) || 0.55,
    topN: parseInt(st.searchTopN, 10) || 6,
    timeoutMs: parseInt(st.searchTimeoutMs, 10) || 20000,
    ai: {
      apiKey: st.aiApiKey,
      baseUrl: st.aiBaseUrl,
      model: st.aiModel,
      maxTokens: st.aiMaxTokens,
      temperature: Number(st.aiTemperature)
    }
  };
}

/**
 * 执行一次检索。
 * payload: { question }            —— 用界面上的题目框内容
 *          { fromClipboard: true }  —— 从剪贴板取题（配合搜题热键）
 *          { sources, useTop }      —— 覆盖来源 / 直接采用第 N 条
 */
async function runSearchNow(payload) {
  const p = payload || {};
  const st = settings();
  const raw = p.fromClipboard ? clipboard.readText() : String(p.question || '');
  const question = String(raw || '').trim();

  /* 直接采用某条候选（结果列表上的"填入大框"） */
  if (p.useTop !== undefined && p.useTop !== null) {
    const idx = parseInt(p.useTop, 10) || 0;
    const c = searchState.candidates[idx];
    if (!c) return { ok: false, err: '候选不存在' };
    const text = String(p.text || c.answer || '');
    if (!text.trim()) return { ok: false, err: '这条候选没有可填入的答案' };
    setDraftText(text);
    if (c.source === 'local' && c.id) bank.touch(c.id);
    toast('已填入大框（' + (SOURCE_LABEL[c.source] || c.source) + '）', 'ok');
    pushState();
    return { ok: true, text: text };
  }

  if (!question) {
    toast(p.fromClipboard
      ? '剪贴板里没有文字。先在题目上按 Ctrl+C 复制，再按搜题热键'
      : '题目是空的，先把题目贴进「题目」框', 'warn');
    return { ok: false, err: 'empty-question' };
  }
  if (searchState.active) {
    toast('上一次搜索还没结束，请稍候…', 'warn');
    return { ok: false, err: 'busy' };
  }

  const opts = searchOptions(p);
  const id = ++searchState.seq;
  searchState.active = true;
  searchState.question = question;
  searchState.errors = [];
  searchState.candidates = [];
  searchState.count = 0;
  searchState.query = searchLib.cleanQuestion(question, 100);
  searchState.at = Date.now();
  pushState();
  send('search', publicSearch(true));

  let res = null;
  try {
    res = await searchLib.runSearch({
      question: question,
      sources: opts.sources,
      bank: bank,
      engine: opts.engine,
      minScore: opts.minScore,
      topN: opts.topN,
      timeoutMs: opts.timeoutMs,
      ai: opts.ai
    });
  } catch (e) {
    res = {
      ok: false,
      err: '检索过程出错：' + (e && e.message ? e.message : String(e)),
      candidates: [], errors: [], ms: 0
    };
  }

  if (id !== searchState.seq) return { ok: false, err: 'stale' };   /* 已有更新的检索，丢弃本次 */

  searchState.active = false;
  searchState.at = Date.now();
  searchState.ms = res.ms || 0;
  searchState.errors = res.errors || [];

  if (!res.ok) {
    searchState.candidates = [];
    searchState.count = 0;
    toast(res.err || '搜索失败', 'error');
    pushState();
    send('search', publicSearch(true));
    return res;
  }

  const list = res.candidates || [];
  searchState.candidates = list;
  searchState.count = list.length;
  searchState.engine = (res.meta && res.meta.web && res.meta.web.engine) || '';
  searchState.query = (res.meta && res.meta.web && res.meta.web.query) || searchState.query;

  if (!list.length) {
    toast(searchState.errors.length
      ? '没有找到候选答案（' + searchState.errors[0] + '）'
      : '没有找到候选答案，换一种题目写法再试试', 'warn');
  } else {
    const top = list[0];
    const pct = Math.round((top.score || 0) * 100);
    toast('找到 ' + list.length + ' 条候选，最相关 ' + pct + '%（' + (SOURCE_LABEL[top.source] || top.source) + '）', 'ok');
    /* 高可信的单条答案自动填进大框，省一次点击 */
    const threshold = Number(st.searchAutoFillScore) || 0.92;
    if (st.searchAutoFill && top.kind === 'answer' && top.answer && (top.score || 0) >= threshold) {
      setDraftText(top.answer);
      toast('已自动填入大框：' + String(top.answer).slice(0, 30), 'ok');
      if (top.source === 'local' && top.id) bank.touch(top.id);
    }
  }

  send('search', publicSearch(true));
  pushState();
  logLine('检索完成 ' + list.length + ' 条 / ' + searchState.ms + 'ms / ' + (searchState.engine || '无网络结果'));
  return res;
}

/** 把"当前题目 + 大框里的答案"存进本地题库 */
function saveCurrentToBank(payload) {
  const p = payload || {};
  const question = String(p.question || searchState.question || '').trim();
  const answer = String(p.answer !== undefined && p.answer !== null ? p.answer : currentRawText() || '');
  if (!question) return { ok: false, err: '题目是空的，先搜一次或把题目贴进题目框' };
  if (!answer.trim()) return { ok: false, err: '答案是空的，先把答案写进大框' };
  const r = bank.add({ question: question, answer: answer, note: p.note, source: p.source || 'manual' });
  if (r.ok) {
    bank.flush();          /* 立刻落盘：用户点完就关程序也不该丢 */
    toast(r.updated ? '题库里已有这道题，答案已更新' : '已存进题库', 'ok');
  } else {
    toast('存入题库失败：' + r.err, 'error');
  }
  pushState();
  return r;
}

async function exportBank() {
  const win = (mainWin && !mainWin.isDestroyed()) ? mainWin : null;
  const def = path.join(app.getPath('documents'), '学习通题库-' + new Date().toISOString().slice(0, 10) + '.json');
  let r = null;
  try {
    r = await dialog.showSaveDialog(win, {
      title: '导出题库',
      defaultPath: def,
      filters: [{ name: 'JSON 文件', extensions: ['json'] }]
    });
  } catch (e) {
    return { ok: false, err: '打开保存对话框失败：' + (e && e.message ? e.message : String(e)) };
  }
  if (!r || r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(r.filePath, bank.exportJson(), 'utf8');
    toast('已导出 ' + bank.count() + ' 条到 ' + r.filePath, 'ok');
    return { ok: true, path: r.filePath, count: bank.count() };
  } catch (e) {
    return { ok: false, err: '写入失败：' + (e && e.message ? e.message : String(e)) };
  }
}

async function importBankFile() {
  const win = (mainWin && !mainWin.isDestroyed()) ? mainWin : null;
  let r = null;
  try {
    r = await dialog.showOpenDialog(win, {
      title: '选择题库文件',
      properties: ['openFile'],
      filters: [{ name: 'JSON 文件', extensions: ['json'] }]
    });
  } catch (e) {
    return { ok: false, err: '打开文件对话框失败：' + (e && e.message ? e.message : String(e)) };
  }
  if (!r || r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
  let text = '';
  try {
    text = fs.readFileSync(r.filePaths[0], 'utf8');
  } catch (e) {
    return { ok: false, err: '读取失败：' + (e && e.message ? e.message : String(e)) };
  }
  const res = bank.importJson(text);
  if (res.ok) toast('导入完成：新增 ' + res.added + ' 条，更新 ' + res.updated + ' 条', 'ok');
  else toast('导入失败：' + res.err, 'error');
  pushState();
  return Object.assign({ path: r.filePaths[0] }, res);
}

/* ---------------- 窗口 ---------------- */
const THEME_COLORS = {
  light: { bg: '#eef1f6', bar: '#ffffff', symbol: '#5a6a7d' },
  dark: { bg: '#0f141b', bar: '#161d26', symbol: '#a7b4c4' }
};
function resolvedTheme() {
  const pref = settings().theme || 'system';
  if (pref === 'dark') return 'dark';
  if (pref === 'light') return 'light';
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}
function applyThemeToWindow() {
  if (!mainWin || mainWin.isDestroyed()) return;
  const mode = resolvedTheme();
  const c = THEME_COLORS[mode];
  try { mainWin.setBackgroundColor(c.bg); } catch (_) { /* 忽略 */ }
  try {
    mainWin.setTitleBarOverlay({ color: c.bar, symbolColor: c.symbol, height: 46 });
  } catch (_) { /* 忽略 */ }
}

function createWindow() {
  const mode = resolvedTheme();
  const c = THEME_COLORS[mode];
  mainWin = new BrowserWindow({
    width: 1100, height: 720, minWidth: 940, minHeight: 600,
    show: false,
    backgroundColor: c.bg,
    title: '学习通答题助手',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: c.bar, symbolColor: c.symbol, height: 46 },
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      /* 本程序的使用方式就是"常驻后台、人在学习通界面操作"。
         开着后台节流时，窗口一被挡住的渲染进程定时器会被降频到约 1 秒：
         自动模式的倒计时数字会卡、草稿落盘会延迟、提示条会晚出现。
         这些延迟在"后台常驻"这个核心场景里都是要避免的，所以关掉。 */
      backgroundThrottling: false
    }
  });
  mainWin.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWin.once('ready-to-show', () => {
    if (!process.env.SP_SHOT) mainWin.show();
  });
  mainWin.on('close', (e) => {
    if (!isQuitting && settings().minimizeToTray) {
      e.preventDefault();
      mainWin.hide();
      toast('已收起到托盘，双击托盘图标可重新打开');
      pushState();
      return;
    }
    if (!isQuitting && !TEST_MODE) {
      isQuitting = true;
      app.quit();
    }
  });
  mainWin.on('closed', () => { mainWin = null; });
  mainWin.webContents.on('render-process-gone', (e, d) => logLine('render-process-gone ' + JSON.stringify(d)));
}

function applyLoginItem() {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({ openAtLogin: !!settings().autoLaunch, path: process.execPath, args: [] });
  } catch (e) {
    logLine('设置开机自启失败：' + (e && e.message));
  }
}

function updateTray() {
  if (!tray) return;
  const st = settings();
  tray.setToolTip('学习通答题助手 · ' + (engineReady ? '就绪' : '引擎未就绪'));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showMain() },
    { type: 'separator' },
    { label: '输入到学习通（' + hotkeyLabel(st.hotkeyMain) + '）', click: () => doInsert('tray') },
    { label: '答案队列：下一条（' + hotkeyLabel(st.hotkeyNext, true) + '）', click: () => useNext() },
    { type: 'separator' },
    { label: '搜答案：从剪贴板取题（' + hotkeyLabel(st.hotkeySearch, false, true) + '）', click: () => { showMain(); setTimeout(() => runSearchNow({ fromClipboard: true }), 150); } },
    { type: 'separator' },
    {
      label: '自动模式（切到学习通就自动输入）',
      type: 'checkbox',
      checked: !!st.autoMode,
      click: (mi) => setAutoMode(!!mi.checked)
    },
    { type: 'separator' },
    { label: '打开数据文件夹', click: () => shell.openPath(app.getPath('userData')) },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } }
  ]));
}

function hotkeyLabel(id, next, search) {
  const map = search ? HOTKEY_SEARCH_PRESETS : (next ? HOTKEY_NEXT_PRESETS : HOTKEY_PRESETS);
  return (map[id] || {}).label || '未设置';
}

function showMain() {
  if (!mainWin) { createWindow(); return; }
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

function createTray() {
  const ico = path.join(__dirname, '..', '..', 'assets', 'tray.ico');
  try {
    tray = new Tray(ico);
  } catch (e) {
    logLine('托盘创建失败：' + (e && e.message));
    return;
  }
  tray.on('double-click', () => showMain());
  tray.on('click', () => showMain());
  updateTray();
}

/* ---------------- 全局热键 ---------------- */
function registerShortcuts() {
  globalShortcut.unregisterAll();
  const st = settings();
  const mainAccel = (HOTKEY_PRESETS[st.hotkeyMain] || HOTKEY_PRESETS['c-alt-enter']).accel;
  const nextAccel = (HOTKEY_NEXT_PRESETS[st.hotkeyNext] || HOTKEY_NEXT_PRESETS['c-alt-down']).accel;
  const searchAccel = (HOTKEY_SEARCH_PRESETS[st.hotkeySearch] || HOTKEY_SEARCH_PRESETS['c-alt-f']).accel;
  try { hotkeyStatus.mainOk = globalShortcut.register(mainAccel, () => doInsert('hotkey')); } catch (_) { hotkeyStatus.mainOk = false; }
  try { hotkeyStatus.nextOk = globalShortcut.register(nextAccel, () => useNext()); } catch (_) { hotkeyStatus.nextOk = false; }
  /* 搜题热键：把窗口带到前面，然后从剪贴板取题搜索 —— 老师在学习通上复制题目后直接按这个键 */
  try {
    hotkeyStatus.searchOk = globalShortcut.register(searchAccel, () => {
      showMain();
      setTimeout(() => { runSearchNow({ fromClipboard: true }); }, 180);
    });
  } catch (_) { hotkeyStatus.searchOk = false; }
  if (!hotkeyStatus.mainOk) logLine('主热键注册失败：' + mainAccel);
  if (!hotkeyStatus.nextOk) logLine('下一条热键注册失败：' + nextAccel);
  if (!hotkeyStatus.searchOk) logLine('搜题热键注册失败：' + searchAccel);
}

function useNext() {
  const list = queueList();
  if (!list.length) {
    toast('答案队列是空的', 'warn');
    return { ok: false, err: 'empty-queue' };
  }
  if (!S.queueMode) {
    S.queueMode = true;
    S.queueIndex = Math.max(0, queueIndex());
    store.set('queueMode', true);
    store.set('queueIndex', S.queueIndex);
  }
  const i = queueIndex();
  if (i < list.length - 1) {
    S.queueIndex = i + 1;
    store.set('queueIndex', S.queueIndex);
  }
  setDraftFromQueue();
  pushState();
  return { ok: true, index: queueIndex() };
}

/* ---------------- 状态广播 ---------------- */
function publicState() {
  const st = settings();
  return {
    settings: publicSettings(),
    draft: S.draft || '',
    queue: queueList(),
    queueIndex: queueIndex(),
    queueMode: !!S.queueMode,
    history: Array.isArray(S.history) ? S.history : [],
    engine: { ready: engineReady, error: engineError },
    fg: fg,
    lastMatchedHwnd: lastMatchedHwnd,
    auto: { active: auto.active, remain: auto.remain },
    search: publicSearch(false),
    hotkeys: {
      main: hotkeyLabel(st.hotkeyMain),
      next: hotkeyLabel(st.hotkeyNext, true),
      search: hotkeyLabel(st.hotkeySearch, false, true),
      mainOk: hotkeyStatus.mainOk,
      nextOk: hotkeyStatus.nextOk,
      searchOk: hotkeyStatus.searchOk
    },
    presets: {
      main: Object.keys(HOTKEY_PRESETS).map((k) => ({ id: k, label: HOTKEY_PRESETS[k].label })),
      next: Object.keys(HOTKEY_NEXT_PRESETS).map((k) => ({ id: k, label: HOTKEY_NEXT_PRESETS[k].label })),
      search: Object.keys(HOTKEY_SEARCH_PRESETS).map((k) => ({ id: k, label: HOTKEY_SEARCH_PRESETS[k].label }))
    },
    labels: {
      cleanup: CLEANUP_LEVELS,
      delay: DELAY_OPTIONS,
      searchEngine: SEARCH_ENGINE_OPTIONS,
      searchScore: SEARCH_SCORE_OPTIONS,
      searchTop: SEARCH_TOP_OPTIONS
    },
    dataFile: path.join(app.getPath('userData'), 'answer-data.json'),
    bankFile: path.join(app.getPath('userData'), 'answer-bank.json'),
    version: app.getVersion(),
    lastInsert: lastInsert,
    testMode: TEST_MODE
  };
}

function pushState() {
  send('state', publicState());
}

function send(evt, data) {
  if (mainWin && !mainWin.isDestroyed() && mainWin.webContents) {
    try { mainWin.webContents.send(evt, data); } catch (_) { /* 忽略 */ }
  }
}

function setAutoMode(on) {
  const st = settings();
  st.autoMode = !!on;
  store.set('settings.autoMode', !!on);
  if (!on) autoCancel('手动关闭');
  updateTray();
  pushState();
  toast(on ? '自动模式已开启：切到学习通后 ' + (parseInt(st.countdownSec, 10) || 3) + ' 秒自动输入' : '自动模式已关闭', on ? 'ok' : 'info');
}

/* ---------------- IPC ---------------- */
function registerIpc() {
  ipcMain.handle('app:getState', () => publicState());

  ipcMain.handle('app:setSettings', (e, patch) => {
    const allowed = Object.keys(DEFAULT_STATE.settings);
    const st = settings();
    for (const k of Object.keys(patch || {})) {
      if (allowed.indexOf(k) < 0) continue;
      st[k] = patch[k];
    }
    store.set('settings', st);
    S = store.all();
    if (patch && ('hotkeyMain' in patch || 'hotkeyNext' in patch || 'hotkeySearch' in patch)) registerShortcuts();
    if (patch && 'autoLaunch' in patch) applyLoginItem();
    if (patch && 'theme' in patch) applyThemeToWindow();
    if (patch && 'matchTitles' in patch) sendEngineConfig();
    if (patch && 'matchProcs' in patch) sendEngineConfig();
    updateTray();
    pushState();
    return publicState();
  });

  ipcMain.handle('app:setDraft', (e, text) => {
    S.draft = typeof text === 'string' ? text : '';
    store.set('draft', S.draft);
    return true;
  });

  ipcMain.handle('app:cleanText', (e, text) => cleanupText(text, settings().cleanup));

  /* 自检用：直接读磁盘文件，验证"真的落盘了"而不是只存在内存里 */
  ipcMain.handle('app:probe', () => {
    const file = path.join(app.getPath('userData'), 'answer-data.json');
    let disk = null;
    try { disk = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { disk = null; }
    let bankDisk = null;
    try { bankDisk = JSON.parse(fs.readFileSync(bank.file, 'utf8')); } catch (e) { bankDisk = null; }
    const items = bankDisk && Array.isArray(bankDisk.items) ? bankDisk.items : [];
    return {
      file: file,
      hasFile: !!disk,
      draft: disk ? disk.draft : null,
      queueLen: disk && Array.isArray(disk.queue) ? disk.queue.length : 0,
      cleanup: disk && disk.settings ? disk.settings.cleanup : null,
      matchTitles: disk && disk.settings ? disk.settings.matchTitles : null,
      searchEngine: disk && disk.settings ? disk.settings.searchEngine : null,
      bankFile: bank.file,
      bankCount: items.length,
      bankFirst: items[0] ? { question: items[0].question, answer: items[0].answer } : null
    };
  });

  ipcMain.handle('app:clipboardRead', () => clipboard.readText());

  ipcMain.handle('app:openDataDir', () => shell.openPath(app.getPath('userData')));

  ipcMain.handle('app:quit', () => { isQuitting = true; app.quit(); });

  ipcMain.handle('app:restartEngine', () => {
    engineRestarts = 0;
    engineError = '';
    if (engine) { try { engine.kill(); } catch (_) { /* 忽略 */ } }
    engine = null;
    engineReady = false;
    startEngine();
    return true;
  });

  ipcMain.handle('input:now', () => doInsert('ui'));

  ipcMain.handle('input:next', () => useNext());

  ipcMain.handle('input:cancel', () => {
    autoCancel('手动取消');
    return true;
  });

  ipcMain.handle('auto:set', (e, on) => { setAutoMode(!!on); return publicState(); });

  ipcMain.handle('auto:cancel', () => { autoCancel('手动取消'); return true; });

  ipcMain.handle('queue:add', (e, payload) => {
    const list = queueList().slice();
    const text = (payload && payload.text) || '';
    list.push({ id: 'q' + Date.now() + Math.random().toString(36).slice(2, 6), label: (payload && payload.label) || ('第 ' + (list.length + 1) + ' 条'), text: text });
    S.queue = list;
    store.set('queue', list);
    pushState();
    return { ok: true, index: list.length - 1 };
  });

  ipcMain.handle('queue:update', (e, payload) => {
    const list = queueList().slice();
    const i = list.findIndex((x) => x.id === payload.id);
    if (i >= 0) {
      list[i] = Object.assign({}, list[i], payload.patch || {});
      S.queue = list;
      store.set('queue', list);
      if (S.queueMode && i === queueIndex()) setDraftFromQueue();
      pushState();
    }
    return { ok: i >= 0 };
  });

  ipcMain.handle('queue:remove', (e, id) => {
    const list = queueList().filter((x) => x.id !== id);
    S.queue = list;
    store.set('queue', list);
    S.queueIndex = Math.min(queueIndex(), Math.max(0, list.length - 1));
    store.set('queueIndex', S.queueIndex);
    if (S.queueMode) setDraftFromQueue();
    pushState();
    return { ok: true };
  });

  ipcMain.handle('queue:clear', () => {
    S.queue = [];
    S.queueIndex = 0;
    store.set('queue', []);
    store.set('queueIndex', 0);
    pushState();
    return { ok: true };
  });

  ipcMain.handle('queue:setIndex', (e, i) => {
    const list = queueList();
    if (!list.length) return { ok: false };
    S.queueIndex = Math.min(Math.max(0, parseInt(i, 10) || 0), list.length - 1);
    store.set('queueIndex', S.queueIndex);
    setDraftFromQueue();
    pushState();
    return { ok: true };
  });

  ipcMain.handle('queue:setMode', (e, on) => {
    S.queueMode = !!on;
    store.set('queueMode', S.queueMode);
    if (S.queueMode) setDraftFromQueue();
    pushState();
    return { ok: true };
  });

  ipcMain.handle('history:clear', () => {
    S.history = [];
    store.set('history', []);
    pushState();
    return { ok: true };
  });

  ipcMain.handle('history:remove', (e, at) => {
    S.history = (Array.isArray(S.history) ? S.history : []).filter((h) => h.at !== at);
    store.set('history', S.history);
    pushState();
    return { ok: true };
  });

  ipcMain.handle('match:addCurrent', () => {
    if (!fg.title && !fg.proc) return { ok: false, err: '还没有读到前台窗口' };
    const st = settings();
    let added = [];
    if (fg.title && fg.title.length <= 60) {
      const titles = (st.matchTitles || []).slice();
      if (titles.indexOf(fg.title) < 0) { titles.push(fg.title); added.push(fg.title); }
      st.matchTitles = titles;
    }
    if (fg.proc) {
      const procs = (st.matchProcs || []).slice();
      const short = fg.proc.replace(/\.exe$/i, '');
      if (short && procs.indexOf(short) < 0) { procs.push(short); added.push(short); }
      st.matchProcs = procs;
    }
    store.set('settings', st);
    S = store.all();
    sendEngineConfig();
    pushState();
    toast(added.length ? '已加入识别名单：' + added.join('、') : '该窗口已在识别名单里', 'ok');
    return { ok: true, added: added };
  });

  /* ---------------- 搜答案 ---------------- */
  ipcMain.handle('search:run', (e, payload) => runSearchNow(payload || {}));

  ipcMain.handle('search:fromClipboard', () => runSearchNow({ fromClipboard: true }));

  ipcMain.handle('search:results', () => publicSearch(true));

  ipcMain.handle('search:cancel', () => {
    /* 只是把"忙"标记清掉，让用户可以重新发起；真正的网络请求会自行超时结束 */
    if (searchState.active) {
      searchState.active = false;
      searchState.seq++;
      toast('已取消本次搜索', 'warn');
      pushState();
      send('search', publicSearch(true));
    }
    return true;
  });

  ipcMain.handle('search:openUrl', (e, url) => {
    const u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) return { ok: false, err: '不是有效的网页地址' };
    shell.openExternal(u).catch(() => { /* 忽略 */ });
    return { ok: true };
  });

  ipcMain.handle('search:copy', (e, text) => {
    clipboard.writeText(String(text === undefined || text === null ? '' : text));
    return { ok: true };
  });

  ipcMain.handle('bank:list', (e, payload) => {
    const p = payload || {};
    return { ok: true, items: bank.brief(p.keyword, p.limit), count: bank.count() };
  });

  ipcMain.handle('bank:add', (e, payload) => saveCurrentToBank(payload));

  ipcMain.handle('bank:update', (e, payload) => {
    const p = payload || {};
    const r = bank.update(p.id, { question: p.question, answer: p.answer, note: p.note });
    pushState();
    return r;
  });

  ipcMain.handle('bank:remove', (e, id) => {
    const r = bank.remove(id);
    pushState();
    return r;
  });

  ipcMain.handle('bank:clear', () => {
    const r = bank.clear();
    toast('题库已清空', 'warn');
    pushState();
    return r;
  });

  ipcMain.handle('bank:importText', (e, text) => {
    const r = bank.importText(text);
    if (r.ok) {
      toast('批量导入：新增 ' + r.added + ' 条，更新 ' + r.updated + ' 条' +
        (r.skipped ? '，跳过 ' + r.skipped + ' 行（缺分隔符）' : ''), 'ok');
    }
    pushState();
    return r;
  });

  ipcMain.handle('bank:exportFile', () => exportBank());

  ipcMain.handle('bank:importFile', () => importBankFile());

  ipcMain.handle('ai:test', async (e, override) => {
    const st = settings();
    const cfg = Object.assign({
      apiKey: st.aiApiKey,
      baseUrl: st.aiBaseUrl,
      model: st.aiModel
    }, override || {});
    if (override && override.apiKey === undefined && cfg.apiKey === undefined) cfg.apiKey = st.aiApiKey;
    const r = await searchLib.testAi(cfg);
    if (r.ok) toast('AI 连接正常（' + r.ms + 'ms，模型 ' + (r.model || cfg.model) + '）', 'ok');
    else toast('AI 连接失败：' + r.err, 'error');
    return r;
  });

  ipcMain.handle('theme:apply', (e, mode) => { applyThemeToWindow(); return true; });
}

/* ---------------- 应用生命周期 ---------------- */
app.on('second-instance', () => showMain());
app.on('before-quit', () => { isQuitting = true; });
app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => { if (isQuitting) app.quit(); });

app.whenReady().then(() => {
  try { app.setAppUserModelId('com.xu.studyanswerhelper'); } catch (_) { /* 忽略 */ }
  registerIpc();
  createWindow();
  createTray();
  startEngine();
  registerShortcuts();
  applyLoginItem();
  applyThemeToWindow();
  nativeTheme.on('updated', () => {
    applyThemeToWindow();
    if ((settings().theme || 'system') === 'system') pushState();
  });
  logLine('应用就绪 pid=' + process.pid + ' packaged=' + app.isPackaged);

  if (process.env.SP_SELFTEST) runSelftest();
  if (process.env.SP_SHOT) runShots();
  if (process.env.SP_SMOKE) runSmoke();
  if (process.env.SP_SEARCHTEST) runSearchTest();
});

/* ---------------- 自动化验证：交互级自检 ---------------- */
function runSelftest() {
  setTimeout(async () => {
    try {
      const code = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'selftest-script.js'), 'utf8');
      const raw = await mainWin.webContents.executeJavaScript(code, true);
      logLine('SELFTEST_RESULT ' + raw);
    } catch (e) {
      logLine('SELFTEST_RESULT {"fatal":"' + (e && e.message ? String(e.message).replace(/"/g, "'") : 'unknown') + '"}');
    }
    isQuitting = true;
    app.quit();
  }, 2400);
}

/* ---------------- 自动化验证：视觉走查 ---------------- */
/** 截图专用演示数据：现造，绝不使用用户真实数据（preview/ 会进仓库） */
function seedShotData() {
  const demo = [
    '由 (a+b)²=a²+2ab+b² 得 a²+b²=(a+b)²-2ab=3²-2×2=9-4=5',
    'f(x)=x²-2x+3=(x-1)²+2，在 [0,3] 上最大值是 6（x=3 时取到）',
    'y=sin(2x+π/3) 的最小正周期 T=2π/|ω|=2π/2=π'
  ];
  S.draft = demo[0];
  S.queue = [
    { id: 'shot1', label: '第 1 题（选择题）', text: demo[0] },
    { id: 'shot2', label: '第 2 题（填空）', text: demo[1] },
    { id: 'shot3', label: '第 3 题', text: demo[2] }
  ];
  S.queueIndex = 0;
  S.queueMode = true;
  S.history = [
    { at: Date.now() - 120000, text: demo[0] },
    { at: Date.now() - 600000, text: demo[1] },
    { at: Date.now() - 1800000, text: demo[2] }
  ];
  store.set('draft', S.draft);
  store.set('queue', S.queue);
  store.set('queueIndex', 0);
  store.set('queueMode', true);
  store.set('history', S.history);
  store.flush();
  bank.clear();
  bank.add({ question: '已知a+b=3，ab=2，则a²+b²的值为（ ）', answer: '5', note: '完全平方公式变形', source: 'manual' });
  bank.add({ question: '函数f(x)=x²-2x+3在区间[0,3]上的最大值是（ ）', answer: '6', note: '配方后比较端点值', source: 'manual' });
  bank.add({ question: '求函数y=sin(2x+π/3)的最小正周期', answer: 'π', note: 'T=2π/|ω|，此处 ω=2', source: 'manual' });
  bank.flush();
  logLine('已写入截图演示数据（题库 ' + bank.count() + ' 条 / 队列 ' + S.queue.length + ' 条）');
}

function runShots() {
  const outDir = path.join(__dirname, '..', '..', 'preview');
  setTimeout(async () => {
    /* 窗口必须真的显示出来，否则合成器不产帧，capturePage 拿到的是空白图 */
    try { mainWin.show(); } catch (_) { /* 忽略 */ }
    await delay(600);
    seedShotData();
    pushState();
    await delay(600);
    const modes = (process.env.SP_THEME ? [process.env.SP_THEME] : ['light', 'dark']);
    /* search 视图需要先塞点演示数据进去，否则截到的只是一个空状态 */
    const shots = [
      { name: 'main-queue', view: 'queue', wait: 900 },
      { name: 'main-history', view: 'history', wait: 700 },
      { name: 'main-search', view: 'search', wait: 1000, preview: true },
      { name: 'main-settings', view: 'settings', wait: 700 },
      { name: 'modal-bank', view: 'search', wait: 900, preview: true, bankModal: true }
    ];
    for (const mode of modes) {
      const dir = mode === 'dark' ? path.join(outDir, 'dark') : outDir;
      fs.mkdirSync(dir, { recursive: true });
      for (const s of shots) {
        if (s.preview) {
          await mainWin.webContents.executeJavaScript(
            'window.App && window.App.previewSearch && window.App.previewSearch(); true', true);
        }
        if (s.bankModal) {
          await mainWin.webContents.executeJavaScript(
            'window.App && window.App.openBank && window.App.openBank(); true', true);
        }
        await mainWin.webContents.executeJavaScript('window.__SP_SET_THEME__ && window.__SP_SET_THEME__(' + JSON.stringify(mode) + '); App.go(' + JSON.stringify(s.view) + '); true', true);
        await delay(s.wait);
        const img = await mainWin.webContents.capturePage();
        fs.writeFileSync(path.join(dir, s.name + '.png'), img.toPNG());
        logLine('SHOT ' + mode + '/' + s.name);
        if (s.bankModal) {
          await mainWin.webContents.executeJavaScript(
            'window.App && window.App.closeBank && window.App.closeBank(); true', true);
          await delay(200);
        }
      }
    }
    isQuitting = true;
    app.quit();
  }, 2600);
}

/* ---------------- 自动化验证：真实键盘注入冒烟测试 ---------------- */
async function runSmoke() {
  const out = [];
  const W = (s) => { out.push(s); logLine('SMOKE ' + s); };
  let result = { pass: [], fail: [], info: {} };
  try {
    await delay(1200);
    /* 1. 开一个"假学习通"窗口，标题含关键词 */
    targetWin = new BrowserWindow({
      width: 560, height: 380, x: 40, y: 40, show: true, title: '学习通 · 自动输入测试',
      webPreferences: { contextIsolation: true }
    });
    await targetWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<html><head><meta charset="utf-8"><title>学习通测试</title></head><body style="margin:0">' +
      '<textarea id="t" style="width:100vw;height:100vh;box-sizing:border-box;font-size:18px;border:0;outline:0;padding:12px"></textarea>' +
      '</body></html>'
    ));
    await targetWin.webContents.executeJavaScript('document.getElementById("t").focus(); true', true);
    /* 抢系统前台有可能被 Windows 的焦点锁挡掉，所以反复试几种手段：
       Electron 自己的 focus()，加上引擎的 AttachThreadInput + SetForegroundWindow。
       这一段同时也把"输入前自动切回学习通"那条链路一起验证了。 */
    let tgtHwnd = 0;
    try { tgtHwnd = Number(targetWin.getNativeWindowHandle().readBigUInt64LE(0)); } catch (_) { tgtHwnd = 0; }
    for (let i = 0; i < 6; i++) {
      if (fg.pid === process.pid && fg.hwnd) break;
      try { targetWin.show(); targetWin.focus(); } catch (_) { /* 忽略 */ }
      if (tgtHwnd) engineFocus(tgtHwnd);
      await delay(700);
    }
    try { await targetWin.webContents.executeJavaScript('document.getElementById("t").focus(); true', true); } catch (_) { /* 忽略 */ }
    await delay(300);

    /* 2. 引擎是否就绪 */
    if (engineReady) result.pass.push('engine ready');
    else { result.fail.push('engine ready → ' + engineError); throw new Error('引擎未就绪，后续测试无意义'); }

    /* 3. 前台窗口是否被识别为"学习通" */
    result.info.fg = { title: fg.title, proc: fg.proc, pid: fg.pid, matched: fg.matched, by: fg.by };
    if (fg.matched && /学习通/.test(fg.title)) result.pass.push('窗口识别命中 title=' + fg.title + ' by=' + fg.by);
    else result.fail.push('窗口识别未命中 → title=' + fg.title + ' proc=' + fg.proc + ' matched=' + fg.matched);

    /* 4. 真实注入：只在焦点确实在我们自己的测试窗口时才敲键，避免误输入到别的程序 */
    if (fg.pid !== process.pid) {
      result.fail.push('测试窗口未获得焦点（前景 pid=' + fg.pid + '，本进程 pid=' + process.pid + '），已放弃注入以免误输入');
    } else {
      const sample = '数学答案：√3 + 1/2 ≈ 1.366';
      const t0 = Date.now();
      const res = await engineType({ text: sample, delayMs: 12, clearFirst: true });
      const got = await targetWin.webContents.executeJavaScript('document.getElementById("t").value', true);
      result.info.typed = { ok: res.ok, sent: res.sent, ms: Date.now() - t0, got: got };
      if (got === sample) result.pass.push('键盘注入完全一致（' + res.sent + ' 字 / ' + (Date.now() - t0) + 'ms）');
      else result.fail.push('键盘注入不一致 → 期望『' + sample + '』实际『' + got + '』');

      /* 5. 换行与多行内容 */
      const multi = '第一行\n第二行 3/4';
      const res2 = await engineType({ text: multi, delayMs: 8, clearFirst: true });
      const got2 = await targetWin.webContents.executeJavaScript('document.getElementById("t").value', true);
      if (got2 === multi) result.pass.push('多行/换行注入正确');
      else result.fail.push('多行注入不一致 → 实际『' + got2 + '』');

      /* 6. 清理规则 */
      const cleaned = cleanupText('  根号2  \n\n\n  后面有  多余空格  \n', 'light');
      result.info.cleaned = cleaned;
      if (cleaned === '根号2\n\n后面有  多余空格') result.pass.push('内容清理规则正确');
      else result.fail.push('内容清理不符 → 『' + cleaned + '』');
    }
  } catch (e) {
    result.fail.push('异常：' + (e && e.message ? e.message : String(e)));
  }
  result.info.summary = out.join(' | ');
  logLine('SMOKE_RESULT ' + JSON.stringify(result));
  isQuitting = true;
  setTimeout(() => app.quit(), 400);
}

/* ---------------- 自动化验证：真实检索冒烟（SP_SEARCHTEST，需要网络） ----------------
 * 与 SP_SELFTEST 分开：自检必须离线可复现，而这条链路本来就依赖外部搜索引擎，
 * 所以单独一个模式，结果只写日志供人工判读。
 * 可用环境变量覆盖：SP_SEARCH_Q / SP_SEARCH_ENGINE / SP_AI_KEY / SP_AI_BASE / SP_AI_MODEL
 */
async function runSearchTest() {
  const out = { env: { engine: process.env.SP_SEARCH_ENGINE || 'auto', ai: !!process.env.SP_AI_KEY } };
  try {
    await delay(1500);
    const question = process.env.SP_SEARCH_Q || '已知a+b=3，ab=2，则a²+b²的值为（ ）';

    /* 1. 先往本地题库塞一条，验证离线链路 */
    bank.add({ question: question, answer: 'a²+b²=(a+b)²-2ab=9-4=5', source: 'searchtest' });
    bank.flush();
    out.bankCount = bank.count();
    out.bankFile = path.join(app.getPath('userData'), 'answer-bank.json');
    out.bankFileExists = fs.existsSync(out.bankFile);

    /* 2. 走完整检索 */
    const r = await searchLib.runSearch({
      question: question,
      sources: { local: true, web: true, ai: !!process.env.SP_AI_KEY },
      bank: bank,
      engine: process.env.SP_SEARCH_ENGINE || 'auto',
      minScore: 0.55,
      topN: 6,
      timeoutMs: 25000,
      ai: {
        apiKey: process.env.SP_AI_KEY || '',
        baseUrl: process.env.SP_AI_BASE || settings().aiBaseUrl,
        model: process.env.SP_AI_MODEL || settings().aiModel
      }
    });
    out.ok = r.ok;
    out.ms = r.ms;
    out.errors = r.errors;
    out.meta = r.meta;
    out.candidateCount = (r.candidates || []).length;
    out.candidates = (r.candidates || []).map((c) => ({
      source: c.source,
      kind: c.kind,
      score: Number((c.score || 0).toFixed(3)),
      answer: c.answer || '',
      title: String(c.title || c.question || '').slice(0, 70),
      url: c.url || ''
    }));

    /* 3. 再验证 IPC 完整链路：真的走一次 runSearchNow（含自动填入大框与状态广播） */
    if (mainWin && !mainWin.isDestroyed()) {
      setDraftText('');
      const r2 = await runSearchNow({ question: question, sources: { local: true, web: false, ai: false } });
      out.ipc = {
        ok: !!(r2 && r2.ok),
        count: (r2 && r2.candidates ? r2.candidates.length : 0),
        draft: S.draft || ''
      };
      out.publicStateKeys = Object.keys(publicState().search || {});
      out.leakCheck = JSON.stringify(publicState()).indexOf('apiKey') >= 0 ? 'LEAK' : 'clean';
    }
  } catch (e) {
    out.fatal = e && e.stack ? String(e.stack) : String(e);
  }
  logLine('SEARCHTEST ' + JSON.stringify(out));
  isQuitting = true;
  setTimeout(() => app.quit(), 300);
}
