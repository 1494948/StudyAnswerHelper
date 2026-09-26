'use strict';
/* ------------------------------------------------------------------
 * 答案检索：把三个答案来源合成一个统一入口
 *   1. local —— 本地题库（离线、瞬时、命中即准）
 *   2. web   —— 网络检索（搜狗优先，必应兜底；返回线索 + 抽取到的疑似答案）
 *   3. ai    —— AI 解答（OpenAI 兼容 /chat/completions，数学题最靠得住）
 *
 * 三个来源并发跑，任何一个失败都只记进 errors，不影响其余来源出结果。
 * 网络来源带最小请求间隔，避免短时间内反复检索被搜索引擎限流。
 * ------------------------------------------------------------------ */
const { request, postJson } = require('./http');
const { toText, attrOf, divTextsByClass } = require('./html');
const { matchScore, cleanQuestion, extractAnswer, compact } = require('./textsim');

/* ================= 搜索引擎适配 ================= */

function absolutize(href) {
  const h = String(href || '').trim();
  if (!h) return '';
  if (/^https?:\/\//i.test(h)) return h;
  if (h.charAt(0) === '/') return 'https://www.sogou.com' + h;
  return '';
}

/** 搜狗结果页：<div class="vrwrap"> 为一条结果，真实地址在尾部 data-url 上 */
function parseSogou(html) {
  const out = [];
  const parts = String(html).split(/<div[^>]*class="(?:vrwrap|rb)\b/);
  for (let i = 1; i < parts.length; i++) {
    const b = parts[i];
    const tm = b.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
    if (!tm) continue;
    const title = toText(tm[1]);
    if (!title) continue;

    let url = attrOf(b, 'data-url');
    if (!url) {
      const am = tm[1].match(/href="([^"]+)"/) || b.match(/<a[^>]*href="([^"]+)"/);
      url = am ? absolutize(am[1]) : '';
    }

    /* 摘要：优先用带摘要语义的容器，取其中最长的一段；都没有就退化成整块文本 */
    let snippet = '';
    const cands = divTextsByClass(b, ['text-layout', 'fz-mid', 'space-txt', 'str_info', 'text-info', 'summary', 'fz-12']);
    for (const c of cands) {
      const t = c.split(title).join(' ').trim();
      if (t.length > snippet.length) snippet = t;
    }
    if (!snippet) snippet = toText(b).split(title).join(' ').trim();

    const site = (function () {
      const cm = b.match(/<a[^>]*class="[^"]*citeLinkClass[^"]*"[^>]*>([\s\S]*?)<\/a>/);
      return cm ? toText(cm[1]) : '';
    })();

    out.push({ title: title, url: url, snippet: compact(snippet, 320), site: compact(site, 40) });
    if (out.length >= 12) break;
  }
  return out;
}

/** 必应结果页：<li class="b_algo"> 为一条结果 */
function parseBing(html) {
  const out = [];
  const parts = String(html).split(/<li[^>]*class="[^"]*b_algo\b/);
  for (let i = 1; i < parts.length; i++) {
    const b = parts[i];
    const tm = b.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    if (!tm) continue;
    const title = toText(tm[1]);
    if (!title) continue;
    const am = tm[1].match(/href="(https?:\/\/[^"]+)"/) || b.match(/href="(https?:\/\/[^"]+)"/);
    const pm = b.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const snippet = pm ? toText(pm[1]) : toText(b).split(title).join(' ').trim();
    /* 必应结果前面常带广告位，没有 URL 的直接跳过 */
    if (!am) continue;
    out.push({ title: title, url: am[1], snippet: compact(snippet, 320), site: '' });
    if (out.length >= 12) break;
  }
  return out;
}

/** 360 搜索：<li class="res-list"> 为一条结果，真实地址在 data-mdurl 上（不必解跳转） */
function parse360(html) {
  const out = [];
  const parts = String(html).split(/<li[^>]*class="[^"]*res-list[^"]*"/);
  for (let i = 1; i < parts.length; i++) {
    const b = parts[i];
    const tm = b.match(/<h3[^>]*class="[^"]*res-title[^"]*"[^>]*>([\s\S]*?)<\/h3>/)
      || b.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
    if (!tm) continue;
    const title = toText(tm[1]);
    if (!title) continue;

    let url = attrOf(tm[1], 'data-mdurl') || attrOf(b, 'data-mdurl');
    if (!url) {
      const am = tm[1].match(/href="(https?:\/\/[^"]+)"/);
      url = am ? am[1] : '';
    }

    let snippet = '';
    const pm = b.match(/<p[^>]*class="[^"]*res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    if (pm) snippet = toText(pm[1]);
    if (!snippet) {
      const sm = b.match(/<span[^>]*class="[^"]*res-list-summary[^"]*"[^>]*>([\s\S]*?)<\/span>/);
      if (sm) snippet = toText(sm[1]);
    }
    if (!snippet) snippet = toText(b).split(title).join(' ').trim();

    const cm = b.match(/<cite>([\s\S]*?)<\/cite>/);
    const citeText = cm ? toText(cm[1]) : '';
    if (!url && cm) {
      const cl = cm[1].match(/href="(https?:\/\/[^"]+)"/);
      if (cl) url = cl[1];
    }
    /* 360 的结果流里夹着"其他人还搜了"这类相关搜索块，没有真实链接，直接丢掉 */
    if (!url) continue;
    if (/^其他人还搜|^相关搜索|^大家还在搜/.test(title)) continue;

    out.push({
      title: title,
      url: url,
      snippet: compact(snippet, 320),
      site: compact(citeText, 40)
    });
    if (out.length >= 12) break;
  }
  return out;
}

/* 搜索引擎在"短时间内被问太多次"时会返回人机验证页。
   必须把这个页面和"正常但没结果"区分开来 —— 前者要提示用户稍后再试并自动换引擎，
   后者才是"页面结构变了"。 */
function looksBlocked(html) {
  const s = String(html || '');
  if (!s) return false;
  return s.indexOf('antispider') >= 0
    || s.indexOf('antispider.min.js') >= 0
    || s.indexOf('verify.css') >= 0
    || s.indexOf('g-recaptcha') >= 0
    || /请在下方输入验证码|访问过于频繁|请输入验证码/.test(s);
}

const ENGINES = {
  sogou: {
    id: 'sogou',
    label: '搜狗',
    url: (q) => 'https://www.sogou.com/web?query=' + encodeURIComponent(q),
    parse: parseSogou
  },
  so360: {
    id: 'so360',
    label: '360',
    url: (q) => 'https://www.so.com/s?q=' + encodeURIComponent(q),
    parse: parse360
  },
  bing: {
    id: 'bing',
    label: '必应',
    url: (q) => 'https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&ensearch=0',
    parse: parseBing
  }
};
/* 顺序即优先级：搜狗对中文题库最准，360 次之且更抗限流，必应兜底 */
const ENGINE_ORDER = ['sogou', 'so360', 'bing'];

/* 同一个进程里两次网络检索之间至少隔这么久，避免短时间内被搜索引擎限流 */
const MIN_WEB_GAP_MS = 2000;
/* 撞上人机验证页之后，该引擎在这个时间内不再尝试 */
const BLOCK_COOLDOWN_MS = 3 * 60 * 1000;

let lastWebAt = 0;
const blockedUntil = {};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function throttleWeb() {
  const wait = MIN_WEB_GAP_MS - (Date.now() - lastWebAt);
  if (wait > 0) await sleep(wait);
  lastWebAt = Date.now();
}

/** 当前处于冷却期的引擎（供界面显示"暂时不可用"） */
function engineStatus() {
  const now = Date.now();
  const out = {};
  for (const id of ENGINE_ORDER) {
    out[id] = { label: ENGINES[id].label, cooldownMs: Math.max(0, (blockedUntil[id] || 0) - now) };
  }
  return out;
}

/**
 * 依次尝试各搜索引擎，第一个能解析出结果的引擎即采用。
 * 撞上人机验证页的引擎会被临时冷落，自动改用下一个。
 */
async function searchWeb(question, opts) {
  const o = opts || {};
  const query = cleanQuestion(question, o.maxQueryLen || 100);
  const errors = [];
  if (!query) return { items: [], errors: ['题目为空，无法构造检索式'], query: '', engine: '', engineId: '' };

  let order = (o.engine && o.engine !== 'auto' && ENGINES[o.engine]) ? [o.engine] : ENGINE_ORDER.slice();
  if (o.engine && o.engine !== 'auto') {
    /* 用户指定了引擎就只用它，但顺带把兜底引擎排在后面，免得完全没结果 */
    order = order.concat(ENGINE_ORDER.filter((x) => x !== o.engine));
  }
  const now = Date.now();
  const cooled = order.filter((id) => (blockedUntil[id] || 0) > now);
  const fresh = order.filter((id) => (blockedUntil[id] || 0) <= now);
  /* 全部都在冷却期时，仍然试一遍（宁可碰运气，也别直接告诉用户没结果） */
  const queue = fresh.length ? fresh.concat(cooled) : order;

  for (const id of queue) {
    const eng = ENGINES[id];
    if (!eng) continue;
    await throttleWeb();
    const r = await request(eng.url(query), {
      timeoutMs: o.timeoutMs || 20000,
      maxBytes: 3 * 1024 * 1024
    });
    if (!r.ok) { errors.push(eng.label + '：' + r.err); continue; }
    if (r.status >= 400) { errors.push(eng.label + '：HTTP ' + r.status); continue; }

    if (looksBlocked(r.text)) {
      blockedUntil[id] = Date.now() + BLOCK_COOLDOWN_MS;
      errors.push(eng.label + '：触发了人机验证（短时间内检索太频繁），已自动改用其他来源');
      continue;
    }

    let items = [];
    try {
      items = eng.parse(r.text) || [];
    } catch (e) {
      errors.push(eng.label + '：结果页解析失败（' + (e && e.message ? e.message : String(e)) + '）');
      items = [];
    }
    if (!items.length) { errors.push(eng.label + '：没有解析到结果，页面结构可能已变化'); continue; }
    return { items: items, errors: errors, query: query, engine: eng.label, engineId: id };
  }
  return { items: [], errors: errors, query: query, engine: '', engineId: '' };
}

/**
 * 网络结果的相关度。
 * 只拿整段"标题+摘要"去比会严重稀释分数：题干只有十几个字，而摘要有三四百字，
 * bigram Dice 会被摊薄到 0.2 上下，排出来的顺序就没法看了。
 * 所以分别对"标题""摘要开头""整段"各算一次，取最大值 —— 这三者里总有一个
 * 是干净的题目原文（题库站的标题往往就是题干本身）。
 */
function webScore(question, it) {
  const title = String(it.title || '');
  const snip = String(it.snippet || '');
  return Math.max(
    matchScore(question, title),
    matchScore(question, snip.slice(0, 140)),
    matchScore(question, title + ' ' + snip)
  );
}

/**
 * 把检索结果转成候选。
 * 只有"抽到了答案 **且** 该结果确实和题目沾边"才算 answer 候选（给"填入大框"按钮），
 * 否则一律降级成 clue —— 免得把文档碎片包装成一条看着能用的答案。
 */
const WEB_ANSWER_MIN_SCORE = 0.25;

function webToCandidates(question, items, engineLabel, topN) {
  const out = [];
  const seen = new Set();
  for (const it of items) {
    const key = String(it.title || '').slice(0, 40);
    if (!key || seen.has(key)) continue;
    const blob = (it.title || '') + ' ' + (it.snippet || '');
    const score = webScore(question, it);
    const ex = extractAnswer(blob);
    const isAnswer = !!ex && score >= WEB_ANSWER_MIN_SCORE;
    seen.add(key);
    out.push({
      id: 'w' + out.length,
      source: 'web',
      kind: isAnswer ? 'answer' : 'clue',
      score: isAnswer ? Math.min(0.95, score + 0.08) : score,
      answer: isAnswer ? ex.answer : '',
      answerKind: isAnswer ? ex.kind : '',
      detail: '',
      title: compact(it.title, 120),
      url: it.url || '',
      snippet: it.snippet || '',
      site: it.site || '',
      engine: engineLabel,
      verify: !!isAnswer       /* 界面据此标注"疑似，请核对" */
    });
  }
  out.sort((a, b) => b.score - a.score);
  /* 至少留几条线索，即使相关度分数都不高 */
  const keep = Math.max(1, parseInt(topN, 10) || 6);
  return out.slice(0, keep);
}

/* ================= AI 解答（OpenAI 兼容协议） ================= */

/* 提示词由三段拼成：角色（全科）+ 学科补充 + 输出格式。
   角色那句从 v1.3.0 起改成"全科"，不再写死数学 —— 原来的写法会把语文题
   也按数学口味答（只给结果不给出处），英语题甚至会被要求"化简"。 */
const AI_ROLE = '你是一名经验丰富的全科答疑老师，数学、语文、英语、物理、化学、生物、历史、地理、道德与法治、信息技术都能胜任，负责给出题目的标准答案。';

const AI_FORMAT = [
  '严格按下面的格式回答，不要输出任何多余内容：',
  '第一行：【答案】只写最终答案。选择题只写选项字母（如 A）；多选题按字母顺序连写（如 AC）；' +
    '填空题只写结果本身，不要写"答案："等前缀。',
  '第二行起：【解析】用简洁的步骤说明理由。',
  '如果题目信息不全或含多个小问，在【解析】里说明，并把最可能的标准答案放在【答案】那行。',
  '公式用普通字符书写（如 a^2+b^2、√3、π、≤），不要用 Markdown 代码块。'
].join('\n');

/** 按学科拼提示词。subjectHint 为空或低置信度时用通用版。 */
function buildAiPrompt(subjectHint) {
  const hint = String(subjectHint || '').trim();
  return hint ? (AI_ROLE + '\n' + hint + '\n' + AI_FORMAT) : (AI_ROLE + '\n' + AI_FORMAT);
}

/* 兼容旧调用点与自检：不带学科补充的通用版本 */
const AI_SYSTEM_PROMPT = buildAiPrompt('');

function aiEndpoint(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return null;
  return /\/chat\/completions$/i.test(base) ? base : base + '/chat/completions';
}

async function askAi(question, cfg) {
  const c = cfg || {};
  const key = String(c.apiKey || '').trim();
  if (!key) return { error: '未配置 AI 密钥（设置 → 搜答案 → AI 解答）' };
  const url = aiEndpoint(c.baseUrl);
  if (!url) return { error: 'AI 接口地址无效：' + (c.baseUrl || '（空）') };

  const model = String(c.model || 'deepseek-chat');
  const body = {
    model: model,
    messages: [
      { role: 'system', content: buildAiPrompt(c.subjectHint) },
      { role: 'user', content: String(question) }
    ],
    temperature: typeof c.temperature === 'number' ? c.temperature : 0.2,
    max_tokens: parseInt(c.maxTokens, 10) || 1200,
    stream: false
  };

  const r = await postJson(url, body, {
    timeoutMs: parseInt(c.timeoutMs, 10) || 60000,
    headers: { Authorization: 'Bearer ' + key }
  });

  if (!r.ok) {
    let msg = r.err || ('HTTP ' + r.status);
    if (r.data && r.data.error && r.data.error.message) msg = String(r.data.error.message);
    else if (r.status === 401 || r.status === 403) msg = '密钥被拒绝（HTTP ' + r.status + '），请检查 API Key 是否正确';
    else if (r.status === 404) msg = '接口路径不存在（HTTP 404），请检查接口地址（多数服务需要以 /v1 结尾）';
    else if (r.status === 429) msg = '请求过于频繁或额度不足（HTTP 429）';
    return { error: msg, status: r.status };
  }

  const d = r.data || {};
  const choice = d.choices && d.choices[0];
  const content = choice && choice.message ? String(choice.message.content || '') : '';
  if (!content.trim()) return { error: 'AI 返回了空内容' };
  return { content: content.trim(), model: model, usage: d.usage || null };
}

/** 解析 AI 的【答案】/【解析】结构，解析不出来就退化成"第一行当答案" */
function parseAiContent(text) {
  const s = String(text || '').trim();
  let answer = '';
  let detail = '';
  let m = s.match(/【答案】\s*([\s\S]*?)(?=【解析】|$)/);
  if (m) answer = m[1].trim();
  m = s.match(/【解析】\s*([\s\S]*)$/);
  if (m) detail = m[1].trim();
  if (!answer) {
    const lm = s.match(/^[ \t]*(?:最终答案|答案|答)[ \t]*[:：][ \t]*(.+)$/m);
    if (lm) answer = lm[1].trim();
  }
  if (!answer) {
    const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
    answer = lines.length ? lines[0] : s;
  }
  if (!detail) detail = s;
  return { answer: compact(answer, 500), detail: compact(detail, 4000) };
}

async function searchAi(question, cfg) {
  const r = await askAi(question, cfg);
  if (r.error) return { candidates: [], errors: ['AI 解答：' + r.error] };
  const p = parseAiContent(r.content);
  return {
    candidates: [{
      id: 'ai0',
      source: 'ai',
      kind: 'answer',
      score: 0.88,
      answer: p.answer,
      detail: p.detail,
      model: r.model,
      verify: false
    }],
    errors: []
  };
}

/** 设置页的"测试连接"：发一句最短的话，只验证连通性与密钥 */
async function testAi(cfg) {
  const t0 = Date.now();
  const r = await askAi('请只回复两个字：可用', Object.assign({}, cfg, { maxTokens: 24, timeoutMs: 30000 }));
  if (r.error) return { ok: false, err: r.error, ms: Date.now() - t0 };
  return { ok: true, ms: Date.now() - t0, model: r.model, reply: compact(r.content, 80) };
}

/* ================= 统一入口 ================= */

const SOURCE_RANK = { local: 0, ai: 1, web: 2 };

/**
 * ctx = {
 *   question, sources: { local, web, ai },
 *   bank, engine, minScore, topN, timeoutMs, ai: { apiKey, baseUrl, model, ... }
 * }
 * 返回 { ok, question, candidates, errors, meta, ms }
 */
async function runSearch(ctx) {
  const c = ctx || {};
  const t0 = Date.now();
  const question = String(c.question || '').trim();
  if (!question) {
    return { ok: false, err: '题目是空的，先把题目贴进题目框', candidates: [], errors: [], ms: 0 };
  }
  const src = c.sources || {};
  const topN = Math.max(1, parseInt(c.topN, 10) || 6);
  const jobs = [];
  const errors = [];

  if (src.local) {
    if (!c.bank) {
      errors.push('本地题库：不可用');
    } else {
      try {
        const hits = c.bank.match(question, { minScore: c.minScore, limit: topN });
        jobs.push(Promise.resolve({ source: 'local', candidates: hits, errors: [], meta: { count: hits.length } }));
      } catch (e) {
        errors.push('本地题库：' + (e && e.message ? e.message : String(e)));
      }
    }
  }

  if (src.web) {
    jobs.push(
      searchWeb(question, { engine: c.engine, timeoutMs: c.timeoutMs })
        .then((r) => ({
          source: 'web',
          candidates: webToCandidates(question, r.items, r.engine, topN),
          errors: r.errors,
          meta: { engine: r.engine, query: r.query, found: r.items.length }
        }))
        .catch((e) => ({ source: 'web', candidates: [], errors: ['网络检索：' + (e && e.message ? e.message : String(e))] }))
    );
  }

  if (src.ai) {
    jobs.push(
      searchAi(question, c.ai || {})
        .then((r) => ({ source: 'ai', candidates: r.candidates, errors: r.errors }))
        .catch((e) => ({ source: 'ai', candidates: [], errors: ['AI 解答：' + (e && e.message ? e.message : String(e))] }))
    );
  }

  if (!jobs.length) {
    return { ok: false, err: '没有勾选任何答案来源（本地题库 / 网络检索 / AI 解答）', candidates: [], errors: [], ms: 0 };
  }

  const settled = await Promise.all(jobs);
  const candidates = [];
  const meta = {};
  for (const s of settled) {
    if (Array.isArray(s.candidates)) candidates.push.apply(candidates, s.candidates);
    if (Array.isArray(s.errors)) errors.push.apply(errors, s.errors);
    if (s.meta) meta[s.source] = s.meta;
  }

  candidates.sort((a, b) => {
    const d = (b.score || 0) - (a.score || 0);
    if (Math.abs(d) > 0.0001) return d;
    return (SOURCE_RANK[a.source] === undefined ? 9 : SOURCE_RANK[a.source])
      - (SOURCE_RANK[b.source] === undefined ? 9 : SOURCE_RANK[b.source]);
  });

  return {
    ok: true,
    question: question,
    candidates: candidates.slice(0, Math.max(topN, 10)),
    errors: errors,
    meta: meta,
    ms: Date.now() - t0
  };
}

module.exports = {
  runSearch, searchWeb, webToCandidates, webScore, searchAi, askAi, testAi,
  parseSogou, parseBing, parse360, parseAiContent, looksBlocked, engineStatus,
  ENGINES, ENGINE_ORDER, AI_SYSTEM_PROMPT, cleanQuestion,
  MIN_WEB_GAP_MS, BLOCK_COOLDOWN_MS
};
