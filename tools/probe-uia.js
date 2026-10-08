'use strict';
/* 探测工具：把某个窗口的无障碍元素清单导出来，用于校准"公式/代码按钮"的名字。
 *
 * 为什么需要它：
 *   学习通各版本的编辑器工具栏按钮名不一样（"公式" / "插入公式" / 只有一个 π 图标…），
 *   而"按名字点按钮"是本机唯一可靠的做法。先用这个工具把真实按钮名读出来，
 *   再填进设置里的按钮名列表，比盲猜稳得多。
 *
 * 用法：
 *   node tools/probe-uia.js --list                 列出当前可见的顶层窗口
 *   node tools/probe-uia.js --match 学习通           找标题含"学习通"的窗口并导出元素
 *   node tools/probe-uia.js --hwnd 123456          导出指定窗口的元素
 *   node tools/probe-uia.js --match 学习通 --all     连没名字的元素一起导出（默认只导出有名字的）
 *   node tools/probe-uia.js --match 学习通 --json report.json
 *
 * 注意：跑之前请把学习通答题页切到前台、并停在能看到工具栏的那一屏。
 */

const fs = require('fs');
const path = require('path');
const uia = require(path.join(__dirname, '..', 'src', 'main', 'lib', 'uia-tool.js'));

function argOf(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

function shorten(s, n) {
  const t = String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/* 只保留"可能是工具按钮"的元素，方便人眼扫 */
const LIKELY = /公式|代码|插入|符号|编辑|math|formula|code|latex|equation|π|∑|∫/i;

async function main() {
  const all = !!argOf('all', false);
  const jsonOut = typeof argOf('json', '') === 'string' ? argOf('json', '') : '';
  let hwnd = parseInt(argOf('hwnd', 0), 10) || 0;
  const match = typeof argOf('match', '') === 'string' ? String(argOf('match', '')) : '';

  if (argOf('list', false)) {
    const res = await uia.listWindows();
    if (!res.ok) { console.error('列出窗口失败：' + uia.describe(res, '窗口')); process.exit(1); }
    console.log('可见顶层窗口 ' + res.windows.length + ' 个：\n');
    console.log('  hwnd      pid     类名                          标题');
    for (const w of res.windows) {
      console.log('  ' + String(w.hwnd).padEnd(9) + String(w.pid).padEnd(9) +
        shorten(w.cls, 28).padEnd(30) + shorten(w.name, 60));
    }
    console.log('\n选一个 hwnd 再跑：node tools/probe-uia.js --hwnd <hwnd>');
    return;
  }

  if (!hwnd && match) {
    const res = await uia.listWindows();
    if (!res.ok) { console.error('列出窗口失败：' + uia.describe(res, '窗口')); process.exit(1); }
    const hit = res.windows.find(function (w) { return String(w.name).indexOf(match) >= 0; });
    if (!hit) {
      console.error('没有标题含「' + match + '」的窗口。先跑 --list 看看有哪些窗口。');
      console.error('提示：学习通在浏览器里时，窗口标题通常是「xxx - Google Chrome」或「xxx - Microsoft Edge」，');
      console.error('      用浏览器名或页面标题的关键字来 --match。');
      process.exit(2);
    }
    hwnd = hit.hwnd;
    console.log('匹配到窗口：' + hit.name + '  (hwnd=' + hwnd + ')\n');
  }

  if (!hwnd) {
    console.error('请用 --list / --match <关键字> / --hwnd <数字> 指定目标窗口。');
    process.exit(2);
  }

  const res = await uia.dump(hwnd, { max: all ? 3000 : 1200 });
  if (!res.ok) {
    console.error('导出失败：' + uia.describe(res, '元素'));
    console.error('  原始返回：' + JSON.stringify(res));
    if (res.code === 'not-found') {
      console.error('  读到 ' + (res.scanned || 0) + ' 个控件，根窗口：' + JSON.stringify(res.roots || []));
    }
    process.exit(1);
  }

  const items = res.elements || [];
  console.log('扫描到 ' + res.scanned + ' 个控件 / 导出 ' + items.length + ' 条（尝试 ' + res.attempts + ' 轮）\n');

  const byType = {};
  for (const e of items) {
    const t = e.type || '?';
    byType[t] = byType[t] || [];
    byType[t].push(e);
  }

  /* 先单独列出"疑似工具按钮"，这是用户最关心的 */
  const likely = items.filter(function (e) { return e.name && LIKELY.test(e.name); });
  console.log('=== 疑似公式/代码相关的元素（' + likely.length + ' 条） ===');
  if (!likely.length) {
    console.log('  （没有）—— 说明这个窗口可能还没渲染完，或该页面没把工具栏暴露给无障碍接口');
  }
  for (const e of likely) {
    console.log('  [' + (e.type + ')').padEnd(14) + ' pat=' + String(e.patterns || '-').padEnd(28) +
      ' ' + shorten(e.name, 40) + '   @' + e.x + ',' + e.y + ' ' + e.w + 'x' + e.h);
  }

  console.log('\n=== 有名字的元素（按类型分组，最多每类 40 条） ===');
  const types = Object.keys(byType).sort();
  for (const t of types) {
    const list = byType[t].filter(function (e) { return e.name; });
    if (!list.length) continue;
    console.log('\n-- ' + t + ' (' + list.length + ') --');
    for (const e of list.slice(0, 40)) {
      console.log('   ' + shorten(e.name, 46).padEnd(48) + ' pat=' + (String(e.patterns || '-') || '-') +
        '  ' + e.w + 'x' + e.h);
    }
    if (list.length > 40) console.log('   … 另有 ' + (list.length - 40) + ' 条');
  }

  if (jsonOut) {
    const report = {
      at: new Date().toISOString(),
      hwnd: hwnd,
      scanned: res.scanned,
      roots: res.roots,
      count: items.length,
      likely: likely,
      elements: items
    };
    fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2), 'utf8');
    console.log('\n完整清单已写入：' + jsonOut);
  }
}

main().catch(function (e) {
  console.error('探测失败：' + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});
