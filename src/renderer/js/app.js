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
    autoInput: { active: false, remain: 0, why: '', from: '', text: '', delaySec: 5 },
    /* 演示预览的保护期（毫秒时间戳）；期间忽略被动的状态推送 */
    autoInputPreviewUntil: 0,
    ocr: { active: false, at: 0, ms: 0, provider: '', engineLabel: '', attempts: [], errors: [], image: {}, warn: '' },
    /* 学科识别与选择题点选（v1.3.0） */
    subject: { subject: '', label: '', confidence: 0, override: '', options: [], isChoice: false, autoReasons: [], list: [] },
    choice: { isChoice: false, options: [], letters: [], clickable: false, why: '', busy: false, lastOk: null, lastText: '', lastLetters: [] },
    question: '',
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
    $('kbdSearch').textContent = st.hotkeys.search;
    $('kbdCapture').textContent = st.hotkeys.capture;
    $('autoChk').checked = !!st.settings.autoMode;
    $('autoHint').textContent = '切到学习通窗口后自动倒计时输入（' + (st.settings.countdownSec || 3) + ' 秒，Esc 可取消）';

    fillSelect($('cleanupSel'), st.labels.cleanup, String(st.settings.cleanup));
    fillSelect($('delaySel'), st.labels.delay, String(st.settings.charDelayMs));
    renderRich(st);
  }

  /* ---------------- 渲染：富文本输入（v1.4.0） ----------------
   * 两件事：① 用主进程算出来的档位/摘要标一下头；② 用「实际会输入什么」的预览
   * 让用户随时能核对——尤其是公式被转成什么样。 */
  const RICH_MODE_LABEL = { off: '富输入已关闭', unicode: '公式转 Unicode', editor: '用学习通自带按钮' };

  function applyRichPreview(r) {
    if (!r) return;
    const tag = $('richModeTag');
    const label = RICH_MODE_LABEL[r.mode] || r.mode;
    if (tag) {
      tag.textContent = label;
      tag.className = 'chip' + (r.mode === 'off' ? ' off' : (r.mode === 'editor' ? ' editor' : ''));
    }
    const parts = [];
    if (r.summary) parts.push(r.summary);
    if (r.mode !== 'off' && r.stepCount) parts.push('共 ' + r.stepCount + ' 段');
    if (r.mode === 'off') parts.push('原文照输，不做任何转换');
    $('richSummary').textContent = parts.join(' · ');

    const pv = $('richPreview');
    if (!pv) return;
    const body = String(r.text || '');
    const empty = !body.trim();
    pv.textContent = empty ? '（没有内容）' : body;
    if (r.warnings && r.warnings.length) {
      pv.textContent += '\n\n⚠ ' + r.warnings.join('\n⚠ ');
    }
    pv.classList.toggle('empty', empty);
  }

  let richTimer = null;
  function refreshRichPreview(text) {
    if (richTimer) clearTimeout(richTimer);
    richTimer = setTimeout(() => {
      const p = api.richPreview(text || '');
      if (p && p.then) p.then(applyRichPreview).catch(() => { /* 忽略 */ });
    }, 220);
  }

  function renderRich(st) {
    const r = st.rich || {};
    /* 先按状态里的档位把标签画上（预览正文由 refreshRichPreview 补，避免每次状态推送都算一遍） */
    applyRichPreview(Object.assign({}, r.preview || {}, { mode: r.mode }));
  }

  /* 用 $…$ / ``` 把选中内容包起来；没有选中就插入一个空模板，光标落在里面 */
  function wrapSelection(box, before, after, placeholder) {
    const s = box.selectionStart;
    const e = box.selectionEnd;
    const val = box.value;
    const sel = val.slice(s, e);
    const inner = sel || placeholder;
    box.value = val.slice(0, s) + before + inner + after + val.slice(e);
    const caret = s + before.length;
    box.selectionStart = caret;
    box.selectionEnd = caret + inner.length;
    box.dataset.dirty = '1';
    $('charCount').textContent = box.value.length + ' 字';
    api.setDraft(box.value);
    refreshRichPreview(box.value);
    box.focus();
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

  /* ---------------- 渲染：图片识别状态 ---------------- */
  function renderOcr(st) {
    const o = (st && st.ocr) || {};
    H.ocr = Object.assign({}, H.ocr, o);

    const bar = $('ocrBar');
    const dot = $('ocrDot');
    const label = $('ocrLabel');

    if (H.ocr.active) {
      bar.classList.add('busy');
      dot.className = 'dot warn';
      label.textContent = H.ocr.engine === 'windows'
        ? '正在用系统 OCR 识别…'
        : '正在识别题目…（调用视觉模型，通常 2~10 秒）';
    } else {
      bar.classList.remove('busy');
      if (H.ocr.at && H.ocr.engineLabel) {
        dot.className = 'dot ' + (H.ocr.warn ? 'warn' : 'ok');
        label.textContent = H.ocr.engineLabel + ' · ' + (H.ocr.ms || 0) + 'ms';
      } else if (H.ocr.errors && H.ocr.errors.length) {
        dot.className = 'dot err';
        label.textContent = '上次识别失败';
      } else {
        dot.className = 'dot';
        label.textContent = '还没有识别过题目';
      }
    }

    const img = H.ocr.image || {};
    $('ocrStats').textContent = img.width ? (img.width + '×' + img.height) : '';

    const warn = $('ocrWarn');
    const msgs = [];
    if (H.ocr.warn) msgs.push(H.ocr.warn);
    if (!H.ocr.active && H.ocr.errors && H.ocr.errors.length) {
      msgs.push('上次识别的问题：' + H.ocr.errors.join('；'));
    }
    warn.textContent = msgs.join('\n');
    warn.hidden = !msgs.length;
  }

  /* ---------------- 渲染：自动输入倒计时 ---------------- */
  function renderAutoInput(st) {
    /* 演示预览（自检与截图用）在被动的状态推送面前保持优先：
       状态推送随时可能到来，若让它覆盖，倒计时浮层会在断言中途闪没。
       真正的 autoinput 事件走的是 renderAutoInput(null)，不受这里限制。 */
    if (st && H.autoInputPreviewUntil > Date.now()) return;
    const a = (st && st.autoInput) || H.autoInput || {};
    H.autoInput = Object.assign({}, H.autoInput, a);
    const box = $('autoInputOverlay');
    if (!H.autoInput.active) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    $('autoInputNum').textContent = String(H.autoInput.remain);
    $('autoInputFrom').textContent = H.autoInput.why ? ('来源：' + H.autoInput.why) : '';
    $('autoInputPreview').textContent = H.autoInput.text || '（空的）';
  }

  /* ---------------- 渲染：学科识别（v1.3.0） ---------------- */
  /* 为什么要显示置信度：词法判断必然有失手的时候（比如语文文言文里夹着算式）。
     把"它有多大把握"摆出来，用户才知道该不该动手改，而不是默默按错学科作答。 */
  function renderSubject(st) {
    const s = (st && st.subject) || H.subject || {};
    H.subject = Object.assign({}, H.subject, s);

    const chip = $('subjectChip');
    const why = $('subjectWhy');
    const has = !!H.subject.subject;
    const conf = typeof H.subject.confidence === 'number' ? H.subject.confidence : 0;

    if (!has) {
      chip.textContent = '学科待定';
      chip.className = 'chip none';
    } else {
      chip.textContent = H.subject.label + (H.subject.override ? '（手动）' : '');
      chip.className = 'chip' + (!H.subject.override && conf < 0.35 ? ' low' : '');
    }

    const parts = [];
    if (!has) {
      parts.push('识别出题目后自动判断');
    } else if (H.subject.override) {
      parts.push('已手动指定，不再自动判断');
    } else {
      parts.push('置信度 ' + Math.round(conf * 100) + '%');
      const rs = (H.subject.autoReasons || []).slice(0, 4);
      if (rs.length) parts.push('依据：' + rs.join('、'));
      if (H.subject.autoNote) parts.push(H.subject.autoNote);
    }
    why.textContent = parts.join(' · ');
    why.title = parts.join('\n');

    /* 两处下拉都要填：搜答案页的快捷切换 + 设置页的正式设置。
       空值 = 回到自动识别。 */
    const list = H.subject.list || [];
    const map = { '': '自动识别' };
    list.forEach((it) => { map[it.id] = it.label; });
    ['subjectSel', 'subjectOverrideSel'].forEach((id) => {
      const sel = $(id);
      if (sel) fillSelect(sel, map, H.subject.override || '');
    });
  }

  /* ---------------- 渲染：选择题点选（v1.3.0） ---------------- */
  function renderChoice(st) {
    const c = (st && st.choice) || H.choice || {};
    H.choice = Object.assign({}, H.choice, c);

    const btn = $('clickChoiceBtn');
    const opts = $('choiceOpts');
    const why = $('choiceWhy');
    if (!btn) return;

    /* 上一次的点选结果只在"题目/答案没变过"时才作数。
       换了题还挂着旧提示，用户会以为刚才点的就是这道题。 */
    const staleResult = H.choice.lastSig && H.choice.sig && H.choice.lastSig !== H.choice.sig;
    const lastOk = staleResult ? null : H.choice.lastOk;
    const lastText = staleResult ? '' : H.choice.lastText;

    const list = H.choice.options || [];
    /* 点选前显示"将要点的那个字母"；点选失败后显示"上次试着点过的字母" */
    const targets = (lastOk === false || lastOk === true) && H.choice.lastLetters && H.choice.lastLetters.length
      ? H.choice.lastLetters : (H.choice.clickable ? (H.choice.letters || []) : []);

    opts.innerHTML = list.map((L) => {
      const cls = targets.indexOf(L) >= 0 ? 'opt hit' : 'opt miss';
      return '<span class="' + cls + '">' + esc(L) + '</span>';
    }).join('');

    const busy = !!H.choice.busy;
    btn.classList.toggle('busy', busy);
    btn.textContent = busy ? '点选中…' : '点选答案';
    btn.disabled = busy || !H.choice.clickable;

    let text = '';
    let cls = '';
    if (busy) {
      text = '正在用 UI Automation 在窗口中查找选项…';
    } else if (lastOk === true) {
      text = lastText || '已点选';
      cls = 'ok';
    } else if (lastOk === false) {
      text = lastText || '点选失败';
      cls = 'bad';
    } else if (!H.choice.isChoice) {
      text = '当前不是选择题（题目里没有 A/B/C/D 选项）';
    } else if (!H.choice.clickable) {
      text = H.choice.why || '还没有可点选的答案';
    } else {
      text = '将点选：' + (H.choice.letters || []).join('、') +
        '（' + (H.choice.autoClick ? '自动流程里会自己点' : '自动点选已关闭，可手动点') + '）';
    }
    why.textContent = text;
    why.className = 'muted choice-why' + (cls ? ' ' + cls : '');
    why.title = text;
  }

  /* ---------------- 题目修正（识别错了才用；题目本身只由识别产生） ---------------- */
  function startEditQuestion() {
    const qb = $('questionBox');
    if (!qb.value.trim()) { showToast('还没有识别出题目，先点「截图选题」', 'warn'); return; }
    qb.readOnly = false;
    qb.dataset.editing = '1';
    $('ocrEditBtn').hidden = true;
    $('ocrSaveEditBtn').hidden = false;
    $('ocrCancelEditBtn').hidden = false;
    qb.focus();
    showToast('可以修改识别结果了，改完点「保存修改」', 'info');
  }

  function exitEditQuestion() {
    const qb = $('questionBox');
    qb.readOnly = true;
    delete qb.dataset.editing;
    $('ocrEditBtn').hidden = false;
    $('ocrSaveEditBtn').hidden = true;
    $('ocrCancelEditBtn').hidden = true;
  }

  async function saveEditQuestion() {
    const qb = $('questionBox');
    const r = await api.question.set(qb.value);
    exitEditQuestion();
    if (r && r.ok) showToast('题目已更新，可以点「重新搜答案」', 'ok');
  }

  function cancelEditQuestion() {
    const qb = $('questionBox');
    qb.value = H.question || '';
    exitEditQuestion();
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
    /* 图片识别 */
    fillSelect($('hotkeyCaptureSel'), arrToMap(st.presets.capture), s.hotkeyCapture);
    fillSelect($('ocrEngineSel'), st.labels.ocrEngine, String(s.ocrEngine));
    fillSelect($('ocrUpscaleSel'), st.labels.upscale, String(s.ocrUpscale));
    fillSelect($('ocrTimeoutSel'), { 60000: '60 秒', 90000: '90 秒', 120000: '120 秒' }, String(s.ocrTimeoutMs));
    fillSelect($('autoInputDelaySel'), st.labels.autoInputDelay, String(s.autoInputDelaySec));
    /* v1.4.0：富文本输入（公式 / 符号 / 代码） */
    fillSelect($('richInputSel'), st.labels.richInput, String(s.richInput || 'unicode'));
    fillSelect($('richCodeFallbackSel'), st.labels.richCodeFallback, String(s.richCodeFallback || 'plain'));
    fillSelect($('richGapSel'), { 400: '0.4 秒', 700: '0.7 秒（默认）', 1000: '1 秒', 1500: '1.5 秒' },
      String(s.richEditorClickGapMs || 700));

    $('clearFirstChk').checked = !!s.clearFirst;
    $('refocusChk').checked = !!s.refocus;
    $('beepChk').checked = !!s.beep;
    $('trayChk').checked = !!s.minimizeToTray;
    $('autoLaunchChk').checked = !!s.autoLaunch;
    $('searchAutoFillChk').checked = !!s.searchAutoFill;
    $('ocrAutoSearchChk').checked = !!s.ocrAutoSearch;
    $('autoInputChk').checked = !!s.autoInputAfterSearch;
    /* v1.3.0：选择题点选 */
    $('autoClickChk').checked = s.autoClickChoice !== false;
    $('clickThenTypeChk').checked = !!s.clickThenType;

    $('srcLocalChk').checked = !!s.searchLocal;
    $('srcWebChk').checked = !!s.searchWeb;
    $('srcAiChk').checked = !!s.searchAi;

    syncTextInput($('matchTitlesInp'), (s.matchTitles || []).join('，'), normList);
    syncTextInput($('matchProcsInp'), (s.matchProcs || []).join('，'), normList);
    /* v1.4.0：公式/代码按钮名（用于"点学习通自带的按钮"） */
    syncTextInput($('richFormulaBtnInp'), s.richFormulaButtons || '');
    syncTextInput($('richCodeBtnInp'), s.richCodeButtons || '');
    syncTextInput($('richConfirmBtnInp'), s.richConfirmButtons || '');
    syncTextInput($('aiBaseUrlInp'), s.aiBaseUrl || '');
    syncTextInput($('aiModelInp'), s.aiModel || '');
    $('aiKeyState').textContent = s.aiKeySet
      ? ('密钥状态：' + (s.aiKeyHint || '已保存'))
      : '密钥状态：未保存。AI 解答需要填一个 OpenAI 兼容接口的密钥。';

    /* 视觉模型配置 */
    syncTextInput($('ocrModelInp'), s.ocrModel || '');
    syncTextInput($('ocrFallbackInp'), s.ocrFallbackModel || '');
    syncTextInput($('ocrBaseUrlInp'), s.ocrBaseUrl || '');
    $('ocrKeyState').textContent = s.ocrKeySet
      ? ('视觉密钥：' + (s.ocrKeyHint || '已保存'))
      : (s.ocrKeyReuseAi
        ? '视觉密钥：未单独设置，将复用「AI 解答」的密钥'
        : '视觉密钥：未设置 —— 现在只能用系统自带 OCR，公式和上标会丢，搜题成功率很低');

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

  /* 文本输入框的"脏保护"。
     不要用 document.activeElement 判断"用户是不是在编辑" —— 窗口没有系统焦点时
     它恒为 false，于是主进程一推状态就把刚敲进去的内容清回旧值，静默丢输入。
     （大框早期踩的就是这个坑，见 PROJECT.md 第 6.1 节第 9 条。）
     脏的时候拒绝远端覆盖；等主进程的值追平输入内容后自动恢复同步。 */
  function syncTextInput(el, value, norm) {
    if (!el) return;
    const n = norm || ((x) => String(x));
    const v = String(value === undefined || value === null ? '' : value);
    if (el.dataset.dirty === '1') {
      if (n(el.value) === n(v)) el.dataset.dirty = '0';
    } else if (el.value !== v) {
      el.value = v;
    }
  }
  /* 关键词这类用逗号分隔的输入，比较时按"项"归一化（全角半角、空格差异不算改动） */
  const normList = (t) => String(t || '').split(/[,，\n]/).map((x) => x.trim()).filter(Boolean).join(',');

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
    /* 题目只由图片识别产生；正在手动修正时不要被状态推送覆盖 */
    H.question = st.question || '';
    const qb = $('questionBox');
    if (qb.dataset.editing !== '1' && qb.value !== H.question) qb.value = H.question;

    renderFg(st);
    renderComposer(st);
    renderQueue(st, false);
    renderHistory(st);
    renderSettings(st);
    renderAuto();
    renderOcr(st);
    renderAutoInput(st);
    renderSubject(st);
    renderChoice(st);
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
      refreshRichPreview(box.value);
    });

    /* 富文本输入（v1.4.0）：把选中内容标成公式 / 代码块，再看实际会输入什么 */
    $('richFormulaBtn').addEventListener('click', () => {
      wrapSelection(box, '$', '$', 'a^2+b^2');
      showToast('已标为公式：$…$ 之间的内容会按 LaTeX 转成数学符号', 'ok');
    });
    $('richCodeBtn').addEventListener('click', () => {
      const s = box.selectionStart;
      const needNl = s > 0 && box.value[s - 1] !== '\n';
      wrapSelection(box, (needNl ? '\n' : '') + '```\n', '\n```\n', 'print("hello")');
      showToast('已标为代码块：转换后按纯文本输入，行结构与缩进都会保留', 'ok');
    });
    $('richToggleBtn').addEventListener('click', () => {
      const pv = $('richPreview');
      pv.hidden = !pv.hidden;
      if (!pv.hidden) refreshRichPreview(box.value);
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

    /* 搜答案：截图选题 + 识别结果处理 */
    const qb = $('questionBox');
    $('captureBtn').addEventListener('click', async () => {
      const r = await api.capture.start();
      if (r && !r.ok && r.err && r.err !== 'busy') showToast('启动截图失败：' + r.err, 'error');
    });
    $('ocrRerunBtn').addEventListener('click', () => { api.ocr.rerun(); });
    /* 学科：搜答案页里的快捷下拉 + 设置页里的那个，都写同一个设置 */
    ['subjectSel', 'subjectOverrideSel'].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('change', async (e) => {
        await api.subject.set(e.target.value || '');
      });
    });
    $('clickChoiceBtn').addEventListener('click', async () => {
      $('clickChoiceBtn').classList.add('busy');
      H.choice = Object.assign({}, H.choice, { busy: true });
      renderChoice(null);
      await api.choice.click({});
    });
    $('ocrEditBtn').addEventListener('click', startEditQuestion);
    $('ocrSaveEditBtn').addEventListener('click', saveEditQuestion);
    $('ocrCancelEditBtn').addEventListener('click', cancelEditQuestion);
    $('autoInputCancelBtn').addEventListener('click', () => api.autoInput.cancel());
    $('autoInputNowBtn').addEventListener('click', () => api.autoInput.now());

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
      if (!qb.value.trim()) { showToast('还没有题目，先点「截图选题」', 'warn'); return; }
      await api.search.run({ question: qb.value });
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
    /* 图片识别与自动流程 */
    $('autoClickChk').addEventListener('change', (e) => setS({ autoClickChoice: e.target.checked }));
    $('clickThenTypeChk').addEventListener('change', (e) => setS({ clickThenType: e.target.checked }));
    $('ocrAutoSearchChk').addEventListener('change', (e) => setS({ ocrAutoSearch: e.target.checked }));
    $('autoInputChk').addEventListener('change', (e) => setS({ autoInputAfterSearch: e.target.checked }));
    $('hotkeyCaptureSel').addEventListener('change', (e) => setS({ hotkeyCapture: e.target.value }));
    $('ocrEngineSel').addEventListener('change', (e) => setS({ ocrEngine: e.target.value }));
    $('ocrUpscaleSel').addEventListener('change', (e) => setS({ ocrUpscale: parseInt(e.target.value, 10) }));
    $('ocrTimeoutSel').addEventListener('change', (e) => setS({ ocrTimeoutMs: parseInt(e.target.value, 10) }));
    $('autoInputDelaySel').addEventListener('change', (e) => setS({ autoInputDelaySec: parseInt(e.target.value, 10) }));
    /* v1.4.0：富文本输入 */
    $('richInputSel').addEventListener('change', (e) => setS({ richInput: e.target.value }));
    $('richCodeFallbackSel').addEventListener('change', (e) => setS({ richCodeFallback: e.target.value }));
    $('richGapSel').addEventListener('change', (e) => setS({ richEditorClickGapMs: parseInt(e.target.value, 10) }));
    const bindText = (id, key) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('input', () => { el.dataset.dirty = '1'; });
      el.addEventListener('change', () => {
        el.dataset.dirty = '0';
        setS({ [key]: String(el.value || '').trim() });
      });
    };
    bindText('richFormulaBtnInp', 'richFormulaButtons');
    bindText('richCodeBtnInp', 'richCodeButtons');
    bindText('richConfirmBtnInp', 'richConfirmButtons');

    /* 文本类配置统一走"先打脏标记、再保存"：
       窗口没获得系统焦点时 document.activeElement 不可靠，
       不打脏的话主进程一推状态就会把正在输入的内容盖回去。
       注意：$ 是 getElementById，不认 '#' 前缀，所以这里两种写法都兼容。 */
    const onTextChange = (sel, key) => {
      const el = String(sel).charAt(0) === '#' ? document.querySelector(sel) : $(sel);
      if (!el) { console.error('onTextChange 找不到元素：' + sel); return; }
      el.addEventListener('change', (e) => {
        e.target.dataset.dirty = '1';
        const patch = {};
        patch[key] = e.target.value.trim();
        setS(patch);
      });
    };
    onTextChange('#ocrModelInp', 'ocrModel');
    onTextChange('#ocrFallbackInp', 'ocrFallbackModel');
    onTextChange('#ocrBaseUrlInp', 'ocrBaseUrl');
    $('ocrSaveKeyBtn').addEventListener('click', async () => {
      const v = $('ocrKeyInp').value.trim();
      if (!v) { showToast('请先在输入框里粘贴视觉模型的 API Key', 'warn'); return; }
      await api.setSettings({ ocrApiKey: v });
      $('ocrKeyInp').value = '';
      showToast('视觉密钥已保存', 'ok');
      applyState(await api.getState());
    });
    $('ocrClearKeyBtn').addEventListener('click', async () => {
      if (!window.confirm('确定要清除已保存的视觉密钥吗？（清除后会退回系统自带 OCR）')) return;
      await api.setSettings({ ocrApiKey: '' });
      $('ocrKeyInp').value = '';
      showToast('已清除视觉密钥', 'warn');
      applyState(await api.getState());
    });
    $('ocrTestBtn').addEventListener('click', async () => {
      showToast('正在用内置示例题图测试视觉模型…');
      const r = await api.ocr.test();
      if (r && r.ok) showToast('视觉模型可用：' + (r.model || '') + ' · ' + r.ms + 'ms', 'ok');
    });
    $('ocrLangsBtn').addEventListener('click', () => { api.ocr.langs(); });

    const saveKeywords = debounce(() => {
      const t = $('matchTitlesInp').value.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
      const p = $('matchProcsInp').value.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
      setS({ matchTitles: t, matchProcs: p });
    }, 600);
    $('matchTitlesInp').addEventListener('input', (e) => { e.target.dataset.dirty = '1'; saveKeywords(); });
    $('matchProcsInp').addEventListener('input', (e) => { e.target.dataset.dirty = '1'; saveKeywords(); });

    $('restartEngineBtn').addEventListener('click', async () => {
      await api.restartEngine();
      showToast('正在重启输入引擎…');
    });
    $('openDataBtn').addEventListener('click', () => api.openDataDir());

    /* AI 解答配置：同样走脏标记 + change（失焦/回车才触发） */
    onTextChange('#aiBaseUrlInp', 'aiBaseUrl');
    onTextChange('#aiModelInp', 'aiModel');
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

    /* 键盘：Esc 关闭弹窗 / 取消倒计时；Ctrl+Enter 立即输入 */
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (bankOpen()) { closeBank(); return; }
        if (H.autoInput.active) { api.autoInput.cancel(); return; }
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
  api.onOcr((d) => {
    if (!d) return;
    H.ocr = Object.assign({}, H.ocr, d);
    if (d.text !== undefined) {
      H.question = String(d.text || '');
      const qb = $('questionBox');
      if (qb.dataset.editing !== '1') qb.value = H.question;
    }
    if (d.active) switchTab('search');      /* 截图识别时把识别页翻出来 */
    renderOcr({});
  });
  api.onQuestion((text) => {
    H.question = String(text || '');
    const qb = $('questionBox');
    if (qb.dataset.editing !== '1') qb.value = H.question;
  });
  api.onAutoInput((d) => {
    H.autoInput = Object.assign({}, H.autoInput, d || {});
    renderAutoInput(null);
  });
  api.onChoice((d) => {
    if (!d) return;
    H.choice = Object.assign({}, H.choice, d);
    renderChoice(null);
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
      /* 题目由 H.question / 识别结果维护，这里不去动题目框，
         否则截图时会把「图片识别」得到的题目覆盖掉 */
      H.question = H.question || H.search.question;
      renderSearchResults(true);
      renderSearchMeta();
    },
    /** 塞一组演示识别结果（仅用于截图与命中测试，不走真实截图/联网） */
    previewOcr: function (provider) {
      const isAi = provider !== 'windows';
      H.ocr = {
        active: false,
        at: Date.now(),
        ms: isAi ? 4260 : 1380,
        provider: isAi ? 'ai' : 'windows',
        usedModel: isAi ? 'glm-4v-flash' : '',
        engineLabel: isAi ? 'AI 视觉 · glm-4v-flash' : '系统自带 OCR（离线，公式会丢）',
        attempts: [{ provider: isAi ? 'ai' : 'windows', ok: true, err: '', ms: isAi ? 4260 : 1380 }],
        errors: [],
        image: { width: 1240, height: 372 },
        warn: isAi ? '' : '系统自带 OCR 会丢上标和公式（a² 可能变 a2），搜题成功率低，建议配一个视觉模型',
        hasAiKey: isAi,
        usingAiKey: false,
        engine: 'auto',
        model: 'glm-4v-flash',
        fallbackModel: 'deepseek-v4-flash'
      };
      H.question = isAi
        ? '已知 a+b=3，ab=2，则 a^2+b^2 的值为（　　）\nA. 3\nB. 4\nC. 5\nD. 6'
        : '例题（选择题）已知 a+b=3, ab=2, 则 a2+b2 的值为（） C. 5 D. 6';
      $('questionBox').value = H.question;
      renderOcr({});
    },
    /** 演示学科识别结果：id 传空字符串表示"还没识别出题目" */
    previewSubject: function (id, conf) {
      const list = H.subject.list || [];
      H.subject = Object.assign({}, H.subject, {
        subject: id || '',
        label: id ? ((list.find((x) => x.id === id) || {}).label || id) : '',
        confidence: typeof conf === 'number' ? conf : 0.82,
        override: '',
        autoReasons: id === 'math' ? ['方程', '符号×2', '式子×2'] : [],
        autoNote: ''
      });
      renderSubject(null);
    },
    /** 演示选择题点选条；ok 传 true/false 可预置一次点选结果 */
    previewChoice: function (letters, ok) {
      const ls = String(letters || 'ABCD').split('');
      /* 演示数据固定把 C 当作正确答案；选项里没有 C 就退而取第一个 */
      const target = ls.indexOf('C') >= 0 ? ['C'] : [ls[0]];
      H.choice = Object.assign({}, H.choice, {
        isChoice: true,
        options: ls,
        letters: target,
        answerLetter: 'C',
        clickable: true,
        why: '',
        busy: false,
        autoClick: true,
        clickThenType: false,
        lastOk: typeof ok === 'boolean' ? ok : null,
        lastText: ok === true ? '已点选 ' + target[0] + '（按选项文字定位 · 模拟鼠标点击，并已回读确认选中）'
          : (ok === false ? '这个窗口里没找到该选项。常见原因：页面还没渲染完、选项不在可见区域' : ''),
        lastLetters: ok === false ? [] : target,
        /* 预览结果必须与当前判定签名一致，否则会被当成"上一道题的旧结果"而隐去 */
        sig: 'preview',
        lastSig: 'preview'
      });
      renderChoice(null);
    },
    /** 塞一个演示中的自动输入倒计时 */
    previewAutoInput: function (sec) {
      H.autoInput = {
        active: true, remain: sec || 5,
        /* 本地题库的答案是自己录的，不该标"疑似"；疑似标签只给网络抽取出来的答案 */
        why: '本地题库', from: 'local',
        text: 'a²+b²=(a+b)²−2ab=3²−2×2=9−4=5', delaySec: sec || 5
      };
      H.autoInputPreviewUntil = Date.now() + 8000;
      renderAutoInput(null);
    },
    cancelAutoInputPreview: function () {
      H.autoInputPreviewUntil = 0;
      H.autoInput = { active: false, remain: 0, why: '', from: '', text: '', delaySec: 5 };
      renderAutoInput(null);
    },
    captureStart: () => api.capture.start()
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
