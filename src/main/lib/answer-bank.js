'use strict';
/* ------------------------------------------------------------------
 * 本地题库（离线答案源）
 *   - 落盘在 userData/answer-bank.json，零第三方依赖
 *   - 延迟合并写盘 + 临时文件 rename 原子替换
 *   - 匹配用 textsim.matchScore（bigram + 数字特征），支持模糊命中
 *   - 支持批量导入：每行 "题目 || 答案"，或 JSON 数组
 * ------------------------------------------------------------------ */
const fs = require('fs');
const path = require('path');
const { matchScore, normalize, compact } = require('./textsim');

const LIMITS = {
  maxItems: 5000,
  maxQuestion: 1000,
  maxAnswer: 4000
};

function str(v, max) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

function newId() {
  return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function validItem(x) {
  return !!x && typeof x === 'object' && typeof x.question === 'string' && x.question.trim();
}

class AnswerBank {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, items: [] };
    this._timer = null;
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const items = raw && Array.isArray(raw.items) ? raw.items.filter(validItem) : [];
      this.data = { version: 1, items: items.slice(0, LIMITS.maxItems) };
    } catch (_) {
      this.data = { version: 1, items: [] };
    }
  }

  save() {
    if (this._timer) return this;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, 200);
    if (this._timer.unref) this._timer.unref();
    return this;
  }

  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (_) {
      /* 写盘失败不影响使用，内存里还在 */
    }
    return this;
  }

  all() {
    return this.data.items.map((x) => Object.assign({}, x));
  }

  count() {
    return this.data.items.length;
  }

  /** 新增或更新（题目归一化后相同则视为同一条，直接覆盖答案） */
  add(payload) {
    const p = payload || {};
    const question = str(p.question, LIMITS.maxQuestion);
    const answer = str(p.answer, LIMITS.maxAnswer);
    if (!question) return { ok: false, err: '题目为空' };
    const key = normalize(question);
    const list = this.data.items;
    const idx = list.findIndex((x) => normalize(x.question) === key);
    if (idx >= 0) {
      list[idx] = Object.assign({}, list[idx], {
        question: question,
        answer: answer,
        note: str(p.note, 500),
        tags: Array.isArray(p.tags) ? p.tags.map((t) => str(t, 24)).filter(Boolean).slice(0, 8) : list[idx].tags,
        source: str(p.source, 32) || list[idx].source,
        updatedAt: Date.now()
      });
      this.save();
      return { ok: true, id: list[idx].id, updated: true };
    }
    if (list.length >= LIMITS.maxItems) return { ok: false, err: '题库已达上限 ' + LIMITS.maxItems + ' 条' };
    const item = {
      id: newId(),
      question: question,
      answer: answer,
      note: str(p.note, 500),
      tags: Array.isArray(p.tags) ? p.tags.map((t) => str(t, 24)).filter(Boolean).slice(0, 8) : [],
      source: str(p.source, 32) || 'manual',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usedAt: 0,
      hits: 0
    };
    list.unshift(item);
    this.save();
    return { ok: true, id: item.id, updated: false };
  }

  update(id, patch) {
    const list = this.data.items;
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return { ok: false, err: '找不到该条目' };
    const p = patch || {};
    if ('question' in p) list[i].question = str(p.question, LIMITS.maxQuestion) || list[i].question;
    if ('answer' in p) list[i].answer = str(p.answer, LIMITS.maxAnswer);
    if ('note' in p) list[i].note = str(p.note, 500);
    list[i].updatedAt = Date.now();
    this.save();
    return { ok: true };
  }

  remove(id) {
    const before = this.data.items.length;
    this.data.items = this.data.items.filter((x) => x.id !== id);
    this.save();
    return { ok: this.data.items.length < before };
  }

  clear() {
    this.data.items = [];
    this.save();
    return { ok: true };
  }

  /** 命中后累加使用次数，便于日后按热度整理 */
  touch(id) {
    const it = this.data.items.find((x) => x.id === id);
    if (!it) return;
    it.usedAt = Date.now();
    it.hits = (parseInt(it.hits, 10) || 0) + 1;
    this.save();
  }

  /**
   * 模糊匹配。返回按分数降序的候选，分数低于阈值的不返回。
   * 分数 1.0 表示"归一化后完全一致"。
   */
  match(question, opts) {
    const o = opts || {};
    const minScore = Number.isFinite(o.minScore) ? o.minScore : 0.55;
    const limit = Math.max(1, parseInt(o.limit, 10) || 6);
    const q = String(question || '');
    if (!q.trim()) return [];
    const out = [];
    for (const it of this.data.items) {
      const score = matchScore(q, it.question);
      if (score < minScore) continue;
      out.push({
        id: it.id,
        source: 'local',
        kind: 'answer',
        score: score,
        answer: it.answer || '',
        detail: it.note || '',
        question: it.question,
        hits: it.hits || 0,
        used: !!it.usedAt
      });
    }
    out.sort((a, b) => (b.score - a.score) || (b.hits - a.hits));
    return out.slice(0, limit);
  }

  /**
   * 批量导入纯文本：每行一条，支持
   *   "题目 || 答案"   "题目 | 答案"   "题目<Tab>答案"   "题目===答案"
   * 返回 { ok, added, updated, skipped, errors }
   */
  importText(text) {
    const lines = String(text || '').split(/\r?\n/);
    let added = 0;
    let updated = 0;
    let skipped = 0;
    const errors = [];
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (!raw || raw.charAt(0) === '#') continue;
      const parts = raw.split(/\s*\|{2}\s*|\s*\|{1}\s*|\t+|\s*={3,}\s*/);
      if (parts.length < 2) { skipped++; continue; }
      const question = parts[0].trim();
      const answer = parts.slice(1).join(' ').trim();
      if (!question) { skipped++; continue; }
      const r = this.add({ question: question, answer: answer, source: 'import' });
      if (!r.ok) { errors.push('第 ' + (i + 1) + ' 行：' + r.err); continue; }
      if (r.updated) updated++; else added++;
    }
    this.flush();
    return { ok: true, added: added, updated: updated, skipped: skipped, errors: errors.slice(0, 10) };
  }

  /** 导入 JSON（数组或 { items:[...] }） */
  importJson(text) {
    let parsed = null;
    try {
      parsed = JSON.parse(String(text || ''));
    } catch (e) {
      return { ok: false, err: 'JSON 解析失败：' + (e && e.message ? e.message : String(e)) };
    }
    const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.items) ? parsed.items : null);
    if (!arr) return { ok: false, err: 'JSON 里没有找到条目数组' };
    let added = 0;
    let updated = 0;
    let skipped = 0;
    for (const it of arr) {
      if (!validItem(it)) { skipped++; continue; }
      const r = this.add({
        question: it.question,
        answer: it.answer,
        note: it.note,
        tags: it.tags,
        source: it.source || 'import'
      });
      if (!r.ok) { skipped++; continue; }
      if (r.updated) updated++; else added++;
    }
    this.flush();
    return { ok: true, added: added, updated: updated, skipped: skipped };
  }

  exportJson() {
    return JSON.stringify({ version: 1, exportedAt: Date.now(), items: this.data.items }, null, 2);
  }

  /** 给界面用的精简列表（题目截断，避免一次传太多字符） */
  brief(keyword, limit) {
    const kw = String(keyword || '').trim().toLowerCase();
    const lim = Math.max(1, parseInt(limit, 10) || 200);
    return this.data.items
      .filter((x) => !kw || x.question.toLowerCase().indexOf(kw) >= 0 || String(x.answer || '').toLowerCase().indexOf(kw) >= 0)
      .slice(0, lim)
      .map((x) => ({
        id: x.id,
        question: compact(x.question, 120),
        answer: compact(x.answer, 160),
        source: x.source || '',
        hits: x.hits || 0,
        createdAt: x.createdAt || 0
      }));
  }
}

module.exports = { AnswerBank, LIMITS };
