'use strict';
/* 自动点选选择题选项。
 *
 * 原理：借 Windows 的 UI Automation（UIA）在目标窗口里找"名字以 A./B./C./D. 开头的可选控件"，
 * 然后用 SelectionItemPattern / InvokePattern / TogglePattern 直接选中它；都不支持时
 * 退化为在该元素中心做一次真实鼠标点击。
 *
 * 为什么用 UIA 而不是"记住选项坐标然后点"：
 *   - 坐标会随分辨率、缩放、页面滚动、字体大小变，几乎必然失效；
 *   - UIA 拿到的是语义元素，页面上哪一行挪了都不影响。
 *
 * 为什么不用键盘发字母：
 *   实测多数答题页并没有把字母键绑成"选中该选项"，盲目发键只会把字母打进输入框。
 *   UIA 不可用时宁可不点，也不做"看起来动了其实没选中"的假动作。
 *
 * 与 ocr.js 同样的约定：PowerShell 脚本必须是纯 ASCII（PS 5.1 按 ANSI 解析 .ps1），
 * 所有面向用户的中文提示都在这层根据返回的短错误码映射。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const subject = require('./subject');

/* 脚本超时：PS 启动 + UIA 遍历一般 1~3 秒，给足余量 */
const DEFAULT_TIMEOUT_MS = 15000;

const CODE_TEXT = {
  'bad-letter': '选项字母不是 A–H 之间的单个字母',
  'uia-unavailable': '本机缺少 UI Automation 组件（系统被精简过？）',
  'no-window': '找不到目标窗口 —— 可能已经关闭，或窗口句柄已失效',
  'not-found': '这个窗口里没找到该选项。常见原因：页面还没渲染完、选项不在可见区域（先滚动到题目处）、或者它不是标准可选控件',
  'no-pattern': '找到了选项元素，但页面没给它开放"可点选"接口',
  'timeout': '点选超时（页面响应太慢）',
  'spawn-failed': '无法启动系统脚本宿主'
};

function describe(res) {
  if (!res) return '点选失败：未知原因';
  if (res.ok) {
    const how = res.how === 'index' ? '按序号定位' : '按选项文字定位';
    const usedMap = { select: '程序化选中', invoke: '程序化点击', toggle: '程序化勾选', mouse: '模拟鼠标点击' };
    const used = usedMap[res.used] || res.used;
    let tail = '';
    if (res.selected === false) tail = '，但回读发现它仍未选中（页面可能拦截了程序化操作）';
    else if (res.selected === true) tail = '，并已回读确认选中';
    return '已点选 ' + res.letter + '（' + how + ' · ' + used + '）' + tail;
  }
  const base = CODE_TEXT[res.code] || res.code || '未知错误';
  if (res.code === 'not-found') {
    const n = res.scanned || 0;
    let tail;
    if (n === 0) {
      /* 一个控件都读不到，通常是目标程序没向系统暴露界面结构。
         这个区别对用户很重要：不是"没找到选项"，而是"根本读不到这个窗口"。 */
      tail = '（这个窗口没有向系统暴露界面结构 —— 页面可能还没渲染完，' +
        '或该程序不支持无障碍接口；可以先切过去点一下页面再试，或换用网页版）';
    } else {
      tail = '（读到 ' + n + ' 个控件，但没发现形如「A.」「B.」的选项' +
        (res.selectables ? '，可选控件 ' + res.selectables + ' 个与选项数不符' : '') + '）';
    }
    return base + tail;
  }
  return base;
}

/**
 * 脚本路径必须做 asar → asar.unpacked 改写。
 *
 * 这一步漏了的后果很隐蔽：打包后路径仍然"存在"（Electron 的 fs 能从 asar 里读），
 * 于是前面的存在性检查会通过；但把 asar 内路径当 `-File` 参数交给脚本宿主时，
 * 宿主看到的是虚拟路径，直接报「参数不存在」，点选在打包版里完全不可用。
 * 实测报错原文见 v1.3.0 的发布前验证记录。
 * （与 lib/ocr.js 的同名处理保持一致 —— 它是同一条链路上先踩过的坑。）
 */
function scriptPath() {
  const p = path.join(__dirname, 'option-click-win.ps1');
  const u = String(p).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  return (u !== p && fs.existsSync(u)) ? u : p;
}

/**
 * 在指定窗口里点选一个字母。
 * @param {{hwnd:number, letter:string, optionCount?:number, timeoutMs?:number}} o
 */
function clickLetter(o) {
  const opt = o || {};
  const t0 = Date.now();
  const letter = String(opt.letter || '').trim().toUpperCase().slice(0, 1);
  const hwnd = Number(opt.hwnd) || 0;
  const timeoutMs = parseInt(opt.timeoutMs, 10) || DEFAULT_TIMEOUT_MS;

  if (!hwnd) return Promise.resolve({ ok: false, code: 'no-window', letter: letter, ms: 0 });
  if (!/^[A-H]$/.test(letter)) return Promise.resolve({ ok: false, code: 'bad-letter', letter: letter, ms: 0 });

  const file = scriptPath();
  if (!fs.existsSync(file)) return Promise.resolve({ ok: false, code: 'spawn-failed', letter: letter, ms: 0 });

  const out = path.join(os.tmpdir(), 'sah-opt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.json');
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', file,
    '-Hwnd', String(hwnd),
    '-Letter', letter,
    '-OptionCount', String(parseInt(opt.optionCount, 10) || 0),
    '-TimeoutMs', String(timeoutMs),
    '-Out', out
  ];

  return new Promise(function (resolve) {
    let child = null;
    let done = false;
    let stderr = '';

    function finish(res) {
      if (done) return;
      done = true;
      try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch (_) { /* 忽略 */ }
      resolve(Object.assign({ letter: letter, ms: Date.now() - t0 }, res));
    }

    try {
      child = spawn('powershell.exe', args, { windowsHide: true });
    } catch (e) {
      finish({ ok: false, code: 'spawn-failed', err: String(e && e.message) });
      return;
    }

    /* 进程级超时：脚本内部也会限时，这里是最后一道保险 */
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
        if (fs.existsSync(out)) res = JSON.parse(fs.readFileSync(out, 'utf8'));
      } catch (e) {
        res = { ok: false, code: 'bad-json', err: String(e && e.message) };
      }
      if (!res) res = { ok: false, code: 'no-result', err: stderr.trim() };
      finish(res);
    });
  });
}

/**
 * 按题目 + 答案，自动点选。
 * 支持多选（答案形如 "AB" / "A、C"）—— 逐个点，任一失败即停止并如实报告。
 * @param {{hwnd:number, question:string, answer:string, timeoutMs?:number}} o
 */
async function clickAnswer(o) {
  const opt = o || {};
  const hwnd = Number(opt.hwnd) || 0;
  const ch = subject.resolveChoice(opt.question, opt.answer);
  const letters = ch.letters || [];
  if (!ch.clickable || !letters.length) {
    return {
      ok: false,
      why: ch.why || '不是选择题或答案里没有选项字母',
      letters: [],
      results: [],
      options: ch.options || []
    };
  }

  const results = [];
  for (const L of letters) {
    const r = await clickLetter({
      hwnd: hwnd,
      letter: L,
      optionCount: ch.options.length,
      timeoutMs: opt.timeoutMs
    });
    results.push(r);
    if (!r.ok) {
      /* code 必须原样带出去：调用方要靠它区分"根本没到脚本那一步"（如没有目标窗口）
         和"脚本跑了但没找到"，否则上层与自检都只能看到一个笼统的失败。 */
      return {
        ok: false,
        code: r.code || 'unknown',
        why: describe(r),
        letters: letters,
        results: results,
        clicked: letters.slice(0, results.length - 1)
      };
    }
    await new Promise(function (r2) { setTimeout(r2, 220); });
  }
  return {
    ok: true,
    code: 'ok',
    why: results.map(describe).join('；'),
    letters: letters,
    results: results,
    clicked: letters.slice()
  };
}

module.exports = { clickLetter, clickAnswer, describe, scriptPath, CODE_TEXT };
