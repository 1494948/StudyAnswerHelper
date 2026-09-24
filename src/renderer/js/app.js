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

  const H = {
    state: null, fg: null,
    auto: { active: false, remain: 0, why: '' },
    themePref: 'system', tab: 'queue',
    search: { active: false, candidates: [], errors: [], count: 0, ms: 0, question: '', engine: '', bankCount: 0, engines: {} }
  };
  const THEME_KEY = 'sah-theme-pref';
  const TAB_LIST = ['queue', 'search', 'history', 'settings'];
  const SOURCE_LABEL = { local: '本地题库', web: '网络检索', ai: 'AI 解答' };

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
    if (TAB_LIST.indexOf(tab) < 0) return;
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

  /* ---------------- 渲染：答案队列 ---------------- */
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

  /* ---------------- 渲染：搜答案 ---------------- */
  let searchSig = '';

  function renderSearchMeta() {
    const d = H.search || {};
    const parts = [];
    if (d.active) parts.push('检索中…');
    else if (d.at) parts.push('结果 ' + (d.count || 0) + ' 条 · ' + (d.ms || 0) + 'ms');
    if (d.engine) parts.push(d.engine);
    if (typeof d.bankCount === 'number') parts.push('题库 ' + d.bankCount + ' 条');
    $('searchMeta').textContent = parts.join(' · ');
  }

  function searchItemHtml(c, i) {
    const pct = Math.round((c.score || 0) * 100);
    const badges = ['<span class="badge ' + esc(c.source) + '">' + esc(SOURCE_LABEL[c.source] || c.source) + '</span>'];
    if (c.kind === 'answer' && c.verify) badges.push('<span class="badge suspect">疑似请核对</span>');
    if (c.source === 'web' && c.engine) badges.push('<span class="badge">' + esc(c.engine) + '</span>');
    if (c.source === 'ai' && c.model) badges.push('<span class="badge">' + esc(c.model) + '</span>');
    badges.push('<span class="score' + (pct >= 80 ? ' hi' : '') + '">相关 ' + pct + '%</span>');

    let body = '';
    if (c.kind === 'answer' && c.answer) {
      body += '<div class="ritem-answer">' + esc(c.answer) + '</div>';
    }
    if (c.detail) body += '<div class="ritem-detail">' + esc(c.detail) + '</div>';
    if (c.question) body += '<div class="ritem-title">' + esc(c.question) + '</div>';
    if (c.source === 'web' && c.title) body += '<div class="ritem-title">' + esc(c.title) + '</div>';
    if (c.source === 'web' && c.snippet) body += '<div class="ritem-snip">' + esc(c.snippet) + '</div>';
    if (c.url) body += '<div class="ritem-url">' + esc(c.url) + '</div>';

    const ops = [];
    if (c.kind === 'answer' && c.answer) {
      ops.push('<button class="mini" data-act="fill" data-i="' + i + '">填入大框</button>');
      if (c.detail) ops.push('<button class="mini" data-act="fillboth" data-i="' + i + '">答案+解析</button>');
      ops.push('<button class="mini" data-act="copy" data-i="' + i + '">复制答案</button>');
      ops.push('<button class="mini" data-act="savebank" data-i="' + i + '">存入题库</button>');
    } else {
      if (c.snippet) {
        ops.push('<button class="mini" data-act="fill" data-i="' + i + '" title="把这段摘要填进大框">摘要进大框</button>');
        ops.push('<button class="mini" data-act="copy" data-i="' + i + '">复制摘要</button>');
      }
    }
    if (c.url) ops.push('<button class="mini" data-act="open" data-i="' + i + '">打开网页</button>');

    return '<div class="ritem' + (i === 0 ? ' best' : '') + '" data-i="' + i + '">' +
      '<div class="ritem-top">' + badges.join('') + '</div>' + body +
      (ops.length ? '<div class="ops">' + ops.join('') + '</div>' : '') +
      '</div>';
  }

  function renderSearchResults(force) {
    const d = H.search || {};
    const list = d.candidates || [];
    const sig = [d.at, d.active, list.length, (d.errors || []).join('|')].join('#');
    if (sig === searchSig && !force) return;
    searchSig = sig;

    const host = $('searchResult');
    if (d.active) {
      host.innerHTML = '<div class="empty">正在检索…<br>本地题库是瞬时的；网络检索一般 1–3 秒；AI 解答可能要 10 秒以上。</div>';
      renderSearchMeta();
      return;
    }
    if (!list.length) {
      host.innerHTML = '<div class="empty">还没有结果。<br>把题目贴进上面的框，点「搜答案」。<br>最高分命中时会自动填进左边大框。</div>';
      renderSearchMeta();
      return;
    }
    const errBox = (d.errors && d.errors.length)
      ? '<div class="search-errors">' + d.errors.map(esc).join('<br>') + '</div>'
      : '';
    host.innerHTML = errBox + list.map((c, i) => searchItemHtml(c, i)).join('');
    renderSearchMeta();
  }

  /** 把一段文本写进大框（同时保持与主进程同步） */
  function setBoxValue(text) {
    const box = $('answerBox');
    box.value = text || '';
    box.dataset.dirty = '0';
    $('charCount').textContent = box.value.length + ' 字';
  }

  /* ---------------- 渲染：设置 ---------------- */
  function renderSettings(st) {
    const s = st.settings || {};
    fillSelect($('hotkeyMainSel'), arrToMap(st.presets.main), s.hotkeyMain);
    fillSelect($('hotkeyNextSel'), arrToMap(st.presets.next), s.hotkeyNext);
    fillSelect($('hotkeySearchSel'), arrToMap(st.presets.search), s.hotkeySearch);
    fillSelect($('countdownSel'), { '2': '2 秒', '3': '3 秒', '5': '5 秒', '8': '8 秒' }, String(s.countdownSec));
    fillSelect($('delaySel2'), st.labels.delay, String(s.charDelayMs));
    fillSelect($('searchEngineSel'), st.labels.searchEngine, String(s.searchEngine));
    fillSelect($('searchScoreSel'), st.labels.searchScore, String(s.searchMinScore));
    fillSelect($('searchTopSel'), st.labels.searchTop, String(s.searchTopN));
    fillSelect($('searchTimeoutSel'), { 8000: '8 秒', 20000: '20 秒', 40000: '40 秒' }, String(s.searchTimeoutMs));

    $('clearFirstChk').checked = !!s.clearFirst;
    $('refocusChk').checked = !!s.refocus;
    $('beepChk').checked = !!s.beep;
    $('trayChk').checked = !!s.minimizeToTray;
    $('autoLaunchChk').checked = !!s.autoLaunch;
    $('searchAutoFillChk').checked = !!s.searchAutoFill;

    $('srcLocalChk').checked = !!s.searchLocal;
    $('srcWebChk').checked = !!s.searchWeb;
    $('srcAiChk').checked = !!s.searchAi;

    const tInp = $('matchTitlesInp');
    const pInp = $('matchProcsInp');
    if (document.activeElement !== tInp) tInp.value = (s.matchTitles || []).join('，');
    if (document.activeElement !== pInp) pInp.value = (s.matchProcs || []).join('，');

    const bInp = $('aiBaseUrlInp');
    const mInp = $('aiModelInp');
    if (document.activeElement !== bInp) bInp.value = s.aiBaseUrl || '';
    if (document.activeElement !== mInp) mInp.value = s.aiModel || '';
    $('aiKeyState').textContent = s.aiKeySet
      ? ('密钥状态：' + (s.aiKeyHint || '已保存'))
      : '密钥状态：未保存。AI 解答需要填一个 OpenAI 兼容接口的密钥。';

    /* 搜索引擎冷却状态 */
    const eng = (st.search && st.search.engines) || {};
    const cooling = Object.keys(eng)
      .filter((k) => eng[k] && eng[k].cooldownMs > 0)
      .map((k) => eng[k].label + '（还需等 ' + Math.ceil(eng[k].cooldownMs / 1000) + ' 秒）');
    $('searchEngineState').textContent = cooling.length
      ? '注意：' + cooling.join('、') + ' 刚才触发了人机验证，暂时跳过，会自动改用其他引擎。'
      : '搜题热键：' + (st.hotkeys.search || '未设置') + (st.hotkeys.searchOk ? '' : '（注册失败，可能被其他软件占用）');

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

  /* ---------------- 题库管理弹窗 ---------------- */
  let bankItems = [];

  function renderBankList() {
    const host = $('bankList');
    if (!bankItems.length) {
      host.innerHTML = '<div class="empty">没有匹配的条目。<br>把「题目 || 答案」粘到上面的框里批量导入，<br>或者搜到答案后点「存入题库」。</div>';
      return;
    }
    host.innerHTML = bankItems.map((it) => '' +
      '<div class="qitem bank-item" data-id="' + esc(it.id) + '">' +
        '<div class="bank-texts">' +
          '<div class="bank-q">' + esc(it.question) + '</div>' +
          '<div class="bank-a">' + esc(it.answer || '（没有答案）') + '</div>' +
          '<div class="bank-meta">' + esc(it.source || 'manual') + (it.hits ? ' · 用过 ' + it.hits + ' 次' : '') + '</div>' +
        '</div>' +
        '<button class="mini danger" data-act="del">删除</button>' +
      '</div>').join('');
  }

  async function refreshBank() {
    const r = await api.bank.list($('bankSearchInp').value, 500);
    bankItems = (r && r.items) || [];
    $('bankCount').textContent = '共 ' + ((r && r.count) || 0) + ' 条';
    renderBankList();
  }

  async function openBank() {
    $('bankModal').hidden = false;
    await refreshBank();
  }
  function closeBank() { $('bankModal').hidden = true; }
  function bankOpen() { return !$('bankModal').hidden; }

  /* ---------------- 总渲染 ---------------- */
  function applyState(st) {
    if (!st) return;
    H.state = st;
    if (st.settings && st.settings.theme !== H.themePref) setTheme(st.settings.theme, false);
    $('versionText').textContent = 'v' + st.version;
    /* 状态推送里的 search 只是摘要（没有候选明细），合并进本地缓存 */
    const s = st.search || {};
    H.search = Object.assign({}, H.search, {
      active: !!s.active, at: s.at, ms: s.ms, count: s.count,
      question: s.question || H.search.question,
      engine: s.engine, errors: s.errors || [], query: s.query,
      bankCount: s.bankCount, engines: s.engines || {}
    });
    /* 主进程搜索时用的是它自己的题目，界面上没改过就跟着同步 */
    const qb = $('questionBox');
    if (qb.dataset.dirty !== '1' && H.search.question && qb.value !== H.search.question) {
      qb.value = H.search.question;
    }
    renderFg(st);
    renderComposer(st);
    renderQueue(st, false);
    renderHistory(st);
    renderSettings(st);
    renderAuto();
    renderSearchResults(false);
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

    /* 搜答案：题目框 */
    const qb = $('questionBox');
    qb.addEventListener('input', () => { qb.dataset.dirty = '1'; });
    $('qPasteBtn').addEventListener('click', async () => {
      const t = (await api.clipboardRead()) || '';
      if (!t.trim()) { showToast('剪贴板里没有文字', 'warn'); return; }
      qb.value = t.trim();
      qb.dataset.dirty = '1';
      showToast('已读入题目（' + qb.value.length + ' 字）', 'ok');
    });
    $('qClearBtn').addEventListener('click', () => {
      qb.value = '';
      qb.dataset.dirty = '1';
      qb.focus();
    });
    $('qUseDraftBtn').addEventListener('click', () => {
      const t = box.value;
      if (!t.trim()) { showToast('大框里还没有内容', 'warn'); return; }
      qb.value = t;
      qb.dataset.dirty = '1';
      showToast('已把大框内容当作题目', 'ok');
    });

    /* 搜答案：来源勾选（与设置同源，改一处两处都变） */
    const srcBind = [['srcLocalChk', 'searchLocal'], ['srcWebChk', 'searchWeb'], ['srcAiChk', 'searchAi']];
    srcBind.forEach(([id, key]) => {
      $(id).addEventListener('change', (e) => {
        const patch = {};
        patch[key] = e.target.checked;
        api.setSettings(patch).then(applyState);
      });
    });

    $('searchBtn').addEventListener('click', async () => {
      qb.dataset.dirty = '0';
      const r = await api.search.run({ question: qb.value });
      if (r && !r.ok && r.err && r.err !== 'stale') { /* 主进程已经弹过提示，这里不重复 */ }
    });
    $('saveBankBtn').addEventListener('click', async () => {
      const r = await api.bank.add({ question: qb.value, answer: box.value });
      if (r && !r.ok) showToast('存入题库失败：' + r.err, 'error');
    });
    $('bankManageBtn').addEventListener('click', openBank);

    /* 搜答案：结果列表 */
    $('searchResult').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const i = parseInt(btn.getAttribute('data-i'), 10);
      const c = (H.search.candidates || [])[i];
      if (!c) return;
      const act = btn.getAttribute('data-act');

      if (act === 'open') {
        if (!c.url) { showToast('这条没有可打开的网址', 'warn'); return; }
        const r = await api.search.openUrl(c.url);
        if (r && !r.ok) showToast('打开失败：' + r.err, 'error');
        return;
      }
      if (act === 'copy') {
        const t = c.kind === 'answer' ? (c.answer || '') : (c.snippet || '');
        if (!t) { showToast('这条没有可复制的文本', 'warn'); return; }
        await api.search.copy(t);
        showToast('已复制到剪贴板', 'ok');
        return;
      }
      if (act === 'savebank') {
        const question = (H.search.question || qb.value || '').trim();
        if (!question) { showToast('没有题目，没法存', 'warn'); return; }
        const r = await api.bank.add({ question: question, answer: c.answer || '', source: c.source });
        if (r && r.ok) showToast(r.updated ? '题库里已有这道题，答案已更新' : '已存进题库', 'ok');
        else showToast('存入失败：' + (r && r.err), 'error');
        return;
      }
      if (act === 'fill' || act === 'fillboth') {
        let text = c.kind === 'answer' ? (c.answer || '') : (c.snippet || '');
        if (act === 'fillboth' && c.detail) text = '【答案】' + (c.answer || '') + '\n【解析】' + c.detail;
        if (!text.trim()) { showToast('这条没有可填入的内容', 'warn'); return; }
        const r = await api.search.useCandidate(i, text);
        if (r && r.ok) {
          setBoxValue(text);
          showToast('已填入左边大框', 'ok');
          if (bankOpen()) refreshBank();
        } else {
          showToast('填入失败：' + (r && r.err), 'error');
        }
      }
    });

    /* 题库弹窗 */
    $('bankCloseBtn').addEventListener('click', closeBank);
    $('bankModal').addEventListener('click', (e) => {
      if (e.target === $('bankModal')) closeBank();
    });
    $('bankSearchInp').addEventListener('input', debounce(refreshBank, 300));
    $('bankList').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const item = btn.closest('.bank-item');
      if (!item) return;
      await api.bank.remove(item.getAttribute('data-id'));
      await refreshBank();
      showToast('已删除该条目', 'ok');
    });
    $('bankImportBtn').addEventListener('click', async () => {
      const ta = $('bankBulk');
      if (!ta.value.trim()) { showToast('先把内容贴进导入框', 'warn'); return; }
      const r = await api.bank.importText(ta.value);
      if (r && r.ok) {
        ta.value = '';
        await refreshBank();
      } else {
        showToast('导入失败：' + (r && r.err), 'error');
      }
    });
    $('bankImportFileBtn').addEventListener('click', async () => {
      const r = await api.bank.importFile();
      if (r && r.ok) await refreshBank();
    });
    $('bankExportBtn').addEventListener('click', async () => {
      const r = await api.bank.exportFile();
      if (r && r.ok) showToast('已导出 ' + r.count + ' 条到 ' + r.path, 'ok');
    });
    $('bankClearBtn').addEventListener('click', async () => {
      if (!window.confirm('确定要清空整个题库吗？此操作不可撤销（建议先导出备份）。')) return;
      await api.bank.clear();
      await refreshBank();
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
        setBoxValue(it.text || '');
        api.setDraft(it.text || '');
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
          setBoxValue(it.text || '');
          api.setDraft(it.text || '');
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
        setBoxValue(h.text);
        showToast('已回填到大框', 'ok');
      }
    });

    /* 设置 */
    const setS = (patch) => api.setSettings(patch).then(applyState);
    $('hotkeyMainSel').addEventListener('change', (e) => setS({ hotkeyMain: e.target.value }));
    $('hotkeyNextSel').addEventListener('change', (e) => setS({ hotkeyNext: e.target.value }));
    $('hotkeySearchSel').addEventListener('change', (e) => setS({ hotkeySearch: e.target.value }));
    $('countdownSel').addEventListener('change', (e) => setS({ countdownSec: parseInt(e.target.value, 10) }));
    $('delaySel').addEventListener('change', (e) => setS({ charDelayMs: parseInt(e.target.value, 10) }));
    $('delaySel2').addEventListener('change', (e) => setS({ charDelayMs: parseInt(e.target.value, 10) }));
    $('cleanupSel').addEventListener('change', (e) => setS({ cleanup: e.target.value }));
    $('searchEngineSel').addEventListener('change', (e) => setS({ searchEngine: e.target.value }));
    $('searchScoreSel').addEventListener('change', (e) => setS({ searchMinScore: parseFloat(e.target.value) }));
    $('searchTopSel').addEventListener('change', (e) => setS({ searchTopN: parseInt(e.target.value, 10) }));
    $('searchTimeoutSel').addEventListener('change', (e) => setS({ searchTimeoutMs: parseInt(e.target.value, 10) }));
    $('clearFirstChk').addEventListener('change', (e) => setS({ clearFirst: e.target.checked }));
    $('refocusChk').addEventListener('change', (e) => setS({ refocus: e.target.checked }));
    $('beepChk').addEventListener('change', (e) => setS({ beep: e.target.checked }));
    $('trayChk').addEventListener('change', (e) => setS({ minimizeToTray: e.target.checked }));
    $('autoLaunchChk').addEventListener('change', (e) => setS({ autoLaunch: e.target.checked }));
    $('searchAutoFillChk').addEventListener('change', (e) => setS({ searchAutoFill: e.target.checked }));

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

    /* AI 配置：用 change（失焦/回车才触发），避免边打字边被状态推送覆盖 */
    $('aiBaseUrlInp').addEventListener('change', (e) => setS({ aiBaseUrl: e.target.value.trim() }));
    $('aiModelInp').addEventListener('change', (e) => setS({ aiModel: e.target.value.trim() }));
    $('aiSaveKeyBtn').addEventListener('click', async () => {
      const v = $('aiKeyInp').value.trim();
      if (!v) { showToast('请先在输入框里粘贴 API Key', 'warn'); return; }
      await api.setSettings({ aiApiKey: v, searchAi: true });
      $('aiKeyInp').value = '';
      showToast('密钥已保存，并已勾选「AI 解答」', 'ok');
      applyState(await api.getState());
    });
    $('aiClearKeyBtn').addEventListener('click', async () => {
      if (!window.confirm('确定要清除已保存的 API Key 吗？')) return;
      await api.setSettings({ aiApiKey: '' });
      $('aiKeyInp').value = '';
      showToast('已清除密钥', 'warn');
      applyState(await api.getState());
    });
    $('aiTestBtn').addEventListener('click', async () => {
      const st = H.state || {};
      const s = st.settings || {};
      const key = $('aiKeyInp').value.trim();
      if (!key && !s.aiKeySet) { showToast('先填一个 API Key 再测', 'warn'); return; }
      showToast('正在测试 AI 连接…');
      const r = await api.aiTest(key ? { apiKey: key } : {});
      if (!r || !r.ok) showToast('测试失败：' + ((r && r.err) || '未知原因'), 'error');
    });

    /* 键盘：Esc 关闭弹窗/取消倒计时；Ctrl+Enter 立即输入 */
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (bankOpen()) { closeBank(); return; }
        if (H.auto.active) { api.autoCancel(); return; }
      }
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
    box.dataset.dirty = '0';
    $('charCount').textContent = box.value.length + ' 字';
  });
  api.onSearch((d) => {
    if (!d) return;
    H.search = Object.assign({}, H.search, d);
    if (d.active) switchTab('search');      /* 热键搜题时自动把结果页翻出来 */
    renderSearchResults(true);
    renderSearchMeta();
  });

  /* 供自动化脚本与视觉走查使用 */
  window.App = {
    go: switchTab,
    state: () => H.state,
    toast: showToast,
    openBank: openBank,
    closeBank: closeBank,
    bankItems: () => bankItems,
    refreshBank: refreshBank,
    /** 塞一组演示结果，仅用于截图与命中测试（不联网） */
    previewSearch: function () {
      H.search = {
        active: false, at: Date.now(), ms: 1420, count: 4, engine: '搜狗',
        query: '已知a+b=3,ab=2,则a²+b²的值为',
        question: '已知a+b=3，ab=2，则a²+b²的值为（ ）',
        errors: [],
        bankCount: 12,
        engines: {},
        candidates: [
          { id: 'b1', source: 'local', kind: 'answer', score: 1, answer: 'a²+b²=(a+b)²-2ab=9-4=5', detail: '完全平方公式变形', question: '已知a+b=3，ab=2，则a²+b²的值为（ ）', hits: 3 },
          { id: 'ai0', source: 'ai', kind: 'answer', score: 0.88, answer: '5', detail: '由 (a+b)²=a²+2ab+b² 得 a²+b²=(a+b)²-2ab=3²-2×2=9-4=5。', model: 'deepseek-chat' },
          { id: 'w0', source: 'web', kind: 'answer', score: 0.86, answer: 'C', verify: true, engine: '搜狗', title: '已知a+b=3,ab=2,则a²+b²的值为（） - 学赛搜题易', snippet: 'A.11 B.9 C.5 D.13 答案 C 查看答案 网友 您好，请在下方输入框内输入要搜索的题目', url: 'https://www.xuesai.cn/souti/D6WVBWFW.html' },
          { id: 'w1', source: 'web', kind: 'clue', score: 0.78, engine: '搜狗', title: '中考真题：已知a+b=3,ab=2,求a²+b²值是多少？_腾讯视频', snippet: '视频讲解：先求 (a+b)² = a²+2ab+b²，再代入求值。', url: 'https://v.qq.com/x/page/o3321nwr92m.html' }
        ]
      };
      $('questionBox').value = H.search.question;
      renderSearchResults(true);
      renderSearchMeta();
    }
  };
  window.__SP_SET_THEME__ = (mode) => setTheme(mode, false);

  /* ---------------- 启动 ---------------- */
  let bootPref = 'system';
  try { bootPref = localStorage.getItem(THEME_KEY) || 'system'; } catch (_) { /* 忽略 */ }
  setTheme(bootPref, false);
  switchTab('queue');
  bind();
  api.getState().then(applyState).catch((e) => showToast('初始化失败：' + e.message, 'error'));
})();
