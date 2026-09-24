'use strict';
/* ------------------------------------------------------------------
 * 极简 HTML 文本处理：实体解码、去标签、属性提取
 * 不追求完备的 HTML 解析（不引第三方 DOM 库），只用于处理
 * 搜索引擎结果页这种结构相对稳定的场景，解析失败时安静降级。
 * ------------------------------------------------------------------ */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', ensp: ' ', emsp: ' ',
  thinsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  middot: '·', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', deg: '°',
  times: '×', divide: '÷', plusmn: '±', ne: '≠', le: '≤', ge: '≥', radic: '√',
  sup2: '²', sup3: '³', frac12: '½', frac14: '¼', frac34: '¾', bull: '•',
  sect: '§', para: '¶', dagger: '†', prime: '′', Prime: '″', infin: '∞',
  alpha: 'α', beta: 'β', gamma: 'γ', theta: 'θ', pi: 'π', lambda: 'λ', mu: 'μ',
  sigma: 'σ', omega: 'ω', Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω'
};

/** 把 HTML 实体还原成普通字符（数字实体 + 常见命名实体） */
function unescapeHtml(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch (_) { return m; }
    })
    .replace(/&#(\d+);/g, (m, d) => {
      try { return String.fromCodePoint(parseInt(d, 10)); } catch (_) { return m; }
    })
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, n) => (
      Object.prototype.hasOwnProperty.call(ENTITIES, n) ? ENTITIES[n] : m
    ));
}

/**
 * 把一段 HTML 片段转成可读文本。
 *   keepLines = true  → 保留换行（块级标签、<br> 转成 \n）
 *   keepLines = false → 全部压成一行（默认，适合做摘要）
 */
function toText(html, opts) {
  const o = opts || {};
  let s = String(html === undefined || html === null ? '' : html);
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(?:p|div|li|tr|td|th|h[1-6]|section|article|blockquote|pre|dd|dt|ul|ol)\s*>/gi, '\n');
  s = s.replace(/<[^>]*>/g, '');
  s = unescapeHtml(s);
  if (o.keepLines) {
    return s.split('\n')
      .map((l) => l.replace(/[ \t\u00a0\u3000]+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  }
  return s.replace(/[\s\u00a0\u3000]+/g, ' ').trim();
}

/** 取标签里第一个指定属性的值（找不到返回 ''） */
function attrOf(html, name) {
  const src = String(html === undefined || html === null ? '' : html);
  const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) return '';
  const m = src.match(new RegExp(safe + '\\s*=\\s*"([^"]*)"', 'i'))
    || src.match(new RegExp(safe + "\\s*=\\s*'([^']*)'", 'i'));
  return m ? unescapeHtml(m[1]).trim() : '';
}

/** 按 class 关键字从一段 HTML 里收集所有 div 的内层文本，返回按长度降序的数组 */
function divTextsByClass(html, classWords) {
  const out = [];
  const src = String(html || '');
  const re = /<div\b[^>]*class\s*=\s*"([^"]*)"[^>]*>/gi;
  let m = null;
  const hits = [];
  while ((m = re.exec(src)) !== null) {
    const cls = m[1].toLowerCase();
    if (!classWords.some((w) => cls.indexOf(w) >= 0)) continue;
    hits.push({ start: m.index + m[0].length, openEnd: m.index + m[0].length });
  }
  for (let i = 0; i < hits.length; i++) {
    const from = hits[i].start;
    const to = i + 1 < hits.length ? hits[i + 1].openEnd : Math.min(src.length, from + 4000);
    const t = toText(src.slice(from, to));
    if (t) out.push(t);
  }
  return out.sort((a, b) => b.length - a.length);
}

module.exports = { unescapeHtml, toText, attrOf, divTextsByClass, ENTITIES };
