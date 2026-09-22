/* 诊断探针：确认 koffi 的指针返回值类型、结构体尺寸是否符合 x64 预期 */
'use strict';
const fs = require('fs');
const path = require('path');
const out = [];
const L = (s) => out.push(String(s));

try {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');

  const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()');
  const hwnd = GetForegroundWindow();
  L('hwnd value      = ' + String(hwnd));
  L('hwnd typeof     = ' + typeof hwnd);
  L('hwnd Number()   = ' + Number(hwnd));
  try {
    L('JSON.stringify  = ' + JSON.stringify({ hwnd: hwnd }));
  } catch (e) {
    L('JSON.stringify  = THROWS: ' + e.message);
  }
  L('hwnd + ""       = ' + (hwnd + ''));

  /* 结构体尺寸：验证手写 INPUT(40) 的偏移假设 */
  const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
    wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uint64'
  });
  const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
    dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uint64'
  });
  const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' });
  const U = koffi.union('INPUTUNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
  const INPUT = koffi.struct('INPUT', { type: 'uint32', u: U });
  L('sizeof KEYBDINPUT  = ' + koffi.sizeof(KEYBDINPUT) + ' (期望 24)');
  L('sizeof MOUSEINPUT  = ' + koffi.sizeof(MOUSEINPUT) + ' (期望 32)');
  L('sizeof INPUTUNION  = ' + koffi.sizeof(U) + ' (期望 32)');
  L('sizeof INPUT       = ' + koffi.sizeof(INPUT) + ' (期望 40)');
  L('offsetof u         = ' + koffi.offsetof(INPUT, 'u') + ' (期望 8)');

  /* 进程信息 API 是否可用 */
  const kernel32 = koffi.load('kernel32.dll');
  const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hWnd, uint32_t *lpdwProcessId)');
  const pidBuf = Buffer.alloc(4);
  pidBuf.writeUInt32LE(0, 0);
  const n = GetWindowThreadProcessId(hwnd, pidBuf);
  L('GetWindowThreadProcessId ret=' + n + ' pid=' + pidBuf.readUInt32LE(0));

  const OpenProcess = kernel32.func('void * __stdcall OpenProcess(uint32_t a, bool b, uint32_t c)');
  const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *h, uint32_t f, uint16_t *name, uint32_t *size)');
  const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *h)');
  const h = OpenProcess(0x1000, false, pidBuf.readUInt32LE(0));
  L('OpenProcess     = ' + String(h) + ' typeof=' + typeof h);
  if (h) {
    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeUInt32LE(2047, 0);
    const nameBuf = Buffer.alloc(4096);
    const ok = QueryFullProcessImageNameW(h, 0, nameBuf, sizeBuf);
    const len = sizeBuf.readUInt32LE(0);
    L('QueryFullProcessImageNameW ok=' + ok + ' path=' + nameBuf.toString('utf16le', 0, len * 2));
    CloseHandle(h);
  }

  const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void *hWnd, uint16_t *lpString, int nMaxCount)');
  const tb = Buffer.alloc(4096);
  const tn = GetWindowTextW(hwnd, tb, 2047);
  L('GetWindowTextW  = n=' + tn + ' title="' + tb.toString('utf16le', 0, Math.max(0, tn) * 2) + '"');

  const GetAsyncKeyState = user32.func('int16_t __stdcall GetAsyncKeyState(int vKey)');
  L('GetAsyncKeyState(VK_ESCAPE) = ' + GetAsyncKeyState(0x1B) + ' typeof=' + typeof GetAsyncKeyState(0x1B));
  L('PROBE=DONE');
} catch (e) {
  L('PROBE=FAIL ' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join(' || ') : String(e)));
}

fs.writeFileSync(path.join(__dirname, '..', '_probe2.txt'), out.join('\n'), 'utf8');
