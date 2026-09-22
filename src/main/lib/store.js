'use strict';
/* 零依赖 JSON 持久化：延迟合并写盘 + 原子替换 + 损坏自动备份重建
   支持 'a.b.c' 路径读写 */
const fs = require('fs');
const path = require('path');

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function deepClone(v) {
  if (v === undefined) return undefined;
  return JSON.parse(JSON.stringify(v));
}
function deepMerge(base, patch) {
  for (const k of Object.keys(patch || {})) {
    const pv = patch[k];
    if (isPlainObject(pv) && isPlainObject(base[k])) deepMerge(base[k], pv);
    else base[k] = deepClone(pv);
  }
  return base;
}

class Store {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = deepClone(defaults) || {};
    this.data = deepClone(defaults) || {};
    this._timer = null;
    this._load();
  }

  _load() {
    let raw = null;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e && e.code !== 'ENOENT') this._backup();
      this.data = deepClone(this.defaults) || {};
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed)) throw new Error('root is not an object');
      this.data = deepMerge(deepClone(this.defaults) || {}, parsed);
    } catch (e) {
      this._backup();
      this.data = deepClone(this.defaults) || {};
    }
  }

  _backup() {
    try {
      fs.copyFileSync(this.file, this.file + '.broken-' + Date.now() + '.bak');
    } catch (_) { /* 忽略 */ }
  }

  get(pathStr, dflt) {
    if (!pathStr) return deepClone(this.data);
    const parts = String(pathStr).split('.');
    let cur = this.data;
    for (const p of parts) {
      if (cur === null || cur === undefined) return dflt;
      cur = cur[p];
    }
    return cur === undefined ? dflt : deepClone(cur);
  }

  set(pathStr, value) {
    const parts = String(pathStr).split('.');
    let cur = this.data;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (!isPlainObject(cur[p])) cur[p] = {};
      cur = cur[p];
    }
    cur[parts[parts.length - 1]] = deepClone(value);
    this.save();
    return this;
  }

  merge(patch) {
    deepMerge(this.data, patch || {});
    this.save();
    return this;
  }

  all() {
    return deepClone(this.data);
  }

  save() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, 160);
    if (this._timer.unref) this._timer.unref();
  }

  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    const dir = path.dirname(this.file);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      /* 写盘失败不致命，界面继续可用 */
    }
  }
}

module.exports = { Store, deepClone, deepMerge, isPlainObject };
