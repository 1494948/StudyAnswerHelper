'use strict';
/* 通用 UI Automation 驱动（Node 侧封装）。
 *
 * 干什么用的：
 *   学习通答题框是富文本编辑器，工具栏上有「公式」「代码」按钮。桌面版要"用上学习通
 *   自己的公式/代码能力"，就得先在窗口里找到那个按钮并点它，再把内容填进弹出的对话框。
 *   本模块只做两件事：**枚举窗口里的元素**（dump，用于校准）和**按名字点一个元素**（click）。
 *
 * 为什么把请求写进 UTF-8 JSON 文件，而不是走命令行参数：
 *   PS 5.1 的 argv 会经过控制台代码页（本机是 GBK），中文按钮名（"公式"）经命令行传递
 *   有乱码风险。写文件 + `[System.IO.File]::ReadAllText(..., UTF8)` 完全绕开这个问题。
 *   （与 lib/ocr.js 用 JSON 文件回传识别结果是同一套做法，那个坑先踩过。）
 *
 * 与 lib/option-click.js 共用同一条约定：脚本路径必须做 asar → asar.unpacked 改写，
 * 否则"开发态正常、打包版报参数不存在"。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 12000;

/* 面向用户的短错误码 → 人话 */
const CODE_TEXT = {
  'bad-request': '内部请求格式不对',
  'bad-mode': '内部调用模式不对',
  'no-names': '没有给出要查找的按钮名字',
  'uia-unavailable': '本机缺少 UI Automation 组件（系统被精简过？）',
  'no-window': '找不到目标窗口 —— 可能已经关闭，或窗口句柄已失效',
  'not-found': '在目标窗口里没找到这个按钮。常见原因：页面还没渲染完、按钮不在可见区域（先滚动到工具栏）、或者这个版本的编辑器没把按钮暴露给无障碍接口',
  'no-pattern': '找到了这个按钮，但页面没给它开放"可点击"的接口',
  'timeout': '查找超时（页面响应太慢）',
  'spawn-failed': '无法启动系统脚本宿主',
  'no-result': '脚本没有返回结果（可能是脚本自身报错）'
};

function describe(res, what) {
  const label = what || '元素';
  if (!res) return '查找失败：未知原因';
  if (res.ok) {
    const how = { invoke: '程序化点击', select: '程序化选中', toggle: '程序化勾选',
      expand: '程序化展开', mouse: '模拟鼠标点击' }[res.used] || res.used;
    return '已点击' + label + '「' + res.name + '」（' + how + (res.type ? ' · ' + res.type : '') + '）';
  }
  const base = CODE_TEXT[res.code] || res.code || '未知错误';
  if (res.code === 'not-found' && res.scanned === 0) {
    return base + '（这个窗口没有向系统暴露界面结构：读到 0 个控件。' +
      '可以先切到学习通、点一下页面让它拿到焦点再试）';
  }
  return base;
}

function scriptPath() {
  const p = path.join(__dirname, 'uia-tool-win.ps1');
  const u = String(p).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  return (u !== p && fs.existsSync(u)) ? u : p;
}

function tmpFile(tag, ext) {
  return path.join(os.tmpdir(), 'sah-uia-' + tag + '-' + Date.now() + '-' +
    Math.random().toString(36).slice(2, 7) + ext);
}

/**
 * 跑一次脚本。
 * @param {{mode:string, hwnd:number, names?:string[], exact?:boolean, timeoutMs?:number, max?:number}} req
 * @returns {Promise<object>}
 */
function run(req) {
  const r = req || {};
  const t0 = Date.now();
  const timeoutMs = parseInt(r.timeoutMs, 10) || DEFAULT_TIMEOUT_MS;
  const hwnd = Number(r.hwnd) || 0;
  const mode = r.mode || 'dump';
  /* list 模式不需要窗口句柄；其余模式必须有 */
  if (!hwnd && mode !== 'list') {
    return Promise.resolve({ ok: false, code: 'no-window', hwnd: 0, ms: 0 });
  }

  const file = scriptPath();
  if (!fs.existsSync(file)) return Promise.resolve({ ok: false, code: 'spawn-failed', ms: 0 });

  const reqFile = tmpFile('req', '.json');
  const outFile = tmpFile('out', '.json');
  try {
    fs.writeFileSync(reqFile, JSON.stringify({
      mode: mode,
      hwnd: hwnd,
      names: Array.isArray(r.names) ? r.names.filter(function (x) { return String(x || '').trim(); }) : [],
      exact: !!r.exact,
      timeoutMs: timeoutMs,
      max: parseInt(r.max, 10) || undefined
    }), 'utf8');
  } catch (e) {
    return Promise.resolve({ ok: false, code: 'bad-request', err: String(e && e.message), ms: Date.now() - t0 });
  }

  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', file,
    '-Req', reqFile,
    '-Out', outFile
  ];

  return new Promise(function (resolve) {
    let child = null;
    let done = false;
    let stderr = '';

    function cleanup() {
      try { if (fs.existsSync(reqFile)) fs.unlinkSync(reqFile); } catch (_) { /* 忽略 */ }
      try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch (_) { /* 忽略 */ }
    }

    function finish(res) {
      if (done) return;
      done = true;
      cleanup();
      resolve(Object.assign({ hwnd: hwnd, ms: Date.now() - t0 }, res));
    }

    try {
      child = spawn('powershell.exe', args, { windowsHide: true });
    } catch (e) {
      finish({ ok: false, code: 'spawn-failed', err: String(e && e.message) });
      return;
    }

    const killer = setTimeout(function () {
      try { child.kill(); } catch (_) { /* 忽略 */ }
      finish({ ok: false, code: 'timeout' });
    }, timeoutMs + 8000);
    if (killer.unref) killer.unref();

    if (child.stderr) child.stderr.on('data', function (d) { stderr += String(d).slice(0, 500); });
    child.on('error', function (e) {
      clearTimeout(killer);
      finish({ ok: false, code: 'spawn-failed', err: String(e && e.message) });
    });
    child.on('close', function () {
      clearTimeout(killer);
      let res = null;
      try {
        if (fs.existsSync(outFile)) res = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      } catch (e) {
        res = { ok: false, code: 'bad-json', err: String(e && e.message) };
      }
      if (!res) res = { ok: false, code: 'no-result', err: stderr.trim() };
      finish(res);
    });
  });
}

/** 枚举窗口里的元素（校准用）：返回 { ok, elements:[{type,name,x,y,w,h,patterns}] } */
function dump(hwnd, opts) {
  const o = opts || {};
  return run({ mode: 'dump', hwnd: hwnd, timeoutMs: o.timeoutMs, max: o.max });
}

/** 列出当前可见的顶层窗口（校准用）：返回 { ok, windows:[{hwnd,pid,name,x,y,w,h,cls}] } */
function listWindows(opts) {
  return run({ mode: 'list', timeoutMs: (opts && opts.timeoutMs) || 8000 });
}

/** 按候选名字点一个元素（从左到右依次是优先级：精确 > 前缀 > 包含） */
function clickByName(hwnd, names, opts) {
  const o = opts || {};
  return run({ mode: 'click', hwnd: hwnd, names: names, exact: o.exact, timeoutMs: o.timeoutMs });
}

module.exports = { run, dump, listWindows, clickByName, describe, scriptPath, CODE_TEXT };
