'use strict';
/* ------------------------------------------------------------------
 * 输入引擎（独立子进程）
 *   - 用 koffi（N-API 预编译原生模块）调用 Win32 API
 *   - SendInput + KEYEVENTF_UNICODE 实现"逐字输入"，中文和 √ π ∫ 等
 *     数学符号都能正确送入目标输入框
 *   - 轮询前台窗口，报告标题/进程/是否命中"学习通"关键词
 *   - 逐字输入会阻塞事件循环，所以必须跑在独立进程，避免卡住界面
 * 与主进程通过 process.send / process.on('message') 通信（JSON 消息）
 * ------------------------------------------------------------------ */
const fs = require('fs');
const path = require('path');

/* 同步睡眠（不占用 CPU），用于逐字间隔 */
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => { if (ms > 0) Atomics.wait(sleepCell, 0, 0, ms); };

const INPUT_SIZE = 40;                 /* x64 下 sizeof(INPUT) */
const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const VK_ESCAPE = 0x1B;
const VK_RETURN = 0x0D;
const VK_TAB = 0x09;
const VK_CONTROL = 0x11;
const VK_A = 0x41;
const VK_DELETE = 0x2E;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

const insBuf = Buffer.alloc(INPUT_SIZE * 2);
const txtBuf = Buffer.alloc(4096);
const pidBuf = Buffer.alloc(4);
const sizeBuf = Buffer.alloc(4);
const exeBuf = Buffer.alloc(4096);

let api = null;
let cfg = {
  matchTitles: ['学习通'],
  matchProcs: [],
  selfPids: [],
  pollMs: 220,
  watchEsc: true
};
let lastMatchedHwnd = 0;
let lastFgKey = '';
let escWasDown = false;
let pollTimer = null;

/* ---------------- 消息发送 ---------------- */
/* koffi 把 HWND 之类的指针返回成 BigInt，而 IPC 默认用 JSON 序列化，
   JSON.stringify(BigInt) 会直接抛错。早期版本这里 catch 掉异常后消息就静默消失了
   （表现为：前台窗口永远读不到、输入完成后回执收不到）。所以这里做两层防护。 */
function jsonSafe(v) {
  return JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? Number(x) : x));
}
function send(msg) {
  if (typeof process.send === 'function') {
    try {
      process.send(msg);
      return;
    } catch (e) {
      try {
        process.send(JSON.parse(jsonSafe(msg)));   /* 退化成纯数值副本再发一次 */
        return;
      } catch (e2) {
        if (process.env.SP_ENGINE_VERBOSE) process.stderr.write('ENGINE_SEND_FAIL ' + (e2 && e2.message) + '\n');
        return;
      }
    }
  }
  if (process.env.SP_ENGINE_VERBOSE) process.stdout.write(jsonSafe(msg) + '\n');
}

/* ---------------- Win32 绑定 ---------------- */
function loadApi() {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  api = {
    GetForegroundWindow: user32.func('void * __stdcall GetForegroundWindow()'),
    GetWindowTextW: user32.func('int __stdcall GetWindowTextW(void *hWnd, uint16_t *lpString, int nMaxCount)'),
    GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hWnd, uint32_t *lpdwProcessId)'),
    GetAsyncKeyState: user32.func('int16_t __stdcall GetAsyncKeyState(int vKey)'),
    SendInput: user32.func('uint32_t __stdcall SendInput(uint32_t nInputs, void *pInputs, int cbSize)'),
    IsWindow: user32.func('bool __stdcall IsWindow(void *hWnd)'),
    IsIconic: user32.func('bool __stdcall IsIconic(void *hWnd)'),
    ShowWindow: user32.func('bool __stdcall ShowWindow(void *hWnd, int nCmdShow)'),
    SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(void *hWnd)'),
    BringWindowToTop: user32.func('int __stdcall BringWindowToTop(void *hWnd)'),
    AttachThreadInput: user32.func('int __stdcall AttachThreadInput(uint32_t idAttach, uint32_t idAttachTo, int fAttach)'),
    GetCurrentThreadId: kernel32.func('uint32_t __stdcall GetCurrentThreadId()'),
    GetAncestor: user32.func('void * __stdcall GetAncestor(void *hWnd, uint32_t gaFlags)'),
    OpenProcess: kernel32.func('void * __stdcall OpenProcess(uint32_t dwDesiredAccess, bool bInheritHandle, uint32_t dwProcessId)'),
    QueryFullProcessImageNameW: kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *hProcess, uint32_t dwFlags, uint16_t *lpExeName, uint32_t *lpdwSize)'),
    CloseHandle: kernel32.func('bool __stdcall CloseHandle(void *hObject)')
  };
}

/* ---------------- 窗口信息 ---------------- */
function getTitle(hwnd) {
  if (!hwnd) return '';
  let n = 0;
  try { n = api.GetWindowTextW(hwnd, txtBuf, 2047); } catch (_) { return ''; }
  if (!n || n < 0) return '';
  return txtBuf.toString('utf16le', 0, n * 2).replace(/\u0000+$/, '');
}

function getPid(hwnd) {
  pidBuf.writeUInt32LE(0, 0);
  try { api.GetWindowThreadProcessId(hwnd, pidBuf); } catch (_) { return 0; }
  return pidBuf.readUInt32LE(0);
}

function getProcName(pid) {
  if (!pid) return '';
  let h = 0;
  try {
    h = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (!h) return '';
    sizeBuf.writeUInt32LE(2047, 0);
    const ok = api.QueryFullProcessImageNameW(h, 0, exeBuf, sizeBuf);
    if (!ok) return '';
    const n = sizeBuf.readUInt32LE(0);
    const full = exeBuf.toString('utf16le', 0, n * 2);
    return full.split('\\').pop();
  } catch (_) {
    return '';
  } finally {
    try { if (h) api.CloseHandle(h); } catch (_) { /* 忽略 */ }
  }
}

/* 根窗口：避免命中输入法候选框之类的子窗口 */
function rootWindow(hwnd) {
  try {
    const r = api.GetAncestor(hwnd, 2 /* GA_ROOT */);
    return r || hwnd;
  } catch (_) {
    return hwnd;
  }
}

function matchWindow(title, proc, pid) {
  const selfPids = Array.isArray(cfg.selfPids) ? cfg.selfPids : [];
  if (selfPids.indexOf(pid) >= 0) return { matched: false, self: true };
  const t = String(title || '').toLowerCase();
  const p = String(proc || '').toLowerCase();
  const procs = Array.isArray(cfg.matchProcs) ? cfg.matchProcs : [];
  for (const k of procs) {
    const kk = String(k || '').trim().toLowerCase();
    if (kk && p.indexOf(kk) >= 0) return { matched: true, by: 'proc', keyword: k };
  }
  const titles = Array.isArray(cfg.matchTitles) ? cfg.matchTitles : [];
  for (const k of titles) {
    const kk = String(k || '').trim().toLowerCase();
    if (kk && t.indexOf(kk) >= 0) return { matched: true, by: 'title', keyword: k };
  }
  return { matched: false };
}

/* ---------------- 键盘注入 ---------------- */
function fillKey(off, vk, scan, flags) {
  insBuf.writeUInt32LE(1, off);          /* INPUT_KEYBOARD */
  insBuf.writeUInt32LE(0, off + 4);      /* padding */
  insBuf.writeUInt16LE(vk, off + 8);
  insBuf.writeUInt16LE(scan, off + 10);
  insBuf.writeUInt32LE(flags, off + 12);
  insBuf.writeUInt32LE(0, off + 16);
  insBuf.writeUInt32LE(0, off + 20);     /* padding */
  insBuf.writeBigUInt64LE(BigInt(0), off + 24);
}

function fire2(vk1, scan1, f1, vk2, scan2, f2) {
  fillKey(0, vk1, scan1, f1);
  fillKey(INPUT_SIZE, vk2, scan2, f2);
  return api.SendInput(2, insBuf, INPUT_SIZE) === 2;
}

function postUnicode(code) {
  return fire2(0, code, KEYEVENTF_UNICODE, 0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
}
function postVk(vk, scan, extended) {
  const f = extended ? KEYEVENTF_EXTENDEDKEY : 0;
  return fire2(vk, scan, f, vk, scan, f | KEYEVENTF_KEYUP);
}
function postCtrlA() {
  fire2(VK_CONTROL, 0x1D, 0, VK_A, 0x1E, 0);
  fire2(VK_A, 0x1E, KEYEVENTF_KEYUP, VK_CONTROL, 0x1D, KEYEVENTF_KEYUP);
}
/* 把目标窗口切到前台。
   直接调 SetForegroundWindow 经常失败：Windows 只允许"当前拥有前台焦点"的进程改前台，
   从托盘/后台唤起时会返回 false。通用解法是把自己的线程临时挂到前台窗口的线程上，
   借用它的前台权限，切完再摘掉。 */
function switchToWindow(hwnd) {
  if (!hwnd) return false;
  try {
    if (!api.IsWindow(hwnd)) return false;
    if (api.IsIconic(hwnd)) api.ShowWindow(hwnd, 9 /* SW_RESTORE */);
    if (api.SetForegroundWindow(hwnd)) return true;

    const fgWnd = toNum(api.GetForegroundWindow());
    const tidBuf = Buffer.alloc(4);
    const tidFg = fgWnd ? api.GetWindowThreadProcessId(fgWnd, tidBuf) : 0;
    const tidSelf = toNum(api.GetCurrentThreadId());
    let attached = false;
    if (tidFg && tidSelf && tidFg !== tidSelf) {
      attached = api.AttachThreadInput(tidFg, tidSelf, 1) !== 0;
    }
    try {
      api.BringWindowToTop(hwnd);
      return !!api.SetForegroundWindow(hwnd);
    } finally {
      if (attached) api.AttachThreadInput(tidFg, tidSelf, 0);
    }
  } catch (_) {
    return false;
  }
}

function escPressedNow() {
  try {
    return (api.GetAsyncKeyState(VK_ESCAPE) & 0x8000) !== 0;
  } catch (_) {
    return false;
  }
}

/* 逐字输入主逻辑（阻塞式，在子进程里跑没关系） */
function typeText(text, opts) {
  const o = opts || {};
  const delay = Math.max(0, parseInt(o.delayMs, 10) || 0);
  const t0 = Date.now();
  const escAtStart = escPressedNow();
  let sent = 0;

  if (o.clearFirst) {
    postCtrlA();
    sleep(60);
    postVk(VK_DELETE, 0x53, true);
    sleep(60);
  }

  for (const ch of String(text)) {
    if (o.watchEsc !== false) {
      const down = escPressedNow();
      if (down && !escAtStart) {
        return { ok: false, aborted: true, sent, total: [...String(text)].length, ms: Date.now() - t0 };
      }
    }
    let ok = false;
    const code = ch.codePointAt(0);
    if (ch === '\n' || ch === '\r') {
      ok = postVk(VK_RETURN, 0x1C, false);
    } else if (ch === '\t') {
      ok = postVk(VK_TAB, 0x0F, false);
    } else if (code > 0xFFFF) {
      const c = code - 0x10000;
      ok = postUnicode(0xD800 + (c >> 10)) && postUnicode(0xDC00 + (c & 0x3FF));
    } else {
      ok = postUnicode(code);
    }
    if (!ok) {
      return { ok: false, err: 'SendInput 被系统拒绝（返回值 0）', sent, ms: Date.now() - t0 };
    }
    sent++;
    if (delay) sleep(delay);
  }
  return { ok: true, sent, total: [...String(text)].length, ms: Date.now() - t0 };
}

/* koffi 返回的指针是 BigInt，统一转成普通数字，避免泄漏到 IPC 与持久化里 */
function toNum(h) {
  if (h === null || h === undefined) return 0;
  const n = Number(h);
  return Number.isFinite(n) ? n : 0;
}

/* ---------------- 前台窗口轮询 ---------------- */
function poll() {
  let hwnd = 0;
  let title = '';
  let pid = 0;
  try {
    hwnd = toNum(rootWindow(toNum(api.GetForegroundWindow())));
    title = getTitle(hwnd);
    pid = getPid(hwnd);
  } catch (_) {
    return;
  }
  const key = hwnd + '|' + pid + '|' + title;
  if (key !== lastFgKey) {
    lastFgKey = key;
    let proc = '';
    try { proc = getProcName(pid); } catch (_) { proc = ''; }
    const m = matchWindow(title, proc, pid);
    if (m.matched) lastMatchedHwnd = hwnd;
    send({
      type: 'fg',
      hwnd: hwnd,
      title: title,
      pid: pid,
      proc: proc,
      matched: !!m.matched,
      self: !!m.self,
      by: m.by || '',
      keyword: m.keyword || '',
      lastMatchedHwnd: lastMatchedHwnd
    });
  }
  if (cfg.watchEsc) {
    const down = escPressedNow();
    if (down && !escWasDown) send({ type: 'esc' });
    escWasDown = down;
  }
}

/* ---------------- 启动 ---------------- */
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, Math.max(80, parseInt(cfg.pollMs, 10) || 220));
  poll();
}

function applyConfig(next) {
  if (!next || typeof next !== 'object') return;
  cfg = Object.assign({}, cfg, next, { selfPids: Array.isArray(next.selfPids) ? next.selfPids : cfg.selfPids });
  startPolling();
}

function handleType(msg) {
  const res = typeText(msg.text || '', {
    delayMs: msg.delayMs,
    clearFirst: !!msg.clearFirst,
    watchEsc: msg.watchEsc !== false
  });
  send(Object.assign({ type: 'typed', id: msg.id, hwndTarget: lastMatchedHwnd }, res));
}

function boot() {
  try {
    loadApi();
  } catch (e) {
    send({ type: 'ready', ok: false, err: '输入引擎初始化失败：' + (e && e.message ? e.message : String(e)) });
    return;
  }
  send({ type: 'ready', ok: true, arch: process.arch, pid: process.pid });
  startPolling();

  process.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'config') applyConfig(msg.cfg);
    else if (msg.type === 'type') handleType(msg);
    else if (msg.type === 'focus') {
      const ok = switchToWindow(msg.hwnd);
      send({ type: 'focused', ok: ok, hwnd: msg.hwnd });
    } else if (msg.type === 'ping') send({ type: 'pong', id: msg.id });
  });
  process.on('uncaughtException', (e) => {
    send({ type: 'fatal', err: (e && e.stack ? e.stack : String(e)) });
  });
}

/* 独立运行调试：node input-engine.js --typefile <文件> [--delay 15] */
if (require.main === module) {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf('--typefile');
  process.env.SP_ENGINE_VERBOSE = '1';
  boot();
  if (idx >= 0 && argv[idx + 1]) {
    const file = argv[idx + 1];
    const dIdx = argv.indexOf('--delay');
    setTimeout(() => {
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch (e) { text = ''; }
      const r = typeText(text, { delayMs: dIdx >= 0 ? parseInt(argv[dIdx + 1], 10) : 15 });
      process.stdout.write('TYPED ' + JSON.stringify(r) + '\n');
      setTimeout(() => process.exit(0), 200);
    }, 1500);
  }
} else {
  boot();
}

module.exports = { typeText, matchWindow: matchWindow, loadApi: loadApi };
