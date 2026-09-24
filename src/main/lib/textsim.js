'use strict';
/* ------------------------------------------------------------------
 * 题目文本处理：归一化、相似度、检索式构造、答案候选抽取
 * 全部是纯函数，不依赖 Electron，可单独用 node 跑验证。
 *
 * 设计要点（都是踩过坑之后定的）：
 *  1. 数学题里 `+ - = . / ( ) ² √ π` 都是有效信息，"归一化"绝不能像普通文本
 *     那样把标点全删掉 —— 否则 a+b=3 和 a-b=3 会被压成同一个串。
 *  2. 只靠字符 bigram 相似度会出**危险的误判**：`a+b=3` 与 `a-b=3` 的 bigram
 *     Dice 高达 0.86，数字特征也完全一致，会被判成"同一道题"。所以额外引入
 *     **数学运算符特征**：运算符集合差异大时按比例惩罚，这类"只差一个符号"
 *     的题目就会掉到阈值以下。
 *  3. 过短的题干（归一化后不足 5 字）相似度不可靠，统一再打一次折。
 * ------------------------------------------------------------------ */

const FULLWIDTH_MAP = {
  '，': ',', '。': '.', '、': ',', '；': ';', '：': ':', '？': '?', '！': '!',
  '（': '(', '）': ')', '【': '[', '】': ']', '《': '<', '》': '>',
  '“': '"', '”': '"', '‘': '\'', '’': '\'', '～': '~', '－': '-', '—': '-',
  '–': '-', '　': ' ', '…': '...', '·': '.', '％': '%', '＋': '+', '＝': '=',
  '／': '/', '＊': '*', '＾': '^', '＜': '<', '＞': '>', '｜': '|', '±': '±'
};

/** 全角 → 半角（含全角空格） */
function toHalfWidth(s) {
  let out = '';
  for (const ch of String(s === undefined || s === null ? '' : s)) {
    const c = ch.codePointAt(0);
    if (c === 0x3000) out += ' ';
    else if (c >= 0xFF01 && c <= 0xFF5E) out += String.fromCodePoint(c - 0xFEE0);
    else out += ch;
  }
  return out;
}

/** 统一标点写法（不影响数学符号本身） */
function unify(s) {
  return toHalfWidth(s).replace(
    /[，。、；：？！（）【】《》“”‘’～－—–　…·％＋＝／＊＾＜＞｜]/g,
    (c) => FULLWIDTH_MAP[c] || c
  );
}

/* 只影响表述、不影响题意的词。两边都去掉，所以对"是不是同一道题"是安全的。 */
const STOP_PHRASES = [
  '已知', '求解', '求', '下列', '则', '请问', '试求', '的值是', '的值为', '的值',
  '等于多少', '是多少', '为多少', '等于', '正确答案', '参考答案', '标准答案'
];

/** 归一化：得到"同一道题的指纹"。保留数字、字母、数学符号，去掉空白与表述性噪声。 */
function normalize(s) {
  let t = unify(s).toLowerCase();
  t = t.replace(/^[\s(]*\d+[\s)]*[.、)]\s*/, ' ');            /* 1.  (1) */
  t = t.replace(/^第\s*\d+\s*题[\s:]*/, ' ');                  /* 第3题 */
  t = t.replace(/_{2,}/g, ' ');                                /* 填空下划线 */
  t = t.replace(/\(\s*\)/g, ' ');                              /* 空括号 */
  t = t.replace(/\[\s*\]/g, ' ');
  t = t.replace(/[\s\u00a0]/g, '');
  for (const w of STOP_PHRASES) {
    if (t.indexOf(w) < 0) continue;
    t = t.split(w).join('');
  }
  return t;
}

/** 题目里的数字序列（数学题的关键判别特征） */
function numbers(s) {
  const m = String(s === undefined || s === null ? '' : s).match(/\d+(?:\.\d+)?/g);
  return m || [];
}

/** 数学运算符序列：用来识别"只差一个符号"的近似题（如 a+b 与 a-b） */
function mathOps(s) {
  const m = String(s === undefined || s === null ? '' : s).match(/[+\-*/=<>^√π∑∫±≤≥≠∞×÷]/g);
  return m || [];
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function bigrams(s) {
  const out = [];
  const str = String(s || '');
  if (!str.length) return out;
  if (str.length === 1) { out.push(str); return out; }
  for (let i = 0; i < str.length - 1; i++) out.push(str.slice(i, i + 2));
  return out;
}

function counts(arr) {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
  return m;
}

/** 字符 bigram 的 Dice 系数（中英文与公式混排都稳定） */
function dice(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (!x || !y) return 0;
  if (x === y) return 1;
  const ma = counts(bigrams(x));
  const mb = counts(bigrams(y));
  let inter = 0;
  let total = 0;
  for (const [k, v] of ma) {
    total += v;
    inter += Math.min(v, mb.get(k) || 0);
  }
  for (const [, v] of mb) total += v;
  return total ? (2 * inter) / total : 0;
}

/** 多重集 Jaccard */
function jaccardMulti(a, b) {
  const A = a || [];
  const B = b || [];
  if (!A.length && !B.length) return 1;
  if (!A.length || !B.length) return 0;
  const ma = counts(A);
  const mb = counts(B);
  let inter = 0;
  let uni = 0;
  const keys = new Set();
  for (const k of ma.keys()) keys.add(k);
  for (const k of mb.keys()) keys.add(k);
  for (const k of keys) {
    const x = ma.get(k) || 0;
    const y = mb.get(k) || 0;
    inter += Math.min(x, y);
    uni += Math.max(x, y);
  }
  return uni ? inter / uni : 0;
}

/**
 * 「差一点就不是同一道题」的硬否决规则。
 *
 * 实测：`a+b=3` 与 `a-b=3` 的 bigram Dice 高达 0.867、数字序列完全一致，
 * 光靠加权相似度怎么调都压不到阈值以下（0.68 左右），会把一道题错认成另一道。
 * 数学题里"只差一个运算符或一个数字"恰恰就是**不同的题**，所以这里直接否决：
 * 归一化后长度相同、且差异只有 1~2 个字符、且这些字符落在运算符/数字上 → 不是同一题。
 */
const CRITICAL_CHAR = /[+\-*/=<>^0-9]/;
function criticalMinorDiff(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  let critical = 0;
  for (let i = 0; i < a.length; i++) {
    if (a.charAt(i) === b.charAt(i)) continue;
    diff++;
    if (CRITICAL_CHAR.test(a.charAt(i)) || CRITICAL_CHAR.test(b.charAt(i))) critical++;
  }
  return diff > 0 && diff <= 2 && critical === diff;
}

/**
 * 两道题的相似度 0~1。
 *   base      : bigram Dice，包含关系给下限（题干常被截断或加后缀）
 *   numbers   : 数字序列 Jaccard，数学题的关键特征
 *   mathOps   : 运算符序列 Jaccard，削弱"只差一个符号"的近似题
 *   criticalMinorDiff : 硬否决（见上），结果直接压到 0.3 以下
 * 双方都没有数字时数字项不参与，避免"都没数字"被当成高度相似。
 */
function matchScore(question, candidate) {
  const a = normalize(question);
  const b = normalize(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (criticalMinorDiff(a, b)) return 0.3;

  let base = dice(a, b);
  if (a.length >= 6 && b.length >= 6) {
    if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) {
      const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
      base = Math.max(base, 0.55 + 0.4 * ratio);
    }
  }

  const na = numbers(a);
  const nb = numbers(b);
  const core = (!na.length && !nb.length) ? base : (0.6 * base + 0.4 * jaccardMulti(na, nb));

  /* 运算符惩罚：集合一致时系数为 1（不惩罚），差异越大惩罚越重 */
  const sym = jaccardMulti(mathOps(a), mathOps(b));
  const symFactor = 0.35 + 0.65 * sym;

  /* 过短题干的相似度不可靠 */
  const shortFactor = Math.min(a.length, b.length) < 5 ? 0.5 : 1;

  return clamp01(core * symFactor * shortFactor);
}

/**
 * 构造检索式：把题干压成适合搜索引擎的一行。
 *   - 丢掉选项行 / 行内选项串（选择题的 A. B. C. D. 会严重干扰检索）
 *   - 丢掉空括号、填空下划线
 *   - 压掉多余空白，保留空格让引擎分词
 */
function cleanQuestion(q, maxLen) {
  let t = unify(q);
  let lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  /* 整行是"一组选项"的（以 A. 开头且同一行还有 B./C./D.）直接扔 */
  lines = lines.filter((l) => !(/^[A-Da-d]\s*[.、)]/.test(l) && /[B-Db-d]\s*[.、)]/.test(l)));
  /* 整行是"单个选项"的（很短、以选项标记开头）也扔 */
  lines = lines.filter((l) => !(/^[A-Da-d]\s*[.、)]/.test(l) && l.length <= 40));
  t = lines.join(' ');
  t = t.replace(/_{2,}/g, ' ');
  t = t.replace(/[（(]\s*[）)]/g, ' ');
  /* 行内选项串："...的值为（ ）A.3 B.4 C.5 D.6"
     A. 与下一个 B./C./D. 之间必须是"短且不带句读"的一段，
     否则英文句子里的 "A. ... B. ..." 会被误伤 */
  const m = t.match(/(?:^|[\s)）\]])\s*[Aa]\s*[.、)]/);
  if (m) {
    const rest = t.slice(m.index + m[0].length);
    const bm = rest.match(/^([\s\S]{0,30}?)[B-Db-d]\s*[.、)]/);
    if (bm && !/[.。;；,，]/.test(bm[1])) t = t.slice(0, m.index);
  }
  t = t.replace(/\s+/g, ' ').trim();
  const lim = Math.max(12, parseInt(maxLen, 10) || 100);
  if (t.length > lim) t = t.slice(0, lim).trim();
  return t;
}

/* ---------------- 从检索结果的标题/摘要里抽取"疑似答案" ----------------
 * 命中不了就返回 null（界面只展示线索，不做任何猜测）。
 * 所有抽取结果在界面上都会标注为"疑似，请核对"。
 * 题库站点的页面里到处是"查看答案""请输入题目搜索"之类的噪声，必须挡掉。 */
const ANSWER_NOISE = /查看答案|查看解析|请输入|输入框|网友|相关问题|更多|搜索|点击|登录|注册|上一题|下一题|免费|下载|广告|推荐/;

const ANSWER_PROBES = [
  /* 答案 A / 答案：A、C  /  答案选 B */
  { re: /(?:正确答案|参考答案|标准答案|答案)\s*(?:选|是|为)?\s*[:：]?\s*((?:[A-D])(?:\s*[、,，]?\s*[A-D]){0,3})(?![a-zA-Z0-9\u4e00-\u9fa5])/, kind: 'letter' },
  /* 故选 A / 应选 B / 答案为 A */
  { re: /(?:故选|应选|答案为)\s*([A-D])(?![a-zA-Z0-9\u4e00-\u9fa5])/, kind: 'letter' },
  /* 答案：xxxx（带冒号，最可信） */
  { re: /(?:正确答案|参考答案|标准答案|答案)\s*[:：]\s*([^\n。；;]{1,48})/, kind: 'text' },
  /* 正确答案是 / 答案是  某段短文本 */
  { re: /(?:正确答案|参考答案|标准答案|答案是)\s*(?:是|为)\s*([^\n。；;]{1,48})/, kind: 'text' },
  /* 答案 3 / 答案 13（纯数字，无冒号） */
  { re: /(?:正确答案|参考答案|标准答案|答案)\s*(?:是|为)?\s*(-?\d+(?:\.\d+)?(?:\s*\/\s*\d+)?)(?![0-9])/, kind: 'text' },
  /* 的值是 5 / 结果为 6 */
  { re: /(?:的值是|的值是|结果为|得数是|结果等于|等于)\s*(-?\d+(?:\.\d+)?(?:\s*\/\s*\d+)?)(?![0-9])/, kind: 'text' }
];

/** 非选择题答案的合理性检查：挡掉"答案：向左平移个单位长度 4.(2009年高考…"这类文档碎片 */
function plausibleTextAnswer(a) {
  if (!a || a.length > 30) return false;
  if (/[。；;]/.test(a)) return false;          /* 真正的短答案不会带句号分号 */
  if (/[.．][\s(]*\d/.test(a)) return false;   /* "4.(2009" 这种题号噪声 */
  if (/\d{2,}\s*年/.test(a)) return false;     /* 年份，文档标题特征 */
  if (/\s{2,}/.test(a)) return false;
  if (/[（(][^）)]{0,12}$/.test(a)) return false;  /* 半截括号 */
  return true;
}

function extractAnswer(text) {
  const s = unify(text).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  for (const p of ANSWER_PROBES) {
    const m = s.match(p.re);
    if (!m) continue;
    let a = String(m[1] || '').trim();
    if (p.kind === 'letter') {
      a = a.replace(/[^A-D]/g, '');
      if (!a) continue;
    } else {
      if (!plausibleTextAnswer(a)) continue;
    }
    if (a.length > 60) continue;
    if (ANSWER_NOISE.test(a)) continue;
    return { answer: a, kind: p.kind };
  }
  return null;
}

/** 截断展示用文本 */
function compact(s, maxLen) {
  const t = String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim();
  const lim = maxLen || 200;
  return t.length > lim ? t.slice(0, lim) + '…' : t;
}

module.exports = {
  toHalfWidth, unify, normalize, numbers, mathOps,
  dice, jaccardMulti, matchScore, clamp01,
  cleanQuestion, extractAnswer, compact, STOP_PHRASES
};
