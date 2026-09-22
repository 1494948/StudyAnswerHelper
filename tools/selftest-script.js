/* 渲染进程交互级自检脚本（由主进程 executeJavaScript 注入执行）
   覆盖：视图渲染、真实点击命中（elementFromPoint）、真实点击翻转、
         表单落盘（内存 → 磁盘）、默认隐藏态、主题、布局、滚动可达性 */
(async () => {
  const out = { pass: [], fail: [], info: {} };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);

  async function step(name, fn) {
    try {
      const r = await fn();
      out.pass.push(name + (r ? ' → ' + r : ''));
    } catch (e) {
      out.fail.push(name + ' → ' + (e && e.message ? e.message : String(e)));
    }
  }
  function assert(cond, msg) {
    if (!cond) throw new Error(msg || '断言失败');
  }

  /* 用户能不能真的点到（elementFromPoint 命中判定，程序化 click 测不出来） */
  function reachable(sel) {
    const el = q(sel);
    if (!el) return { sel: sel, ok: false, why: '元素不存在' };
    try { el.scrollIntoView({ block: 'center' }); } catch (_) { /* 忽略 */ }
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return { sel: sel, ok: false, why: '尺寸为 0（不可见）' };
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return { sel: sel, ok: false, why: '中心点在视口外 (' + cx + ',' + cy + ')' };
    const top = document.elementFromPoint(cx, cy);
    const ok = top === el || el.contains(top) || (top && top.contains(el));
    return { sel: sel, ok: ok, top: top ? top.tagName + '.' + String(top.className || '').split(' ')[0] : null, why: ok ? '' : '被 ' + (top ? top.tagName + '.' + top.className : 'null') + ' 遮挡' };
  }

  async function hitTest(list) {
    const bad = [];
    for (const s of list) {
      const r = reachable(s);
      if (!r.ok) bad.push(s + '(' + (r.why || r.top) + ')');
    }
    assert(bad.length === 0, '点不到的元素：' + bad.join('、'));
    return list.length + ' 个元素全部可点击';
  }

  /* 在元素中心"真的点一下"（走 elementFromPoint，能测出被遮挡） */
  async function clickCenter(sel) {
    const r = reachable(sel);
    assert(r.ok, sel + ' 点不到：' + (r.why || r.top));
    const el = q(sel);
    const b = el.getBoundingClientRect();
    const top = document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2));
    assert(top, sel + ' 中心点没有任何元素');
    const label = top.closest('label');
    (label || top).click();
    return top.tagName + '.' + String(top.className || '').split(' ')[0];
  }

  const lum = (c) => {
    const m = String(c).match(/\d+/g) || [0, 0, 0];
    return (Number(m[0]) + Number(m[1]) + Number(m[2])) / 3;
  };

  /* 1. 三个标签页都能渲染出真实内容（不是空白面板） */
  for (const tab of ['queue', 'history', 'settings']) {
    await step('视图渲染 ' + tab, async () => {
      window.App.go(tab);
      await wait(220);
      const pane = q('.pane[data-pane="' + tab + '"]');
      assert(pane, '找不到面板');
      assert(!pane.hidden, '面板仍处于隐藏状态');
      const pr = pane.getBoundingClientRect();
      assert(pr.width > 100 && pr.height > 100, '面板尺寸异常 ' + Math.round(pr.width) + '×' + Math.round(pr.height));
      assert(pane.querySelector('.pane-head') || pane.querySelector('.setgroup-title'), '面板缺少标题/分组标题');
      const host = pane.querySelector('.list');
      if (host) {
        assert(host.children.length > 0, '内容容器既没有数据也没有空状态提示（完全空白）');
      } else {
        assert(pane.querySelectorAll('.setgroup').length >= 3, '设置页分组数量不足');
      }
      return '内容 ' + (host ? host.children.length + ' 项' : pane.querySelectorAll('.setgroup').length + ' 组') + ' / ' + Math.round(pr.height) + 'px 高';
    });
  }

  /* 2. 主界面命中测试 */
  await step('命中测试：主编辑区', async () => {
    window.App.go('queue');
    await wait(240);
    return await hitTest(['#answerBox', '#insertBtn', '#nextBtn', '#cleanupSel', '#pasteBtn', '#clearBtn', '#autoSwitch', '#autoChk']);
  });
  await step('命中测试：答案队列面板', async () => {
    window.App.go('queue');
    await wait(240);
    return await hitTest(['#queueAddBtn', '.tab[data-tab="history"]', '.tab[data-tab="settings"]', '#themeSel']);
  });
  await step('命中测试：设置面板', async () => {
    window.App.go('settings');
    await wait(260);
    return await hitTest(['#hotkeyMainSel', '#countdownSel', '#matchTitlesInp', '#addMatchBtn2', '#restartEngineBtn', '#openDataBtn', '#autoLaunchChk', '#trayChk']);
  });

  /* 3. 开关能被"真的点击"并且状态确实翻转 */
  await step('开关真实点击可翻转', async () => {
    window.App.go('settings');
    await wait(260);
    const box = q('#autoLaunchChk');
    const before = box.checked;
    const where = await clickCenter('#autoLaunchChk');
    await wait(450);
    const after = q('#autoLaunchChk').checked;
    assert(after !== before, '点开关没反应（' + before + ' → ' + after + '），命中层=' + where);
    await clickCenter('#autoLaunchChk');     /* 还原 */
    await wait(420);
    assert(q('#autoLaunchChk').checked === before, '开关没能还原到初始状态');
    return '命中层 ' + where + '，' + before + ' → ' + after + ' → 还原';
  });

  /* 4. 小窗口下设置页必须能滚动，否则末尾的开关够不到 */
  await step('设置面板内容超出时可滚动', async () => {
    window.App.go('settings');
    await wait(240);
    const pane = q('.pane[data-pane="settings"]');
    const ov = getComputedStyle(pane).overflowY;
    assert(ov === 'auto' || ov === 'scroll', '设置面板没有滚动能力（overflow-y=' + ov + '），窗口变小时下面的开关会点不到');
    const last = reachable('#autoLaunchRow .switch');
    assert(last.ok, '滚动后仍够不到"开机自动启动"：' + (last.why || last.top));
    return 'overflow-y=' + ov + '，末尾开关可达';
  });

  /* 5. 默认隐藏态：倒计时浮层不能常驻 */
  await step('默认隐藏态', async () => {
    const cd = q('#countdown');
    assert(cd, '找不到倒计时层');
    assert(getComputedStyle(cd).display === 'none', '倒计时层默认没有隐藏（会挡住下方按钮）');
    const toasts = q('.toasts');
    assert(getComputedStyle(toasts).pointerEvents === 'none', '提示层会拦截点击');
    /* "加入识别名单"的显隐取决于当前有没有读到"未命中的前台窗口"：
       读到了就该显示（好让用户点一下加进名单），没读到才该隐藏 */
    const addBtn = q('#addMatchBtn');
    const st = window.App.state() || {};
    const f = st.fg || {};
    const hasFg = !!(f.title || f.proc);
    if (f.matched) assert(addBtn.hidden === true, '已识别为学习通时不该再显示"加入识别名单"');
    else if (hasFg) assert(addBtn.hidden === false, '读到了未命中的前台窗口，就该显示"加入识别名单"');
    else assert(addBtn.hidden !== false, '没读到前台窗口时应隐藏"加入识别名单"');
    return '倒计时隐藏 / 提示层不拦点击 / 识别按钮显隐正确（fg=' + (f.proc || '无') + '）';
  });

  /* 6. 大框内容落盘（内存 + 主进程） */
  await step('大框内容写入与持久化', async () => {
    window.App.go('queue');
    await wait(200);
    const box = q('#answerBox');
    box.value = '测试内容 √3 + 1/2';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(900);
    const st = await window.sp.getState();
    assert(st.draft === box.value, '主进程里的草稿与界面不一致：' + JSON.stringify(st.draft));
    assert(q('#charCount').textContent.indexOf(String(box.value.length)) === 0, '字数统计没更新');
    return 'draft=' + st.draft;
  });

  /* 7. 真的写到磁盘上了吗
        注意：窗口被其他程序挡住时，Chromium 会把渲染进程的定时器降频到约 1 秒，
        于是"输入 → 渲染层防抖 320ms → 主进程落盘 160ms"整条链路会明显变慢。
        所以这里改成轮询等待（最多 4 秒），断言"最终一定会落盘"，而不是盯着某个瞬间。 */
  await step('草稿已写入磁盘文件', async () => {
    let p = null;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      p = await window.sp.probe();
      if (p.hasFile && p.draft === '测试内容 √3 + 1/2') break;
      await wait(250);
    }
    out.info.probe = p;
    assert(p.hasFile, '数据文件不存在：' + p.file);
    assert(p.draft === '测试内容 √3 + 1/2', '等待 4 秒后磁盘里的草稿仍不对：' + JSON.stringify(p.draft));
    return 'file=' + p.file;
  });

  /* 7b. 回归：窗口没获得系统焦点时，主进程推状态不能把还没落盘的编辑清掉
         （真实触发条件就是"前台窗口一变，引擎上报 → 主进程 pushState"） */
  await step('状态推送不会清空未落盘的编辑', async () => {
    window.App.go('queue');
    await wait(200);
    const box = q('#answerBox');
    const text = '这行字不能被状态推送清掉 ' + Date.now();
    box.value = text;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    for (let i = 0; i < 3; i++) {
      await window.sp.setSettings({ countdownSec: 3 });   /* 每次都会让主进程 pushState */
      await wait(60);
    }
    await wait(800);
    assert(box.value === text, '大框内容被状态推送覆盖了：期望『' + text + '』实际『' + box.value + '』');
    const st2 = await window.sp.getState();
    assert(st2.draft === text, '主进程里的草稿没跟上：' + JSON.stringify(st2.draft));
    return '内容保住了，draft=' + text.slice(0, 10) + '…';
  });

  /* 8. 存为队列 + 顺序输入开关 */
  await step('答案队列：存一条 + 开启顺序输入', async () => {
    q('#queueAddBtn').click();
    await wait(500);
    let st = await window.sp.getState();
    assert(st.queue.length === 1, '队列条数不对：' + st.queue.length);
    q('#queueModeChk').checked = true;
    q('#queueModeChk').dispatchEvent(new Event('change', { bubbles: true }));
    await wait(500);
    st = await window.sp.getState();
    assert(st.queueMode === true, '顺序输入开关没有生效');
    assert(q('#queueList').innerHTML.indexOf('qitem') >= 0, '队列列表没有渲染出条目');
    return '队列 ' + st.queue.length + ' 条，mode=' + st.queueMode;
  });

  /* 9. 设置项生效 */
  await step('设置项：清理级别 / 逐字间隔 / 热键', async () => {
    window.App.go('settings');
    await wait(220);
    const cs = q('#cleanupSel');
    cs.value = 'medium';
    cs.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(420);
    const ds = q('#delaySel2');
    ds.value = '30';
    ds.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(420);
    const st = await window.sp.getState();
    assert(st.settings.cleanup === 'medium', '清理级别未生效：' + st.settings.cleanup);
    assert(st.settings.charDelayMs === 30, '逐字间隔未生效：' + st.settings.charDelayMs);
    assert(st.settings.hotkeyMain, '热键预设缺失');
    return 'cleanup=' + st.settings.cleanup + ' delay=' + st.settings.charDelayMs + ' hotkey=' + st.hotkeys.main;
  });

  /* 10. 窗口识别名单编辑 */
  await step('识别名单可编辑并保存', async () => {
    const inp = q('#matchTitlesInp');
    inp.value = '学习通，超星，我的测试窗口';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(900);
    const st = await window.sp.getState();
    assert(st.settings.matchTitles.join(',') === '学习通,超星,我的测试窗口', '标题关键词没保存：' + JSON.stringify(st.settings.matchTitles));
    return st.settings.matchTitles.length + ' 个标题关键词';
  });

  /* 11. 历史面板：空状态与计数都要有内容 */
  await step('历史面板空状态可见', async () => {
    window.App.go('history');
    await wait(240);
    const host = q('#historyList');
    assert(host.children.length >= 1, '历史列表完全空白');
    assert(host.querySelector('.empty') || host.querySelector('.hitem'), '历史列表既没有记录也没有空状态说明');
    assert(q('#historyCount').textContent.length > 0, '历史条数计数没有文字');
    return '计数="' + q('#historyCount').textContent + '" / ' + host.textContent.trim().slice(0, 18) + '…';
  });

  /* 12. 提示条 */
  await step('提示条可显示', async () => {
    window.App.toast('自检提示', 'ok');
    await wait(120);
    assert(document.querySelectorAll('.toast').length >= 1, '提示条没有出现');
    return document.querySelectorAll('.toast').length + ' 条';
  });

  /* 13. 深浅两套主题 */
  await step('深色主题切换', async () => {
    window.__SP_SET_THEME__('dark');
    await wait(260);
    assert(document.documentElement.getAttribute('data-theme') === 'dark', 'data-theme 没切到 dark');
    const bg = getComputedStyle(document.body).backgroundColor;
    assert(lum(bg) < 80, '深色背景不够暗：' + bg);
    const inkLum = lum(getComputedStyle(document.body).color);
    assert(inkLum > 150, '深色下文字不够亮：' + getComputedStyle(document.body).color);
    return 'bg=' + bg;
  });
  await step('浅色主题切换', async () => {
    window.__SP_SET_THEME__('light');
    await wait(260);
    assert(document.documentElement.getAttribute('data-theme') === 'light', 'data-theme 没切回 light');
    const bg = getComputedStyle(document.body).backgroundColor;
    assert(lum(bg) > 180, '浅色背景不够亮：' + bg);
    return 'bg=' + bg;
  });

  /* 14. 布局不溢出 */
  await step('布局：无明显溢出', async () => {
    const c = q('.composer');
    const box = q('#answerBox');
    const rb = box.getBoundingClientRect();
    assert(rb.height > 150, '大输入框高度过小：' + rb.height);
    assert(c.scrollWidth <= c.clientWidth + 2, '主区出现横向滚动');
    const side = q('.side');
    assert(side.getBoundingClientRect().width >= 300, '侧栏宽度异常');
    return '输入框 ' + Math.round(rb.height) + 'px 高';
  });

  out.info.errors = window.__SP_ERRORS__;
  out.info.fg = window.App.state() ? window.App.state().fg : null;
  out.info.engine = window.App.state() ? window.App.state().engine : null;
  if (out.info.errors.length) out.fail.push('渲染层 JS 错误：' + out.info.errors.join(' | '));
  return JSON.stringify(out);
})()
