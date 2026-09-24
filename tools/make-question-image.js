'use strict';
/* ------------------------------------------------------------------
 * 生成一张「照片式题目」样图（大字号、白底黑字），用于：
 *   1. 测试图片识别的准确率（贴近真实使用场景）
 *   2. 给用户一个"点这里试试"的示例
 *
 * 用法：node_modules/.bin/electron tools/make-question-image.js [输出.png]
 * 不指定输出时写到 assets/sample-question.png
 * ------------------------------------------------------------------ */
const fs = require('fs');
const path = require('path');
const electron = require('electron');
if (!electron.app) {
  console.error('请用 electron 运行：node node_modules/electron/dist/electron.exe tools/make-question-image.js');
  process.exit(1);
}
const { app, BrowserWindow } = electron;

const HTML = '<!doctype html><meta charset="utf-8"><body style="margin:0">' +
  '<div style="width:980px;padding:52px 60px;background:#fff;' +
  "font:34px/1.9 'Microsoft YaHei','Microsoft YaHei UI',sans-serif;color:#111\">" +
  '<div style="font-size:22px;color:#777;margin-bottom:14px">例题（选择题）</div>' +
  '<div>已知 a+b=3，ab=2，则 a²+b² 的值为（&nbsp;&nbsp;&nbsp;）</div>' +
  '<div style="margin-top:20px">A. 3&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;B. 4</div>' +
  '<div style="margin-top:12px">C. 5&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;D. 6</div>' +
  '<div style="margin-top:34px">解：a²+b²=(a+b)²−2ab=3²−2×2=9−4=5，故选 C。</div>' +
  '</div></body>';

app.whenReady().then(async () => {
  /* electron 会把 --no-sandbox 之类的开关也塞进 argv，取最后一个非开关参数 */
  const userArgs = process.argv.slice(2).filter((a) => a && a.charAt(0) !== '-');
  const out = userArgs.length ? userArgs[userArgs.length - 1]
    : path.join(__dirname, '..', 'assets', 'sample-question.png');

  const win = new BrowserWindow({
    width: 980, height: 560, show: false,
    webPreferences: { offscreen: true }
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML));
  await new Promise((r) => setTimeout(r, 800));
  let img = await win.webContents.capturePage();
  if (!img || img.isEmpty()) {
    /* 离屏渲染在某些机器上不产帧，退回"短暂显示再截" */
    win.show();
    await new Promise((r) => setTimeout(r, 700));
    img = await win.webContents.capturePage();
  }
  fs.writeFileSync(out, img.toPNG());
  const size = img.getSize();
  console.log('OK ' + out + ' ' + size.width + 'x' + size.height);
  app.exit(0);
}).catch((e) => {
  console.error('FAIL ' + (e && e.message ? e.message : String(e)));
  app.exit(1);
});
