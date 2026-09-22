'use strict';
/* 渲染层：状态 → 视图，所有动作都通过 window.sp 走主进程 */
(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.sp;

  /* 收集渲染层错误，自检时断言为 0 */
  window.__SP_ERRORS__ = [];
  window.addEventListener('error', (e) => window.__SP_ERRORS__.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => window.__SP_ERRORS__.push('rejection: ' + ((e.reason && e.reason.message) || e.reason)));

  if (!api) {
    document.body.innerHTML = '<div style="padding:40px;font:14px sans-serif">未检测到应用桥接（preload 未加载），请在应用窗口中打开。</div>';
    return;
  }

  const H = { state: null, fg: null, auto: { active: false, remain: 0, why: '' }, themePref: 'system', tab: 'queue' };
  const THEME_KEY = 'sah-theme-pref';

  /* ---------------- 工具 ---------------- */
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function debounce(fn, ms) {
    let t = null;
    return function () {
      const args = arguments;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(null, args), ms);
    };
  }
  function preview(s, n) {
    const one = String(s || '').replace(/\n/g, ' ⏎ ');
    return one.length > n ? one.slice(0, n) + '…' : one;
  }
  function showToast(msg, kind) {
    const box = $('toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || 'info');
    el.textContent = msg;
    box.appendChild(el);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 6000);
  }

  /* ---------------- 主题 ---------------- */
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  function resolveTheme(pref) {
    if (pref === 'dark') return 'dark';
    if (pref === 'light') return 'light';
    return mq.matches ? 'dark' : 'light';
  }
  function setTheme(pref, notifyMain) {
    H.themePref = pref || 'system';
    const mode = resolveTheme(H.themePref);
    document.documentElement.setAttribute('data-theme', mode);
    document.documentElement.setAttribute('data-theme-pref', H.themePref);
    document.documentElement.style.colorScheme = mode;
    try { localStorage.setItem(THEME_KEY, H.themePref); } catch (_) { /* 忽略 */ }
    const sel = $('themeSel');
    if (sel && sel.value !== H.themePref) sel.value = H.themePref;
    if (notifyMain) api.setSettings({ theme: H.themePref }).then(applyState);
  }
  mq.addEventListener('change', () => { if (H.themePref === 'system') setTheme('system', false); });

  /* ---------------- 标签页 ---------------- */
  function switchTab(tab) {
    if (['queue', 'history', 'settings'].indexOf(tab) < 0) return;
    H.tab = tab;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), (b) => {
      b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.pane'), (p) => {
      p.hidden = p.getAttribute('data-pane') !== tab;
    });
  }

  /* ---------------- 渲染：输入区 ---------------- */
  function renderComposer(st) {
    const box = $('answerBox');
    /* 关键：本地有"尚未落盘"的编辑时，绝不能被主进程推来的旧状态盖掉。
       早期用 document.activeElement 判断是否正在编辑 —— 但窗口没有系统焦点时
       它恒为 false，于是每来一次状态推送就把用户刚敲的字清回旧值，静默丢答案。 */
    if (box.dataset.dirty === '1') {
      if (st.draft === box.value) box.dataset.dirty = '0';   /* 主进程已确认同值，恢复同步 */
    } else if (box.value !== (st.draft || '')) {
      box.value = st.draft || '';
    }
    $('charCount').textContent = (box.value || '').length + ' 字';

    const q = st.queue || [];
    const hint = st.queueMode && q.length
      ? '顺序输入：第 ' + (st.queueIndex + 1) + ' / ' + q.length + ' 条'
      : '';
    $('queueHint').textContent = hint;

    $('kbdMain').textContent = st.hotkeys.main;
    $('kbdNext').textContent = st.hotkeys.next;
    $('autoChk').checked = !!st.settings.autoMode;
    $('autoHint').textContent = '切到学习通窗口后自动倒计时输入（' + (st.settings.countdownSec || 3) + ' 秒，Esc 可取消）';

    fillSelect($('cleanupSel'), st.labels.cleanup, String(st.settings.cleanup));
    fillSelect($('delaySel'), st.labels.delay, String(st.settings.charDelayMs));
  }

  function fillSelect(sel, map, value) {
    if (!sel || !map) return;
    const keys = Object.keys(map);
    const sig = keys.join(',');
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig;
      sel.innerHTML = keys.map((k) => '<option value="' + esc(k) + '">' + esc(map[k]) + '</option>').join('');
    }
    if (value !== undefined && sel.value !== String(value)) sel.value = String(value);
  }

  /* ---------------- 渲染：前台窗口状态 ---------------- */
  function renderFg(st) {
    const f = st.fg || {};
    const dot = $('fgDot');
    dot.className = 'dot' + (f.matched ? ' ok' : (f.title ? ' warn' : ''));
    const name = f.title || f.proc || '未读到窗口';
    $('fgTitle').textContent = name;
    $('fgTitle').title = (f.title || '') + (f.proc ? '  [' + f.proc + ']' : '');
    $('fgProc').textContent = f.matched ? '已识别为学习通' : (f.proc || '—');
    $('addMatchBtn').hidden = !!f.matched || (!f.title && !f.proc);
    $('statusFg').textContent = '前台窗口：' + (f.title || f.proc || '未知') + (f.matched ? ' ✓' : '');
  }

  /* ---------------- 渲染：队列 ---------------- */
  let queueSig = '';
  function renderQueue(st, force) {
    const list = st.queue || [];
    const sig = list.map((x) => x.id + '~' + x.label + '~' + (x.text || '').slice(0, 24)).join('|') + '#' + st.queueIndex + '#' + st.queueMode;
    const host = $('queueList');
    if (sig === queueSig && !force) return;
    const act = document.activeElement;
    if (!force && act && host.contains(act)) return;   /* 正在编辑标签时不要重绘 */
    queueSig = sig;
    $('queueModeChk').checked = !!st.queueMode;
    $('queueCount').textContent = list.length ? ('共 ' + list.length + ' 条') : '';
    if (!list.length) {
      host.innerHTML = '<div class="empty">还没有存答案。<br>把答案写进左边大框，点上面的「大框内容存为一条」即可添加。</div>';
      return;
    }
    host.innerHTML = list.map((it, i) => '' +
      '<div class="qitem' + (st.queueMode && i === st.queueIndex ? ' active' : '') + '" data-id="' + esc(it.id) + '" data-i="' + i + '">' +
        '<div class="qitem-top">' +
          '<input class="q-label" value="' + esc(it.label || ('第 ' + (i + 1) + ' 条')) + '" spellcheck="false">' +
        '</div>' +
        '<div class="q-text" title="点两下可把这条装进大框">' + esc(preview(it.text, 90)) + '</div>' +
        '<div class="ops">' +
          '<button class="mini" data-act="use">装进大框</button>' +
          '<button class="mini" data-act="update">用大框内容更新</button>' +
          '<button class="mini" data-act="del">删除</button>' +
        '</div>' +
      '</div>').join('');
  }

  /* ---------------- 渲染：历史 ---------------- */
  function renderHistory(st) {
    const list = st.history || [];
    const host = $('historyList');
    const cnt = $('historyCount');
    if (cnt) cnt.textContent = list.length ? ('共 ' + list.length + ' 条') : '暂无记录';
    if (!list.length) {
      host.innerHTML = '<div class="empty">还没有输入记录。<br>每次成功输入的内容都会自动留在这里，<br>点「回填到大框」就能再输一次。</div>';
      return;
    }
    host.innerHTML = list.map((h) => '' +
      '<div class="hitem" data-at="' + esc(h.at) + '">' +
        '<div class="h-text">' + esc(preview(h.text, 120)) + '</div>' +
        '<div class="ops">' +
          '<button class="mini" data-act="use">回填到大框</button>' +
          '<button class="mini" data-act="del">删除</button>' +
          '<span class="muted">' + esc(new Date(h.at).toLocaleString('zh-CN', { hour12: false })) + '</span>' +
        '</div>' +
      '</div>').join('');
  }

  /* ---------------- 渲染：设置 ---------------- */
  function renderSettings(st) {
    const s = st.settings || {};
    fillSelect($('hotkeyMainSel'), arrToMap(st.presets.main), s.hotkeyMain);
    fillSelect($('hotkeyNextSel'), arrToMap(st.presets.next), s.hotkeyNext);
    fillSelect($('countdownSel'), { '2': '2 秒', '3': '3 秒', '5': '5 秒', '8': '8 秒' }, String(s.countdownSec));
    fillSelect($('delaySel2'), st.labels.delay, String(s.charDelayMs));
    $('clearFirstChk').checked = !!s.clearFirst;
    $('refocusChk').checked = !!s.refocus;
    $('beepChk').checked = !!s.beep;
    $('trayChk').checked = !!s.minimizeToTray;
    $('autoLaunchChk').checked = !!s.autoLaunch;

    const tInp = $('matchTitlesInp');
    const pInp = $('matchProcsInp');
    if (document.activeElement !== tInp) tInp.value = (s.matchTitles || []).join('，');
    if (document.activeElement !== pInp) pInp.value = (s.matchProcs || []).join('，');

    const dot = $('engineDot');
    dot.className = 'dot' + (st.engine.ready ? ' ok' : ' err');
    $('engineText').textContent = st.engine.ready ? '就绪（可以正常逐字输入）' : (st.engine.error || '启动中…');
    $('dataText').textContent = st.dataFile || '';
    $('statusEngine').textContent = '输入引擎：' + (st.engine.ready ? '就绪' : (st.engine.error || '启动中…'));
    $('statusHotkey').textContent = '热键：' + st.hotkeys.main + (st.hotkeys.mainOk ? '' : '（注册失败，可能被其他软件占用）');
  }

  function arrToMap(arr) {
    const m = {};
    (arr || []).forEach((x) => { m[x.id] = x.label; });
    return m;
  }

  /* ---------------- 渲染：倒计时 ---------------- */
  function renderAuto() {
    const cd = $('countdown');
    if (H.auto.active) {
      cd.hidden = false;
      $('cdNum').textContent = String(H.auto.remain);
    } else {
      cd.hidden = true;
    }
  }

  /* ---------------- 总渲染 ---------------- */
  function applyState(st) {
    if (!st) return;
    H.state = st;
    if (st.settings && st.settings.theme !== H.themePref) setTheme(st.settings.theme, false);
    $('versionText').textContent = 'v' + st.version;
    renderFg(st);
    renderComposer(st);
    renderQueue(st, false);
    renderHistory(st);
    renderSettings(st);
    renderAuto();
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    /* 主题 */
    $('themeSel').addEventListener('change', (e) => setTheme(e.target.value, true));
    $('hideBtn').addEventListener('click', () => window.close());

    /* 大框 */
    const box = $('answerBox');
    const pushDraft = debounce(() => {
      const st = H.state;
      api.setDraft(box.value);
      if (st && st.queueMode && (st.queue || []).length) {
        const item = st.queue[Math.min(st.queueIndex, st.queue.length - 1)];
        if (item) api.queue.update(item.id, { text: box.value });
      }
    }, 320);
    box.addEventListener('input', () => {
      H.localEditAt = Date.now();
      box.dataset.dirty = '1';          /* 落盘确认之前，不允许被远端状态覆盖 */
      $('charCount').textContent = box.value.length + ' 字';
      pushDraft();
    });

    $('cleanBtn').addEventListener('click', async () => {
      const cleaned = await api.cleanText(box.value);
      box.value = cleaned;
      $('charCount').textContent = cleaned.length + ' 字';
      api.setDraft(cleaned);
      showToast('已按「' + (H.state ? H.state.labels.cleanup[H.state.settings.cleanup] : '') + '」清理内容', 'ok');
    });
    $('pasteBtn').addEventListener('click', async () => {
      const t = await api.clipboardRead();
      if (!t) { showToast('剪贴板里没有文字', 'warn'); return; }
      box.value = box.value ? (box.value.replace(/\s+$/, '') + '\n' + t) : t;
      $('charCount').textContent = box.value.length + ' 字';
      api.setDraft(box.value);
      showToast('已从剪贴板读入 ' + t.length + ' 个字', 'ok');
    });
    $('clearBtn').addEventListener('click', () => {
      box.value = '';
      $('charCount').textContent = '0 字';
      api.setDraft('');
      box.focus();
    });

    /* 触发 */
    $('insertBtn').addEventListener('click', () => api.inputNow());
    $('nextBtn').addEventListener('click', () => api.inputNext());
    $('cdCancel').addEventListener('click', () => api.autoCancel());
    $('autoChk').addEventListener('change', (e) => api.autoSet(e.target.checked).then(applyState));
    $('addMatchBtn').addEventListener('click', () => api.addCurrentToMatch());
    $('addMatchBtn2').addEventListener('click', () => api.addCurrentToMatch());

    /* 选项卡 */
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), (b) => {
      b.addEventListener('click', () => switchTab(b.getAttribute('data-tab')));
    });

    /* 队列 */
    $('queueModeChk').addEventListener('change', (e) => api.queue.setMode(e.target.checked));
    $('queueAddBtn').addEventListener('click', async () => {
      const v = box.value;
      if (!v.trim()) { showToast('大框里还没有内容', 'warn'); return; }
      const n = ((H.state && H.state.queue) || []).length + 1;
      await api.queue.add('第 ' + n + ' 条', v);
      showToast('已存为队列第 ' + n + ' 条', 'ok');
    });
    $('queueClearBtn').addEventListener('click', () => api.queue.clear());

    $('queueList').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const item = btn.closest('.qitem');
      if (!item) return;
      const id = item.getAttribute('data-id');
      const idx = parseInt(item.getAttribute('data-i'), 10);
      const act = btn.getAttribute('data-act');
      if (act === 'del') { api.queue.remove(id); return; }
      if (act === 'use') {
        const list = (H.state && H.state.queue) || [];
        const it = list[idx];
        if (!it) return;
        await api.queue.setIndex(idx);
        box.value = it.text || '';
        api.setDraft(box.value);
        $('charCount').textContent = box.value.length + ' 字';
        showToast('已装入大框：' + (it.label || ''), 'ok');
        return;
      }
      if (act === 'update') {
        await api.queue.update(id, { text: box.value });
        showToast('已用大框内容更新这条', 'ok');
      }
    });
    $('queueList').addEventListener('input', (e) => {
      const inp = e.target;
      if (!inp.classList || !inp.classList.contains('q-label')) return;
      const item = inp.closest('.qitem');
      if (!item) return;
      const id = item.getAttribute('data-id');
      const save = debounce(() => api.queue.update(id, { label: inp.value }), 400);
      save();
    });
    $('queueList').addEventListener('dblclick', (e) => {
      const t = e.target;
      if (!t.classList || !t.classList.contains('q-text')) return;
      const item = t.closest('.qitem');
      if (!item) return;
      const idx = parseInt(item.getAttribute('data-i'), 10);
      const it = ((H.state && H.state.queue) || [])[idx];
      if (it) {
        api.queue.setIndex(idx).then(() => {
          box.value = it.text || '';
          api.setDraft(box.value);
        });
      }
    });

    /* 历史 */
    $('historyClearBtn').addEventListener('click', () => api.history.clear());
    $('historyList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const item = btn.closest('.hitem');
      if (!item) return;
      const at = parseInt(item.getAttribute('data-at'), 10);
      const act = btn.getAttribute('data-act');
      if (act === 'del') { api.history.remove(at); return; }
      if (act === 'use') {
        const h = ((H.state && H.state.history) || []).find((x) => x.at === at);
        if (!h) return;
        api.setDraft(h.text);
        box.value = h.text;
        $('charCount').textContent = h.text.length + ' 字';
        showToast('已回填到大框', 'ok');
      }
    });

    /* 设置 */
    const setS = (patch) => api.setSettings(patch).then(applyState);
    $('hotkeyMainSel').addEventListener('change', (e) => setS({ hotkeyMain: e.target.value }));
    $('hotkeyNextSel').addEventListener('change', (e) => setS({ hotkeyNext: e.target.value }));
    $('countdownSel').addEventListener('change', (e) => setS({ countdownSec: parseInt(e.target.value, 10) }));
    $('delaySel').addEventListener('change', (e) => setS({ charDelayMs: parseInt(e.target.value, 10) }));
    $('delaySel2').addEventListener('change', (e) => setS({ charDelayMs: parseInt(e.target.value, 10) }));
    $('cleanupSel').addEventListener('change', (e) => setS({ cleanup: e.target.value }));
    $('clearFirstChk').addEventListener('change', (e) => setS({ clearFirst: e.target.checked }));
    $('refocusChk').addEventListener('change', (e) => setS({ refocus: e.target.checked }));
    $('beepChk').addEventListener('change', (e) => setS({ beep: e.target.checked }));
    $('trayChk').addEventListener('change', (e) => setS({ minimizeToTray: e.target.checked }));
    $('autoLaunchChk').addEventListener('change', (e) => setS({ autoLaunch: e.target.checked }));
    const saveKeywords = debounce(() => {
      const t = $('matchTitlesInp').value.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
      const p = $('matchProcsInp').value.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
      setS({ matchTitles: t, matchProcs: p });
    }, 600);
    $('matchTitlesInp').addEventListener('input', saveKeywords);
    $('matchProcsInp').addEventListener('input', saveKeywords);
    $('restartEngineBtn').addEventListener('click', async () => {
      await api.restartEngine();
      showToast('正在重启输入引擎…');
    });
    $('openDataBtn').addEventListener('click', () => api.openDataDir());

    /* 键盘：Esc 取消倒计时 / Ctrl+Enter 立即输入（窗口内的兜底） */
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && H.auto.active) { api.autoCancel(); return; }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey && e.target === box) {
        e.preventDefault();
        api.inputNow();
      }
    });
  }

  /* ---------------- 主进程事件 ---------------- */
  api.onState(applyState);
  api.onFg((f) => {
    if (H.state) { H.state.fg = f; renderFg(H.state); }
  });
  api.onAuto((d) => {
    H.auto = d || { active: false, remain: 0 };
    renderAuto();
    if (!d.active && d.why) showToast('已取消自动输入：' + d.why, 'warn');
  });
  api.onToast((t) => { if (t && t.msg) showToast(t.msg, t.kind); });
  api.onDraft((text) => {
    const box = $('answerBox');
    box.value = text || '';
    $('charCount').textContent = box.value.length + ' 字';
  });

  /* 供自动化脚本使用 */
  window.App = { go: switchTab, state: () => H.state, toast: showToast };
  window.__SP_SET_THEME__ = (mode) => setTheme(mode, false);

  /* ---------------- 启动 ---------------- */
  let bootPref = 'system';
  try { bootPref = localStorage.getItem(THEME_KEY) || 'system'; } catch (_) { /* 忽略 */ }
  setTheme(bootPref, false);
  switchTab('queue');
  bind();
  api.getState().then(applyState).catch((e) => showToast('初始化失败：' + e.message, 'error'));
})();
