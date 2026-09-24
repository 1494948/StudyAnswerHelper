'use strict';
/* ------------------------------------------------------------------
 * 极简 HTTP 客户端（零依赖，只用 Node 内置 http / https / zlib）
 *   - 跟随重定向（最多 4 跳）
 *   - 超时保护，避免界面被网络卡死
 *   - 自动解压 gzip / deflate / br
 *   - 响应体大小上限，防止意外拉回一个巨大的页面
 * 所有失败都走返回值（{ ok:false, err }），不抛异常，调用方永远不用 try。
 * ------------------------------------------------------------------ */
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function request(url, opts) {
  const o = opts || {};
  const maxRedirect = o.maxRedirect === undefined ? 4 : o.maxRedirect;
  const maxBytes = o.maxBytes || (4 * 1024 * 1024);
  const timeoutMs = o.timeoutMs || 20000;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };

    let u = null;
    try { u = new URL(String(url)); } catch (_) { finish({ ok: false, err: '地址无效：' + url }); return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      finish({ ok: false, err: '不支持的协议：' + u.protocol });
      return;
    }

    let body = null;
    if (o.body !== undefined && o.body !== null) {
      body = Buffer.isBuffer(o.body) ? o.body : Buffer.from(String(o.body), 'utf8');
    }

    const headers = Object.assign({
      'User-Agent': o.userAgent || DEFAULT_UA,
      'Accept': o.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'close'
    }, o.headers || {});
    if (body) {
      headers['Content-Length'] = String(body.length);
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json; charset=utf-8';
    }

    const mod = u.protocol === 'https:' ? https : http;
    let req = null;

    function onResponse(res) {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location && maxRedirect > 0) {
        let next = '';
        try { next = new URL(res.headers.location, u).toString(); } catch (_) { next = String(res.headers.location); }
        try { res.resume(); } catch (_) { /* 忽略 */ }
        request(next, Object.assign({}, o, { maxRedirect: maxRedirect - 1 })).then(finish);
        return;
      }

      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      try {
        if (enc.indexOf('br') >= 0) stream = res.pipe(zlib.createBrotliDecompress());
        else if (enc.indexOf('gzip') >= 0) stream = res.pipe(zlib.createGunzip());
        else if (enc.indexOf('deflate') >= 0) stream = res.pipe(zlib.createInflate());
      } catch (_) { stream = res; }

      const chunks = [];
      let size = 0;
      let overflow = false;
      stream.on('data', (d) => {
        if (overflow) return;
        size += d.length;
        if (size > maxBytes) {
          overflow = true;
          try { res.destroy(); } catch (_) { /* 忽略 */ }
          return;
        }
        chunks.push(d);
      });
      const done = () => {
        if (overflow) {
          finish({ ok: false, status: code, err: '页面过大（超过 ' + Math.round(maxBytes / 1024) + ' KB）' });
          return;
        }
        const buf = Buffer.concat(chunks);
        finish({ ok: true, status: code, headers: res.headers, buffer: buf, text: buf.toString('utf8') });
      };
      stream.on('end', done);
      stream.on('close', done);
      stream.on('error', (e) => finish({
        ok: false, status: code,
        err: '读取响应失败：' + (e && e.message ? e.message : String(e))
      }));
    }

    try {
      req = mod.request({
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: o.method || (body ? 'POST' : 'GET'),
        headers: headers
      }, onResponse);
    } catch (e) {
      finish({ ok: false, err: '发起请求失败：' + (e && e.message ? e.message : String(e)) });
      return;
    }

    req.on('error', (e) => finish({
      ok: false, err: '网络请求失败：' + (e && e.message ? e.message : String(e))
    }));
    req.setTimeout(timeoutMs, () => {
      try { req.destroy(); } catch (_) { /* 忽略 */ }
      finish({ ok: false, err: '请求超时（' + timeoutMs + 'ms）' });
    });
    if (body) req.write(body);
    req.end();
  });
}

/** GET 一个网页，返回 { ok, status, text } */
function getText(url, opts) {
  return request(url, opts);
}

/** POST JSON，返回 { ok, status, data }；ok 表示 HTTP 2xx 且响应能解析成 JSON */
async function postJson(url, obj, opts) {
  const o = Object.assign({}, opts || {}, {
    method: 'POST',
    body: JSON.stringify(obj),
    headers: Object.assign({ 'Content-Type': 'application/json' }, (opts && opts.headers) || {})
  });
  const r = await request(url, o);
  if (!r.ok) return { ok: false, status: r.status || 0, err: r.err };
  let data = null;
  try {
    data = JSON.parse(r.text);
  } catch (_) {
    const excerpt = String(r.text || '').replace(/\s+/g, ' ').slice(0, 180);
    return {
      ok: false, status: r.status,
      err: '服务返回的不是 JSON（HTTP ' + r.status + '）：' + excerpt
    };
  }
  return { ok: r.status >= 200 && r.status < 300, status: r.status, data: data };
}

module.exports = { request, getText, postJson, DEFAULT_UA };
