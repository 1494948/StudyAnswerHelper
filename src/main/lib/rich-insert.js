'use strict';
/* 富输入编排：按计划执行「纯文本 / 公式 / 代码」三类步骤。
 *
 * 分工：
 *   lib/richinput.js  决定"打什么"（分段 + LaTeX→Unicode），纯函数、离线可测。
 *   lib/uia-tool.js   决定"怎么点"（在窗口里按名字找元素并点击）。
 *   本模块            决定"按什么顺序做、失败了怎么办"。
 *
 * 失败策略（这是本模块最重要的部分）：
 *   任何一步走到学习通自带编辑器上失败（找不到按钮 / 弹窗没拿到焦点 / 找不到确认），
 *   **一律回退成 Unicode（公式）或原文（代码）直接输入**，并把失败原因如实记下来。
 *   绝不"看起来做了其实没做"——用户必须能从提示里看出这一段落到了哪条路径上。
 *
 * 为什么要回退而不是直接报错停止：一次答题里可能有 5 个公式，其中 1 个因为工具栏
 * 被滚动出视口而点不到。此时把整份答案都丢掉，比"1 个公式降级成 Unicode、其余照常"
 * 糟糕得多。这是产品判断，不是技术妥协。
 */

const uia = require('./uia-tool');

/* 默认按钮名。学习通不同版本叫法不同，所以每个都留一组候选；
 * 用户在设置里可以覆盖（校准方法：tools/probe-uia.js 把真实按钮名读出来）。 */
const DEFAULT_BUTTONS = {
  formula: ['公式', '插入公式', '公式编辑器', '数学公式', 'MathType', 'f(x)', 'π', '∑'],
  code: ['代码', '插入代码', '代码块', '源代码', '</>'],
  confirm: ['确定', '确认', '插入', '完成', 'OK', '确定插入'],
  cancel: ['取消', '关闭', 'Cancel']
};

/* 点完按钮等弹窗出现的时间；再等输入框拿到焦点 */
const DEFAULT_CLICK_GAP_MS = 700;
const DEFAULT_SETTLE_MS = 260;

const CODE_TEXT = {
  'no-button': '没找到这个按钮',
  'no-confirm': '没找到确认按钮',
  'focus-timeout': '弹窗里的输入框没拿到焦点',
  'focus-lost': '输入途中焦点跑掉了',
  'spawn-failed': '无法启动系统脚本宿主',
  'timeout': '查找按钮超时（页面响应太慢）'
};

function shortWhy(r, what) {
  if (!r) return what + '：未知原因';
  if (r.ok) return '';
  if (r.code === 'not-found') return '没找到' + what + '（可能被滚动出视口，或这个版本的编辑器没把它暴露出来）';
  if (r.code === 'no-pattern') return '找到了' + what + '，但页面没给它开放"可点击"接口';
  return (CODE_TEXT[r.code] || r.code || '未知错误') + '（' + what + '）';
}

/* 把一次注入的结果压成步骤记录。code / aborted 必须原样带出去：
   上层要靠 aborted 区分"用户按了 Esc 取消"（不是错误）和"真的失败"。 */
function recOf(r, base) {
  const ok = !!(r && r.ok);
  const note = ok ? ''
    : (r && r.aborted) ? '已按 Esc 取消'
      : ((r && r.err) || (r && r.code) || '输入失败');
  return Object.assign({
    ok: ok, code: (r && r.code) || '', aborted: !!(r && r.aborted), note: note
  }, base || {});
}

/**
 * 在学习通窗口里通过它自带的编辑器插入一个公式。
 * @returns {Promise<{ok:boolean, confirmed?:boolean, code?:string, why?:string, ms:number}>}
 */
async function insertFormula(latex, o) {
  return insertViaEditor('formula', String(latex || ''), o);
}

/** 在学习通窗口里通过它自带的编辑器插入一段代码 */
async function insertCode(code, o) {
  return insertViaEditor('code', String(code || ''), o);
}

async function insertViaEditor(kind, payload, o) {
  const t0 = Date.now();
  const opt = o || {};
  const btn = (opt.buttons || DEFAULT_BUTTONS)[kind] || [];
  const confirmNames = (opt.buttons || DEFAULT_BUTTONS).confirm || [];
  const cancelNames = (opt.buttons || DEFAULT_BUTTONS).cancel || [];
  const hwnd = Number(opt.hwnd) || 0;
  const click = typeof opt.click === 'function' ? opt.click : uia.clickByName;
  const type = opt.type;
  const wait = typeof opt.wait === 'function'
    ? opt.wait
    : function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const log = typeof opt.log === 'function' ? opt.log : function () { };
  const gap = parseInt(opt.clickGapMs, 10) || DEFAULT_CLICK_GAP_MS;
  const label = kind === 'formula' ? '公式按钮' : '代码按钮';

  if (!hwnd) return { ok: false, code: 'no-window', why: '没有目标窗口', ms: 0 };
  if (!btn.length) return { ok: false, code: 'no-button', why: '没有配置' + label + '的名字', ms: 0 };

  /* 1) 点工具栏按钮 */
  const br = await click(hwnd, btn, { timeoutMs: opt.buttonTimeoutMs });
  if (!br.ok) {
    const why = shortWhy(br, label);
    log('富输入：' + why + '（code=' + (br.code || '-') + '）');
    return { ok: false, code: br.code === 'not-found' ? 'no-button' : (br.code || 'no-button'), why: why, ms: Date.now() - t0 };
  }
  log('富输入：已点击' + label + '「' + br.name + '」(' + br.used + ')');

  /* 2) 等弹窗出现、输入框到位 */
  await wait(gap);

  /* 3) 把内容打进弹窗（弹窗通常还在同一个窗口里，所以目标用"当前该输入的那个窗口"） */
  const target = typeof opt.resolveTarget === 'function' ? opt.resolveTarget(hwnd) : hwnd;
  if (typeof type !== 'function') {
    return { ok: false, code: 'no-type', why: '内部错误：没有注入函数', ms: Date.now() - t0 };
  }
  const tr = await type(target, payload, {
    dialog: true,
    settleMs: opt.settleMs === undefined ? DEFAULT_SETTLE_MS : opt.settleMs
  });
  if (!tr || !tr.ok) {
    const why = tr && tr.code === 'focus-timeout'
      ? CODE_TEXT['focus-timeout']
      : (tr && tr.err) || CODE_TEXT[(tr && tr.code) || ''] || '输入失败';
    log('富输入：弹窗内容输入失败 code=' + ((tr && tr.code) || '-') + ' ' + why);
    /* 弹窗可能还开着：尽力把它关掉，免得回退的正文被打进弹窗里 */
    const cr = await click(hwnd, cancelNames, { timeoutMs: 2500 });
    log('富输入：尝试关闭弹窗 → ' + (cr.ok ? '已点击「' + cr.name + '」' : '没找到取消按钮'));
    await wait(280);
    return { ok: false, code: (tr && tr.code) || 'type-failed', why: why, ms: Date.now() - t0 };
  }

  /* 4) 确认插入（有些编辑器是"点按钮直接插进光标处"，这时找不到确认是正常的） */
  const cfr = await click(hwnd, confirmNames, { timeoutMs: opt.confirmTimeoutMs || 4000 });
  await wait(220);
  if (!cfr.ok) {
    log('富输入：没找到确认按钮 —— 该编辑器可能是"点按钮即插入"，也可能是没暴露出来，请人工核对');
    return {
      ok: true, confirmed: false, code: 'no-confirm',
      why: '内容已填入弹窗，但没找到确认按钮，请核对是否真的插入了',
      ms: Date.now() - t0
    };
  }
  log('富输入：已点击确认「' + cfr.name + '」(' + cfr.used + ')');
  return { ok: true, confirmed: true, ms: Date.now() - t0 };
}

/**
 * 按计划执行。返回：
 *   { ok, steps:[{kind, ok, how, note}], text, failures:[], usedEditor, ms }
 * 其中 `text` 是"最终确实逐字打进学习通的纯文本"，可直接用于历史记录与预览。
 *
 * @param {object} plan   lib/richinput.js buildPlan() 的结果
 * @param {object} o      { hwnd, mode, buttons, click, type, resolveTarget, wait, log, allowEditor }
 */
async function runPlan(plan, o) {
  const opt = o || {};
  const steps = (plan && plan.steps) || [];
  const log = typeof opt.log === 'function' ? opt.log : function () { };
  const wait = typeof opt.wait === 'function'
    ? opt.wait
    : function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const type = opt.type;
  const allowEditor = opt.allowEditor !== false && opt.mode === 'editor';
  const t0 = Date.now();

  const report = { ok: true, steps: [], text: '', failures: [], usedEditor: false, ms: 0 };
  let out = '';

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];

    if (s.kind === 'text') {
      const r = await type(opt.hwnd, s.text, {});
      const rec = recOf(r, { kind: 'text', text: s.text, how: 'keyboard' });
      report.steps.push(rec);
      if (r && r.ok) { out += s.text; }
      else { report.ok = false; report.failures.push('第 ' + (i + 1) + ' 段文本输入失败：' + rec.note); }
      continue;
    }

    if (s.kind === 'formula') {
      let done = false;
      if (allowEditor) {
        const fr = await insertFormula(s.latex, Object.assign({}, opt, { log: log }));
        if (fr.ok) {
          report.usedEditor = true;
          report.steps.push({ kind: 'formula', ok: true, how: 'editor', latex: s.latex, note: fr.why || '' });
          if (fr.why) report.failures.push('公式「' + s.latex + '」：' + fr.why);
          /* 走编辑器时，这个公式没有以纯文本形式落地 —— 用一个可见占位让历史/预览能看出这里是个公式 */
          out += '[' + s.unicode + ']';
          done = true;
        } else {
          log('富输入：公式「' + s.latex + '」改用 Unicode 直接输入（' + fr.why + '）');
        }
      }
      if (!done) {
        const r = await type(opt.hwnd, s.unicode, {});
        const rec = recOf(r, { kind: 'formula', how: 'unicode', latex: s.latex, unicode: s.unicode });
        report.steps.push(rec);
        if (r && r.ok) { out += s.unicode; }
        else { report.ok = false; report.failures.push('公式「' + s.latex + '」输入失败：' + rec.note); }
      }
      continue;
    }

    if (s.kind === 'code') {
      let done = false;
      if (allowEditor) {
        const cr = await insertCode(s.code, Object.assign({}, opt, { log: log }));
        if (cr.ok) {
          report.usedEditor = true;
          report.steps.push({ kind: 'code', ok: true, how: 'editor', code: s.code, note: cr.why || '' });
          if (cr.why) report.failures.push('代码段：' + cr.why);
          out += '[' + (s.lang ? s.lang + ' ' : '') + 'code]';
          done = true;
        } else {
          log('富输入：代码段改用纯文本输入（' + cr.why + '）');
        }
      }
      if (!done) {
        const r = await type(opt.hwnd, s.plain, {});
        const rec = recOf(r, { kind: 'code', how: 'plain', code: s.code });
        report.steps.push(rec);
        if (r && r.ok) { out += s.plain; }
        else { report.ok = false; report.failures.push('代码段输入失败：' + rec.note); }
      }
      continue;
    }

    report.steps.push({ kind: s.kind, ok: false, note: '未知步骤类型' });
    report.ok = false;
    report.failures.push('未知步骤类型：' + s.kind);
  }

  report.text = out;
  report.ms = Date.now() - t0;
  return report;
}

/** 给界面/日志用的一句话结论 */
function summarize(report) {
  if (!report) return '';
  const n = report.steps.length;
  const bad = report.steps.filter(function (s) { return !s.ok; }).length;
  const viaEditor = report.steps.filter(function (s) { return s.how === 'editor'; }).length;
  const parts = ['共 ' + n + ' 段'];
  if (viaEditor) parts.push(viaEditor + ' 段走了学习通自带的公式/代码');
  if (bad) parts.push(bad + ' 段失败');
  return parts.join('，');
}

module.exports = {
  insertFormula, insertCode, runPlan, summarize,
  DEFAULT_BUTTONS, DEFAULT_CLICK_GAP_MS
};
