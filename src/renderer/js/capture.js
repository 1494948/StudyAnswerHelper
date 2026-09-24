'use strict';
/* 框选截图窗口：拖出矩形 → 把选区交回主进程裁剪 */
(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.cap;

  const MIN = 8;                 /* 小于这个尺寸视为误触 */

  let stage = { width: window.innerWidth, height: window.innerHeight };
  let dragging = false;
  let sx = 0;
  let sy = 0;
  let rect = null;               /* {x, y, w, h}（相对窗口的 CSS 像素） */
  let locked = false;            /* 已松手但还没回传，防止重复提交 */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function paint() {
    const sel = $('sel');
    const cross = $('cross');
    if (!rect || rect.w < 1 || rect.h < 1) {
      sel.hidden = true;
      cross.hidden = false;
      return;
    }
    sel.hidden = false;
    sel.style.left = rect.x + 'px';
    sel.style.top = rect.y + 'px';
    sel.style.width = rect.w + 'px';
    sel.style.height = rect.h + 'px';
    $('sizeTag').textContent = rect.w + ' × ' + rect.h;
    /* 选区底部离屏幕下沿太近时，尺寸标签翻到内侧 */
    sel.classList.toggle('flip', rect.y + rect.h > stage.height - 34);
  }

  function setCross(x, y) {
    const cross = $('cross');
    cross.hidden = false;
    cross.querySelector('.cx').style.left = x + 'px';
    cross.querySelector('.cy').style.top = y + 'px';
  }

  function fromPoints(x1, y1, x2, y2) {
    const x = Math.min(x1, x2);
    const y = Math.min(y1, y2);
    return {
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(Math.abs(x2 - x1)),
      h: Math.round(Math.abs(y2 - y1))
    };
  }

  function submit() {
    if (locked || !rect || rect.w < MIN || rect.h < MIN) return;
    locked = true;
    $('busy').hidden = false;
    $('busyText').textContent = '正在识别题目…';
    $('hint').hidden = true;
    $('cross').hidden = true;
    /* 把窗口的 CSS 尺寸一起报回去：主进程要靠它把选区映射到截图的真实像素 */
    api.done({
      rect: rect,
      view: { width: window.innerWidth, height: window.innerHeight }
    });
  }

  function onDown(e) {
    if (e.button !== 0) return;
    dragging = true;
    sx = e.clientX;
    sy = e.clientY;
    rect = null;
    paint();
    setCross(sx, sy);
    e.preventDefault();
  }

  function onMove(e) {
    setCross(e.clientX, e.clientY);
    if (!dragging) return;
    rect = fromPoints(sx, sy, e.clientX, e.clientY);
    paint();
  }

  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    rect = fromPoints(sx, sy, e.clientX, e.clientY);
    paint();
    if (!rect || rect.w < MIN || rect.h < MIN) {
      rect = null;
      paint();
      return;
    }
    /* 松手即识别（用户要的是"一步到位"）；仍保留 Enter 给想再确认的人 */
    submit();
  }

  document.addEventListener('mousedown', onDown);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      locked = true;
      api.cancel();
      return;
    }
    if (e.key === 'Enter' && rect) {
      e.preventDefault();
      submit();
    }
  });

  window.addEventListener('blur', () => {
    /* 失去焦点多半是被别的窗口抢走（或用户切走了），直接取消可避免留下一个挡屏的空壳。
       但窗口刚 show() 出来时会有一瞬间没有焦点，冒然取消会让用户白按一次，
       所以延迟复查一次。 */
    setTimeout(() => {
      if (!locked && !document.hasFocus()) {
        locked = true;
        api.cancel();
      }
    }, 350);
  });

  window.addEventListener('resize', () => {
    stage = { width: window.innerWidth, height: window.innerHeight };
    paint();
  });

  api.onBg((d) => {
    const img = $('bg');
    img.src = d.dataUrl;
    /* 1:1 按屏幕真实像素放置，保证选框坐标与屏幕内容严格对应。
       窗口可能比屏幕矮（任务栏占位），底图**不能**跟着缩放：
       缩放会让"用户框的位置"和"实际裁到的内容"错位。 */
    if (d.width) img.style.width = d.width + 'px';
    if (d.height) img.style.height = d.height + 'px';
    stage = { width: d.width || window.innerWidth, height: d.height || window.innerHeight };
    $('busy').hidden = true;
    $('hint').hidden = false;
    $('cross').hidden = false;
  });

  api.onFail((msg) => {
    $('busy').hidden = false;
    $('busyText').textContent = '截图失败：' + msg + '（按 Esc 退出）';
  });
})();
