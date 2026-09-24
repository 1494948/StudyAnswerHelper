/* 渲染进程交互级自检脚本（由主进程 executeJavaScript 注入执行）
   覆盖：视图渲染、真实点击命中（elementFromPoint）、真实点击翻转、
         表单落盘（内存 → 磁盘）、默认隐藏态、主题、布局、滚动可达性、
         搜答案（本地题库离线闭环）、图片识别结果展示与修正、自动输入倒计时浮层、
         题库弹窗、两把 API 密钥不外泄

   两条硬约束（不要破坏）：
   1) **必须离线可复现**：所有联网路径显式关掉（sources.web = false），
      真实网络检索由独立的 SP_SEARCHTEST 模式验证。
   2) **不许触发真实截图与真实自动输入**：
      - 绝不 click `#captureBtn`（会弹出全屏遮罩，遮住一切、断言全废）
      - 自动输入只用 `App.previewAutoInput()` 在渲染层造演示状态，不调主进程
   这两条都是为了"自检结果只反映代码质量，不反映当时机器上发生了什么"。 */
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

  /* 轮询等待某个异步条件成立（本机后台节流会让"等固定毫秒"的断言假失败） */
  async function until(fn, ms, label) {
    const deadline = Date.now() + (ms || 4000);
    let last = null;
    while (Date.now() < deadline) {
      last = await fn();
      if (last) return last;
      await wait(200);
    }
    throw new Error('等待超时：' + (label || '条件未满足') + '（最后一次=' + JSON.stringify(last) + '）');
  }

  const lum = (c) => {
    const m = String(c).match(/\d+/g) || [0, 0, 0];
    return (Number(m[0]) + Number(m[1]) + Number(m[2])) / 3;
  };

  /* 1. 四个标签页都能渲染出真实内容（不是空白面板） */
  for (const tab of ['queue', 'search', 'history', 'settings']) {
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

  /* 2. 命中测试 */
  await step('命中测试：主编辑区', async () => {
    window.App.go('queue');
    await wait(240);
    return await hitTest(['#answerBox', '#insertBtn', '#nextBtn', '#cleanupSel', '#pasteBtn', '#clearBtn', '#autoSwitch', '#autoChk']);
  });
  await step('命中测试：标签页与队列面板', async () => {
    window.App.go('queue');
    await wait(240);
    return await hitTest(['#queueAddBtn', '.tab[data-tab="search"]', '.tab[data-tab="history"]', '.tab[data-tab="settings"]', '#themeSel']);
  });
  await step('命中测试：搜答案面板（含截图入口）', async () => {
    window.App.go('search');
    await wait(260);
    /* 只做命中判定，绝不点击 captureBtn（会弹出全屏遮罩） */
    return await hitTest(['#captureBtn', '#ocrRerunBtn', '#ocrEditBtn', '#questionBox', '#searchBtn',
      '#saveBankBtn', '#bankManageBtn', '#kbdCapture', '#ocrBar']);
  });
  await step('命中测试：设置面板', async () => {
    window.App.go('settings');
    await wait(260);
    return await hitTest(['#hotkeyMainSel', '#countdownSel', '#searchEngineSel', '#searchScoreSel',
      '#hotkeySearchSel', '#searchAutoFillChk', '#aiBaseUrlInp', '#aiModelInp', '#aiKeyInp',
      '#aiSaveKeyBtn', '#aiTestBtn', '#addMatchBtn2', '#restartEngineBtn', '#openDataBtn',
      '#autoLaunchChk', '#trayChk']);
  });
  await step('命中测试：设置面板的图片识别分区', async () => {
    window.App.go('settings');
    await wait(280);
    return await hitTest(['#ocrEngineSel', '#ocrModelInp', '#ocrFallbackInp', '#ocrBaseUrlInp',
      '#ocrKeyInp', '#ocrSaveKeyBtn', '#ocrClearKeyBtn', '#ocrTestBtn', '#ocrLangsBtn',
      '#ocrUpscaleSel', '#ocrTimeoutSel', '#ocrAutoSearchChk', '#autoInputChk',
      '#autoInputDelaySel', '#hotkeyCaptureSel']);
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
    await clickCenter('#autoLaunchChk');
    await wait(420);
    assert(q('#autoLaunchChk').checked === before, '开关没能还原到初始状态');
    return '命中层 ' + where + '，' + before + ' → ' + after + ' → 还原';
  });

  /* 3b. 自动输入开关也必须是普通开关，点击后要真写进设置 */
  await step('自动输入开关真实点击可生效', async () => {
    window.App.go('settings');
    await wait(240);
    const before = q('#autoInputChk').checked;
    await clickCenter('#autoInputChk');
    const st = await until(async () => {
      const s = await window.sp.getState();
      return s.settings.autoInputAfterSearch !== before ? s : null;
    }, 3000, '自动输入开关写入设置');
    assert(st.settings.autoInputAfterSearch !== before, '开关没有写进设置');
    await clickCenter('#autoInputChk');
    await until(async () => {
      const s = await window.sp.getState();
      return s.settings.autoInputAfterSearch === before ? s : null;
    }, 3000, '自动输入开关还原');
    return before + ' → ' + st.settings.autoInputAfterSearch + ' → 还原';
  });

  /* 3c. 来源勾选（现在在设置页） */
  await step('来源勾选真实点击可生效', async () => {
    window.App.go('settings');
    await wait(240);
    const before = q('#srcWebChk').checked;
    await clickCenter('#srcWebChk');
    const st = await until(async () => {
      const s = await window.sp.getState();
      return s.settings.searchWeb !== before ? s : null;
    }, 3000, '来源勾选写入设置');
    await clickCenter('#srcWebChk');
    await until(async () => {
      const s = await window.sp.getState();
      return s.settings.searchWeb === before ? s : null;
    }, 3000, '来源勾选还原');
    return before + ' → ' + st.settings.searchWeb + ' → 还原';
  });

  /* 4. 设置页内容变多了，小窗口下必须能滚动到底 */
  await step('设置面板内容超出时可滚动', async () => {
    window.App.go('settings');
    await wait(240);
    const pane = q('.pane[data-pane="settings"]');
    const ov = getComputedStyle(pane).overflowY;
    assert(ov === 'auto' || ov === 'scroll', '设置面板没有滚动能力（overflow-y=' + ov + '）');
    const last = reachable('#autoLaunchRow .switch');
    assert(last.ok, '滚动后仍够不到"开机自动启动"：' + (last.why || last.top));
    return 'overflow-y=' + ov + '，末尾开关可达';
  });

  /* 5. 默认隐藏态：浮层不能常驻 */
  await step('默认隐藏态', async () => {
    const cd = q('#countdown');
    assert(getComputedStyle(cd).display === 'none', '倒计时层默认没有隐藏（会挡住下方按钮）');
    const ai = q('#autoInputOverlay');
    assert(ai, '找不到自动输入浮层');
    assert(getComputedStyle(ai).display === 'none', '自动输入浮层默认没有隐藏（会挡住答案框）');
    const toasts = q('.toasts');
    assert(getComputedStyle(toasts).pointerEvents === 'none', '提示层会拦截点击');
    const modal = q('#bankModal');
    assert(getComputedStyle(modal).display === 'none', '题库弹窗默认没有隐藏（[hidden] 被 display:flex 覆盖了）');
    const addBtn = q('#addMatchBtn');
    const st = window.App.state() || {};
    const f = st.fg || {};
    const hasFg = !!(f.title || f.proc);
    if (f.matched) assert(addBtn.hidden === true, '已识别为学习通时不该再显示"加入识别名单"');
    else if (hasFg) assert(addBtn.hidden === false, '读到了未命中的前台窗口，就该显示"加入识别名单"');
    else assert(addBtn.hidden !== false, '没读到前台窗口时应隐藏"加入识别名单"');
    return '倒计时/自动输入浮层/题库弹窗都隐藏 / 提示层不拦点击';
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

  /* 7. 真的写到磁盘上了吗（轮询等待，不盯瞬间） */
  await step('草稿已写入磁盘文件', async () => {
    const p = await until(async () => {
      const x = await window.sp.probe();
      return (x.hasFile && x.draft === '测试内容 √3 + 1/2') ? x : null;
    }, 5000, '草稿落盘');
    out.info.probe = p;
    return 'file=' + p.file;
  });

  /* 7b. 回归：窗口没获得系统焦点时，主进程推状态不能把还没落盘的编辑清掉 */
  await step('状态推送不会清空未落盘的编辑', async () => {
    window.App.go('queue');
    await wait(200);
    const box = q('#answerBox');
    const text = '这行字不能被状态推送清掉 ' + Date.now();
    box.value = text;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    for (let i = 0; i < 3; i++) {
      await window.sp.setSettings({ countdownSec: 3 });
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

  /* 9. 设置项生效（输入 / 搜答案 / 图片识别 / 自动流程） */
  await step('设置项：输入 / 搜答案 / 图片识别 / 自动流程', async () => {
    window.App.go('settings');
    await wait(220);
    const setVal = async (sel, value) => {
      const el = q(sel);
      el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await wait(360);
    };
    await setVal('#cleanupSel', 'medium');
    await setVal('#delaySel2', '30');
    await setVal('#searchEngineSel', 'so360');
    await setVal('#searchScoreSel', '0.65');
    await setVal('#searchTopSel', '10');
    await setVal('#hotkeySearchSel', 'c-alt-q');
    await setVal('#ocrEngineSel', 'ai');
    await setVal('#ocrModelInp', 'glm-4v-flash');
    await setVal('#ocrFallbackInp', 'deepseek-v4-flash');
    await setVal('#ocrUpscaleSel', '3');
    await setVal('#autoInputDelaySel', '8');
    await setVal('#hotkeyCaptureSel', 'f7');

    const st = await window.sp.getState();
    const s = st.settings;
    assert(s.cleanup === 'medium', '清理级别未生效：' + s.cleanup);
    assert(s.charDelayMs === 30, '逐字间隔未生效：' + s.charDelayMs);
    assert(s.searchEngine === 'so360', '搜索引擎未生效：' + s.searchEngine);
    assert(s.searchMinScore === 0.65, '命中阈值未生效：' + s.searchMinScore);
    assert(s.searchTopN === 10, '候选条数未生效：' + s.searchTopN);
    assert(s.hotkeySearch === 'c-alt-q', '搜题热键未生效：' + s.hotkeySearch);
    assert(s.ocrEngine === 'ai', '识别引擎未生效：' + s.ocrEngine);
    assert(s.ocrModel === 'glm-4v-flash', '主视觉模型未生效：' + s.ocrModel);
    assert(s.ocrFallbackModel === 'deepseek-v4-flash', '备选视觉模型未生效：' + s.ocrFallbackModel);
    assert(s.ocrUpscale === 3, '放大倍数未生效：' + s.ocrUpscale);
    assert(s.autoInputDelaySec === 8, '倒计时秒数未生效：' + s.autoInputDelaySec);
    assert(s.hotkeyCapture === 'f7', '截图热键未生效：' + s.hotkeyCapture);
    assert(st.hotkeys.capture && st.hotkeys.capture.indexOf('F7') === 0, '截图热键标签异常：' + st.hotkeys.capture);
    assert(st.labels.ocrEngine && Object.keys(st.labels.ocrEngine).length === 3, '识别引擎选项标签缺失');
    assert(st.labels.autoInputDelay && Object.keys(st.labels.autoInputDelay).length === 4, '倒计时选项标签缺失');

    /* 还原成默认值，避免影响后面的断言 */
    await window.sp.setSettings({
      searchEngine: 'auto', searchMinScore: 0.55, searchTopN: 6, hotkeySearch: 'c-alt-f',
      ocrEngine: 'auto', ocrUpscale: 2, autoInputDelaySec: 5, hotkeyCapture: 'c-alt-x'
    });
    await wait(160);
    return 'cleanup=' + s.cleanup + ' ocr=' + s.ocrEngine + '/' + s.ocrModel + ' 倒计时=' + s.autoInputDelaySec + 's';
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

  /* ============ 搜答案（全离线） ============ */

  const Q1 = '已知a+b=3，ab=2，则a²+b²的值为（ ）';

  await step('题库：新增 / 去重合并 / 模糊匹配阈值', async () => {
    const a = await window.sp.bank.add({ question: Q1, answer: '(a+b)²-2ab=9-4=5' });
    assert(a && a.ok, '新增失败：' + JSON.stringify(a));
    assert(a.updated === false, '首次新增不该是"更新"');
    const b = await window.sp.bank.add({ question: '已知a+b=3,ab=2,则a²+b²的值为()', answer: '5' });
    assert(b && b.ok && b.updated === true, '重复题目没有合并：' + JSON.stringify(b));
    assert(b.id === a.id, '合并后 id 变了，说明是新增而不是合并');
    const list = await window.sp.bank.list('', 500);
    assert(list.count === 1, '合并后条数应为 1，实际 ' + list.count);
    return '合并为 1 条，答案=' + list.items[0].answer;
  });

  await step('搜答案：本地题库命中 → 结果渲染 → 一键填入大框', async () => {
    window.App.go('search');
    await wait(240);
    /* 题目现在只由识别产生，测试走同一条规范化通路 */
    await window.sp.question.set(Q1);
    await wait(200);
    const r = await window.sp.search.run({ question: Q1, sources: { local: true, web: false, ai: false } });
    assert(r && r.ok, '检索失败：' + JSON.stringify(r && r.err));
    assert(r.candidates.length >= 1, '本地题库没有命中（候选 0 条）');
    assert(r.candidates[0].source === 'local', '头名不是本地题库：' + r.candidates[0].source);
    assert(r.candidates[0].score === 1, '命中的相似度应为 1，实际 ' + r.candidates[0].score);
    assert(r.candidates[0].answer === '5', '答案不对：' + r.candidates[0].answer);

    const rendered = await until(async () => {
      const n = document.querySelectorAll('#searchResult .ritem').length;
      return n >= 1 ? n : null;
    }, 4000, '结果列表渲染');

    await clickCenter('#searchResult button[data-act="fill"]');
    const got = await until(async () => (q('#answerBox').value === '5' ? '5' : null), 3000, '填入大框');
    assert(got === '5', '填入大框失败，实际=' + JSON.stringify(q('#answerBox').value));
    return r.candidates.length + ' 条候选 / 渲染 ' + rendered + ' 行 / 填入大框=' + got;
  });

  await step('搜答案：题库落盘并生效', async () => {
    const p = await until(async () => {
      const x = await window.sp.probe();
      return x.bankCount === 1 ? x : null;
    }, 5000, '题库落盘');
    assert(p.bankFirst && p.bankFirst.answer === '5', '题库文件里的答案不对：' + JSON.stringify(p.bankFirst));
    return 'bankFile=' + p.bankFile + ' / 1 条';
  });

  await step('搜答案：没勾来源 / 空题目 都有明确提示', async () => {
    const r1 = await window.sp.search.run({ question: '随便一道题', sources: { local: false, web: false, ai: false } });
    assert(r1 && r1.ok === false && r1.err.indexOf('来源') >= 0, '没勾来源时应明确提示：' + JSON.stringify(r1 && r1.err));
    const r2 = await window.sp.search.run({ question: '   ', sources: { local: true, web: false, ai: false } });
    assert(r2 && r2.ok === false, '空题目应返回失败');
    return '两条错误路径均有提示';
  });

  await step('搜答案：AI 未配密钥时优雅降级（不抛错）', async () => {
    const r = await window.sp.search.run({ question: '1+1=?', sources: { local: false, web: false, ai: true } });
    assert(r && r.ok === true, '应返回 ok 而不是抛异常');
    assert(r.candidates.length === 0, '没有密钥不该产出 AI 候选');
    assert(r.errors.length >= 1 && r.errors[0].indexOf('密钥') >= 0, '缺少密钥提示：' + JSON.stringify(r.errors));
    return r.errors[0];
  });

  /* ============ 图片识别（离线，用演示数据） ============ */

  await step('图片识别：识别结果渲染 + 题目框默认只读', async () => {
    window.App.go('search');
    await wait(240);
    window.App.previewOcr('ai');
    await wait(320);

    const qb = q('#questionBox');
    assert(qb.value && qb.value.indexOf('a+b=3') >= 0, '题目框没有拿到识别结果：' + JSON.stringify(String(qb.value).slice(0, 40)));
    assert(qb.readOnly === true, '题目框默认必须是只读（题目只由识别产生）');

    const label = q('#ocrLabel').textContent;
    assert(label.indexOf('AI 视觉') >= 0, '识别状态条没有显示引擎：' + label);
    assert(q('#ocrStats').textContent.indexOf('×') > 0, '没有显示识别图片尺寸：' + q('#ocrStats').textContent);
    assert(q('#ocrDot').className.indexOf('ok') >= 0, '识别成功后状态点不是绿色：' + q('#ocrDot').className);
    assert(q('#ocrWarn').hidden, 'AI 识别成功后不该显示质量警告');
    return '题目 ' + qb.value.length + ' 字 / 状态「' + label + '」/ 尺寸 ' + q('#ocrStats').textContent;
  });

  await step('图片识别：系统 OCR 时显示质量警告', async () => {
    window.App.go('search');
    await wait(200);
    window.App.previewOcr('windows');
    await wait(320);
    const warn = q('#ocrWarn');
    assert(!warn.hidden, '系统 OCR 识别后必须显示质量警告（会丢上标，搜题会失败）');
    assert(warn.textContent.indexOf('上标') >= 0 || warn.textContent.indexOf('公式') >= 0,
      '警告内容没说清风险：' + warn.textContent);
    assert(q('#ocrDot').className.indexOf('warn') >= 0, '有警告时状态点应为黄色：' + q('#ocrDot').className);
    const txt = warn.textContent;
    window.App.previewOcr('ai');   /* 还原成 AI 结果，后面的用例继续用 */
    await wait(200);
    return '警告：' + txt.slice(0, 34) + '…';
  });

  await step('图片识别：修正题目 → 保存 → 落盘', async () => {
    window.App.go('search');
    await wait(200);
    window.App.previewOcr('ai');
    await wait(260);
    const qb = q('#questionBox');
    assert(qb.readOnly === true, '前置条件：默认只读');

    await clickCenter('#ocrEditBtn');
    await wait(240);
    assert(qb.readOnly === false, '点「修正题目」后仍是只读');
    assert(q('#ocrSaveEditBtn').hidden === false, '没出现「保存修改」按钮');

    /* 编辑中被状态推送冲击也不能丢内容 */
    const fixed = '修正后的题目：已知 a+b=3，ab=2，求 a^2+b^2';
    qb.value = fixed;
    for (let i = 0; i < 3; i++) {
      await window.sp.setSettings({ countdownSec: 3 });
      await wait(60);
    }
    await wait(500);
    assert(qb.value === fixed, '编辑中的题目被状态推送覆盖了：' + qb.value);

    await clickCenter('#ocrSaveEditBtn');
    const saved = await until(async () => {
      const p = await window.sp.probe();
      return p.question === fixed ? p : null;
    }, 5000, '修正后的题目落盘');
    assert(saved.question === fixed, '题目没落盘：' + JSON.stringify(saved.question));
    assert(qb.readOnly === true, '保存后应恢复只读');
    assert(q('#ocrEditBtn').hidden === false, '保存后「修正题目」应重新出现');
    return '已保存 ' + fixed.length + ' 字并落盘';
  });

  await step('图片识别：没有可重识别的截图时给出明确提示', async () => {
    const r = await window.sp.ocr.rerun();
    /* 自检环境从没截过图，所以这里必须走"没有截图"的分支，而不是偷偷跑一次识别 */
    assert(r && r.ok === false, '没有截图时不该返回成功：' + JSON.stringify(r));
    assert(String(r.err).indexOf('no-image') >= 0, '错误标识不对：' + JSON.stringify(r.err));
    return '返回 ' + r.err + '（未触发真实识别，符合预期）';
  });

  /* ============ 自动输入倒计时浮层 ============ */

  await step('自动输入浮层：显示 / 预览 / 按钮可点 / 取消', async () => {
    window.App.go('search');
    await wait(200);
    window.App.previewAutoInput(5);
    await wait(320);

    const box = q('#autoInputOverlay');
    assert(!box.hidden, '自动输入浮层没有显示');
    assert(q('#autoInputNum').textContent === '5', '倒计时数字不对：' + q('#autoInputNum').textContent);
    assert(q('#autoInputPreview').textContent.indexOf('a²') >= 0, '没有把将输入的答案原文摆出来');
    assert(q('#autoInputFrom').textContent.indexOf('本地题库') >= 0, '没有显示答案来源：' + q('#autoInputFrom').textContent);

    const hit = await hitTest(['#autoInputCancelBtn', '#autoInputNowBtn', '#autoInputPreview']);
    await clickCenter('#autoInputCancelBtn');
    await wait(260);
    window.App.cancelAutoInputPreview();
    await wait(200);
    assert(box.hidden, '取消后浮层没有收起');
    return hit + ' / 取消后已收起';
  });

  /* ============ 题库弹窗 ============ */

  await step('题库弹窗：打开 / 渲染 / 批量导入 / 删除 / 关闭', async () => {
    window.App.go('search');
    await wait(200);
    await clickCenter('#bankManageBtn');
    await wait(500);
    const modal = q('#bankModal');
    assert(getComputedStyle(modal).display !== 'none', '题库弹窗没打开');
    assert(q('#bankList').children.length >= 1, '题库列表没有内容');

    await hitTest(['#bankBulk', '#bankImportBtn', '#bankImportFileBtn', '#bankExportBtn',
      '#bankClearBtn', '#bankSearchInp', '#bankCloseBtn', '#bankList']);

    const bulk = q('#bankBulk');
    bulk.value = '三角形内角和是多少度 || 180°\n某商品原价200元打8折 || 160元\n这一行故意没有分隔符';
    bulk.dispatchEvent(new Event('input', { bubbles: true }));
    await clickCenter('#bankImportBtn');
    const after = await until(async () => {
      const r = await window.sp.bank.list('', 500);
      return r.count === 3 ? r : null;
    }, 4000, '批量导入生效');
    assert(after.count === 3, '导入后条数应为 3，实际 ' + after.count);
    assert(bulk.value === '', '导入后输入框应被清空');

    const f = q('#bankSearchInp');
    f.value = '三角形';
    f.dispatchEvent(new Event('input', { bubbles: true }));
    const filtered = await until(async () => {
      const n = q('#bankList').querySelectorAll('.bank-item').length;
      return n === 1 ? n : null;
    }, 3000, '筛选生效');
    assert(filtered === 1, '筛选应剩 1 条');
    f.value = '';
    f.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(500);

    await clickCenter('#bankList button[data-act="del"]');
    const afterDel = await until(async () => {
      const r = await window.sp.bank.list('', 500);
      return r.count === 2 ? r : null;
    }, 4000, '删除生效');

    await clickCenter('#bankCloseBtn');
    await wait(300);
    assert(getComputedStyle(modal).display === 'none', '题库弹窗没有关掉');
    return '导入到 3 条 → 筛选 1 条 → 删除后 ' + afterDel.count + ' 条 → 已关闭';
  });

  /* ============ 安全 ============ */

  await step('安全：两把 API Key 都不会出主进程', async () => {
    await window.sp.setSettings({ aiApiKey: 'sk-selftest-secret-1234', ocrApiKey: 'zk-selftest-vision-5678' });
    await wait(320);
    const st = await window.sp.getState();
    const dump = JSON.stringify(st);
    assert(dump.indexOf('sk-selftest-secret') < 0, '主进程把文本模型的 API Key 推给了渲染层！');
    assert(dump.indexOf('zk-selftest-vision') < 0, '主进程把视觉模型的 API Key 推给了渲染层！');
    assert(st.settings.aiApiKey === undefined, 'settings 里仍然带着 aiApiKey 字段');
    assert(st.settings.ocrApiKey === undefined, 'settings 里仍然带着 ocrApiKey 字段');
    assert(st.settings.aiKeySet === true, 'aiKeySet 标志没置上');
    assert(st.settings.ocrKeySet === true, 'ocrKeySet 标志没置上');
    assert(st.settings.ocrKeyReuseAi === false, '单独设了视觉密钥时不该再标成"复用 AI 密钥"');
    await window.sp.setSettings({ aiApiKey: '', ocrApiKey: '' });
    await wait(320);
    const st2 = await window.sp.getState();
    assert(st2.settings.aiKeySet === false && st2.settings.ocrKeySet === false, '清除密钥后标志没复位');
    assert(st2.settings.ocrKeyEffective === false, '两把密钥都清了，ocrKeyEffective 应为 false');
    return '两把密钥全程未出主进程';
  });

  await step('安全：视觉密钥留空时如实报告"将复用 AI 密钥"', async () => {
    await window.sp.setSettings({ aiApiKey: 'sk-reuse-test-9999', ocrApiKey: '' });
    await wait(320);
    const st = await window.sp.getState();
    assert(st.settings.ocrKeySet === false, '视觉密钥应为未设置');
    assert(st.settings.ocrKeyReuseAi === true, '应提示会复用 AI 密钥');
    assert(st.settings.ocrKeyEffective === true, '复用 AI 密钥时也算"已配置"');
    assert(JSON.stringify(st).indexOf('sk-reuse-test') < 0, '复用场景下密钥同样不能外泄');
    await window.sp.setSettings({ aiApiKey: '' });
    await wait(200);
    return '复用提示正确，且密钥未外泄';
  });

  /* 11. 历史面板 */
  await step('历史面板空状态可见', async () => {
    window.App.go('history');
    await wait(240);
    const host = q('#historyList');
    assert(host.children.length >= 1, '历史列表完全空白');
    assert(host.querySelector('.empty') || host.querySelector('.hitem'), '历史列表既没有记录也没有空状态说明');
    assert(q('#historyCount').textContent.length > 0, '历史条数计数没有文字');
    return '计数="' + q('#historyCount').textContent + '"';
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
    assert(lum(getComputedStyle(document.body).color) > 150, '深色下文字不够亮');
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
    assert(c.scrollWidth <= c.clientWidth + 2, '主区出现横向滚动（' + c.scrollWidth + ' > ' + c.clientWidth + '）');
    const side = q('.side');
    assert(side.getBoundingClientRect().width >= 360, '侧栏宽度异常：' + side.getBoundingClientRect().width);
    for (const tab of ['queue', 'search', 'history', 'settings']) {
      window.App.go(tab);
      await wait(160);
      const pane = q('.pane[data-pane="' + tab + '"]');
      assert(pane.scrollWidth <= pane.clientWidth + 2, tab + ' 面板出现横向滚动：' + pane.scrollWidth + ' > ' + pane.clientWidth);
    }
    return '输入框 ' + Math.round(rb.height) + 'px 高 / 侧栏 ' + Math.round(side.getBoundingClientRect().width) + 'px';
  });

  /* 15. 结果列表的操作按钮都要真的能点到（用演示数据，不联网） */
  await step('搜答案：结果行按钮全部可点击', async () => {
    window.App.go('search');
    await wait(200);
    window.App.previewSearch();
    await wait(400);
    const n = document.querySelectorAll('#searchResult .ritem').length;
    assert(n >= 3, '演示结果没有渲染出来：' + n);
    const btns = Array.prototype.map.call(
      document.querySelectorAll('#searchResult button[data-act]'),
      (b) => '#searchResult button[data-act="' + b.getAttribute('data-act') + '"][data-i="' + b.getAttribute('data-i') + '"]'
    );
    const uniq = btns.filter((x, i) => btns.indexOf(x) === i);
    assert(uniq.length >= 6, '结果行按钮数量异常：' + uniq.length);
    return await hitTest(uniq);
  });

  out.info.errors = window.__SP_ERRORS__;
  out.info.fg = window.App.state() ? window.App.state().fg : null;
  out.info.engine = window.App.state() ? window.App.state().engine : null;
  out.info.ocr = window.App.state() ? window.App.state().ocr : null;
  out.info.autoInput = window.App.state() ? window.App.state().autoInput : null;
  if (out.info.errors.length) out.fail.push('渲染层 JS 错误：' + out.info.errors.join(' | '));
  return JSON.stringify(out);
})()
