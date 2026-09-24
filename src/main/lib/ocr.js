'use strict';
/* ------------------------------------------------------------------
 * 题目图片识别（OCR）
 *
 * 两个引擎，可配置、可降级：
 *   1. ai      —— OpenAI 兼容多模态接口（主 + 备两个模型）。
 *                 数学题唯一可用的方案：能正确处理上标、分数、根号、π。
 *                 系统自带 OCR 实测会把 a²+b² 认成 a2+b2、3² 认成 32，
 *                 搜题必然失败，所以 AI 才是主力。
 *   2. windows —— Windows 自带 OCR（Windows.Media.Ocr）。离线、零配置，
 *                 印刷体中文正文可用，但**公式和上标会丢**，只作兜底。
 *
 * Windows OCR 的桥接方式：WinRT 无法用 koffi 直接调（不是 Win32 ABI），
 * 所以生成一段 PowerShell 脚本写到临时目录再执行，结果写 UTF-8 文件回传。
 * 走文件而不走 stdout，是为了绕开中文 Windows 控制台代码页（GBK）的乱码问题。
 *
 * PowerShell 脚本必须保持纯 ASCII：PS 5.1 读取无 BOM 的 UTF-8 脚本会按
 * 本地代码页解码，脚本里一旦出现中文，报错信息就会变成乱码。
 * 因此脚本内部只输出错误码 + ASCII 化的细节，由 Node 侧翻译成中文提示。
 * ------------------------------------------------------------------ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { postJson } = require('./http');

/* ================= AI 视觉识别 ================= */

/* 提示词的目标只有一个：**一字不差地转写**，不要"帮忙"改写或省略。
   实测要点：
   - 必须明确要求"逐行全部转写、不要省略选项行"，否则模型爱偷懒只给题干；
   - 上标/下标/分数必须给出**具体写法**，否则模型会输出 Unicode 上标（²）
     或 LaTeX（$a^2$），前者与系统 OCR 一样会丢，后者污染文本；
   - temperature 必须为 0。 */
const AI_OCR_PROMPT = [
  '把图片里的题目完整转写成纯文本。这是一道数学题，准确率最重要。',
  '',
  '严格按以下要求输出，不要任何开场白、解释或 Markdown 代码块：',
  '1. 逐行转写，一行都不要省略 —— 包括题干、括号、空行位置、以及每一个选项行（如 A. 3）。',
  '2. 数学符号用普通 ASCII 字符：',
  '   上标写成 ^2 ^3（例如 a² 写成 a^2），下标写成 _1 _2，',
  '   分数写成 a/b，根号写成 √，圆周率写成 π，乘号写成 ×，除号写成 ÷，',
  '   小于等于写成 ≤，大于等于写成 ≥，不等号写成 ≠，绝对值写成 |x|，',
  '   角度写成 °，三角形写成 △，因为/所以写成 ∵ / ∴。',
  '3. 不要使用 LaTeX 或 $ 符号；不要输出 Unicode 上标字符（如 ²、³），一律用 ^2、^3。',
  '4. 保留题号（如「1.」「（2）」）和选项标记（如「A.」「B.」）。',
  '5. 图片里有几道题就全部转写，题与题之间空一行。',
  '6. 某个字看不清时，写成〖?〗。不要凭猜测补字，也不要因此漏掉整行。',
  '7. 只输出题目文本本身，最后不要写任何总结或说明。'
].join('\n');

function aiEndpoint(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return null;
  return /\/chat\/completions$/i.test(base) ? base : base + '/chat/completions';
}

/** 把接口/模型返回的英文错误翻成人话，并针对"模型不收图"给出可操作建议 */
function humanizeAiError(msg, status) {
  let m = String(msg || '');
  if (status === 401 || status === 403) m = '密钥被拒绝（HTTP ' + status + '）' + (m ? '：' + m : '');
  else if (status === 404) m = '接口路径不存在（HTTP 404），多数服务需要以 /v1 结尾';
  else if (status === 429) m = '请求过于频繁或额度不足（HTTP 429）';
  else if (!m) m = 'HTTP ' + status;
  if (/image|multimodal|vision|picture|not support|不支持|无法处理图片|invalid.*content/i.test(m)) {
    m += ' —— 该模型可能不支持图片输入，请在「设置 → 图片识别」换成视觉模型' +
      '（如 glm-4v-flash、qwen-vl-plus、gpt-4o-mini）';
  }
  return m;
}

/** 单次请求（不带降级逻辑），供 aiOcr 在多个模型之间轮着调 */
async function aiOcrOne(url, key, model, dataUrl, cfg) {
  const body = {
    model: model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: AI_OCR_PROMPT },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]
    }],
    temperature: 0,
    max_tokens: parseInt(cfg.maxTokens, 10) || 2000,
    stream: false
  };

  const t0 = Date.now();
  const r = await postJson(url, body, {
    timeoutMs: parseInt(cfg.timeoutMs, 10) || 90000,
    headers: { Authorization: 'Bearer ' + key }
  });
  const ms = Date.now() - t0;

  if (!r.ok) {
    let raw = r.err || ('HTTP ' + r.status);
    if (r.data && r.data.error && r.data.error.message) raw = String(r.data.error.message);
    return { ok: false, err: humanizeAiError(raw, r.status), model: model, ms: ms, status: r.status };
  }

  const d = r.data || {};
  const choice = d.choices && d.choices[0];
  const content = choice && choice.message ? String(choice.message.content || '') : '';
  if (!content.trim()) return { ok: false, err: '模型返回了空内容（图片可能太大或不可读）', model: model, ms: ms };

  return { ok: true, text: stripCodeFence(content.trim()), model: model, ms: ms };
}

function stripCodeFence(text) {
  let t = String(text || '').trim();
  if (t.indexOf('```') !== 0) return t;
  const lines = t.split('\n');
  if (lines[0].indexOf('```') === 0) lines.shift();
  if (lines.length && lines[lines.length - 1].trim() === '```') lines.pop();
  return lines.join('\n').trim();
}

/**
 * AI 多模态识别：主模型失败自动换备选模型。
 * cfg: { apiKey, baseUrl, model, fallbackModel, maxTokens, timeoutMs, mime }
 */
async function aiOcr(imagePath, cfg) {
  const c = cfg || {};
  const key = String(c.apiKey || '').trim();
  if (!key) return { ok: false, err: '未配置 AI 密钥（设置 → 图片识别）', provider: 'ai', ms: 0 };

  const url = aiEndpoint(c.baseUrl);
  if (!url) return { ok: false, err: 'AI 接口地址无效：' + (c.baseUrl || '（空）'), provider: 'ai', ms: 0 };

  /* 主 → 备，去重；两个都没填就当没配 */
  const models = [];
  for (const m of [c.model, c.fallbackModel]) {
    const s = String(m || '').trim();
    if (s && models.indexOf(s) < 0) models.push(s);
  }
  if (!models.length) {
    return {
      ok: false, provider: 'ai', ms: 0,
      err: '未设置视觉模型名（设置 → 图片识别 → 视觉模型）。普通对话模型多数不支持图片'
    };
  }

  let buf = null;
  try {
    buf = fs.readFileSync(imagePath);
  } catch (e) {
    return { ok: false, err: '读取图片失败：' + (e && e.message ? e.message : String(e)), provider: 'ai', ms: 0 };
  }
  if (!buf || !buf.length) return { ok: false, err: '图片内容是空的', provider: 'ai', ms: 0 };
  if (buf.length > 4 * 1024 * 1024) {
    return {
      ok: false, provider: 'ai', ms: 0,
      err: '图片太大（' + (buf.length / 1048576).toFixed(1) + ' MB），多数接口限制 4~10 MB。' +
        '截图时框小一点，或者把图缩小后重试'
    };
  }

  const mime = String(c.mime || 'png').toLowerCase();
  const dataUrl = 'data:image/' + mime + ';base64,' + buf.toString('base64');

  const t0 = Date.now();
  const errors = [];
  const attempts = [];
  for (const model of models) {
    const r = await aiOcrOne(url, key, model, dataUrl, c);
    attempts.push({ model: model, ok: !!r.ok, err: r.err || '', ms: r.ms || 0 });
    if (r.ok) {
      return Object.assign({}, r, {
        provider: 'ai',
        attempts: attempts,
        triedModels: attempts.map((a) => a.model),
        ms: Date.now() - t0
      });
    }
    errors.push(model + '：' + r.err);
    /* 已经换成备选模型了还失败，就没必要继续 */
  }
  return {
    ok: false,
    provider: 'ai',
    err: errors.join(' ／ '),
    errors: errors,
    attempts: attempts,
    ms: Date.now() - t0
  };
}

/* ================= Windows 系统自带 OCR ================= */

/* PowerShell 脚本放在独立文件 ocr-win.ps1 里（该文件头部说明了两个关键点：
   1) 为什么必须纯 ASCII —— PS 5.1 按 ANSI 代码页读无 BOM 的 UTF-8 脚本；
   2) 为什么必须用 AsTask 反射 —— PS 5.1 不会在 WinRT 投影对象上解析扩展方法，
      .GetAwaiter() 会报 "cannot call on System.__ComObject"。 */
function psScriptPath() {
  const p = path.join(__dirname, 'ocr-win.ps1');
  const u = String(p).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  return (u !== p && fs.existsSync(u)) ? u : p;
}

function ensurePsScript() {
  const p = psScriptPath();
  if (!fs.existsSync(p)) throw new Error('找不到 OCR 脚本：' + p);
  return p;
}

function mapWinErr(code, detail) {
  const map = {
    NO_OCR_ENGINE: '系统没有可用的中文 OCR 语言包。请在「Windows 设置 → 时间和语言 → 语言」添加中文（简体），或在设置里改用 AI 识别',
    IMAGE_NOT_FOUND: '找不到图片文件',
    PSEXCEPTION: '系统 OCR 执行出错',
    NO_AWAIT_HELPER: 'PowerShell 缺少 WinRT 异步桥接（系统组件异常）'
  };
  const base = map[code] || ('系统 OCR 失败：' + code);
  return detail ? (base + '（' + detail + '）') : base;
}

/**
 * Windows OCR 会把每个汉字之间都插上空格（"例 题 （ 选 择 题 ）"），
 * 直接拿去搜题会因为分词全错而失败；这里把中文/全角标点之间的空格收回。
 * 中英之间（"已知 a+b"）的空格保留，那是有意义的间隔。
 */
const CJK_RANGE = '\\u3000-\\u303f\\u4e00-\\u9fff\\uff00-\\uffef';
function tightenCjk(s) {
  const re = new RegExp('([' + CJK_RANGE + '])[ \\t]+(?=[' + CJK_RANGE + '])', 'g');
  return String(s === undefined || s === null ? '' : s).replace(re, '$1');
}

/** 去掉行首行尾空白、压掉连续空行 */
function tidyLines(s) {
  return String(s || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t\u3000]+$/, '').replace(/^[ \t\u3000]+/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 用 Windows 自带 OCR 识别一张图片。
 * imagePath 必须是磁盘上的真实路径（临时文件即可）。
 */
function winOcr(imagePath, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const t0 = Date.now();
    let outPath = '';
    try {
      outPath = path.join(os.tmpdir(), 'sah-ocr-' + Date.now() + '-' +
        Math.random().toString(36).slice(2, 6) + '.json');
    } catch (e) {
      resolve({ ok: false, err: '临时目录不可用：' + (e && e.message), provider: 'windows' });
      return;
    }

    let ps = '';
    try {
      ps = ensurePsScript();
    } catch (e) {
      resolve({ ok: false, err: (e && e.message ? e.message : String(e)), provider: 'windows', ms: 0 });
      return;
    }

    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', ps, '-Image', imagePath, '-Out', outPath];
    if (o.lang) args.push('-Lang', String(o.lang));

    let child = null;
    let done = false;
    let errTail = '';
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (outPath && fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_) { /* 忽略 */ }
      resolve(v);
    };
    const timer = setTimeout(() => {
      try { if (child) child.kill(); } catch (_) { /* 忽略 */ }
      finish({
        ok: false,
        err: 'OCR 超时（' + Math.round((o.timeoutMs || 30000) / 1000) + ' 秒）',
        provider: 'windows', ms: Date.now() - t0
      });
    }, o.timeoutMs || 30000);

    try {
      child = spawn('powershell.exe', args, { windowsHide: true });
    } catch (e) {
      finish({ ok: false, err: '无法启动 PowerShell：' + (e && e.message ? e.message : String(e)), provider: 'windows', ms: Date.now() - t0 });
      return;
    }
    child.stderr.on('data', (d) => {
      errTail = (errTail + String(d)).slice(-600);
    });
    child.on('exit', (code) => {
      let parsed = null;
      try {
        if (fs.existsSync(outPath)) parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      } catch (_) { parsed = null; }
      if (parsed && parsed.ok) {
        finish({
          ok: true,
          text: tidyLines(tightenCjk(String(parsed.text || ''))),
          rawText: String(parsed.text || ''),
          lang: String(parsed.lang || ''),
          width: parsed.width || 0,
          height: parsed.height || 0,
          lines: parsed.lines || 0,
          provider: 'windows',
          ms: Date.now() - t0
        });
        return;
      }
      if (parsed && parsed.err) {
        finish({
          ok: false,
          err: mapWinErr(String(parsed.err), parsed.detail),
          rawdetail: String(parsed.raw || ''),
          step: String(parsed.step || ''),
          provider: 'windows', ms: Date.now() - t0
        });
        return;
      }
      finish({
        ok: false,
        err: 'OCR 进程异常退出（code=' + code + '）' + (errTail.trim() ? '：' + errTail.trim().slice(0, 200) : ''),
        provider: 'windows',
        ms: Date.now() - t0
      });
    });
    child.on('error', (e) => {
      finish({ ok: false, err: '启动 OCR 进程失败：' + (e && e.message ? e.message : String(e)), provider: 'windows', ms: Date.now() - t0 });
    });
  });
}

/** 检测系统里有哪些可用的 OCR 语言（设置页「检测系统 OCR」用） */
function listWinOcrLanguages(timeoutMs) {
  return new Promise((resolve) => {
    const PS = [
      '$ErrorActionPreference = "Stop"',
      'Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null',
      '$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]',
      '$null = [Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime]',
      '$tags = @()',
      'try { foreach ($l in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) { $tags += $l.LanguageTag } } catch { }',
      '$cur = ""',
      'try { $e = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages(); if ($e) { $cur = $e.RecognizedLanguage.LanguageTag } } catch { }',
      '$zh = $false',
      'try {',
      '  $lo = New-Object Windows.Globalization.Language("zh-Hans-CN")',
      '  $e2 = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lo)',
      '  if ($e2) { $zh = $true }',
      '} catch { }',
      '$obj = @{ ok = $true; langs = $tags; current = $cur; zhOk = $zh }',
      '[System.IO.File]::WriteAllText($args[0], ($obj | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))'
    ].join('\n');
    const outPath = path.join(os.tmpdir(), 'sah-ocr-lang-' + Date.now() + '.json');
    const scriptPath = path.join(os.tmpdir(), 'sah-ocr-lang-' + Date.now() + '.ps1');
    try { fs.writeFileSync(scriptPath, PS, 'utf8'); } catch (e) {
      resolve({ ok: false, err: '写临时脚本失败：' + (e && e.message) });
      return;
    }
    let done = false;
    let child = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_) { /* 忽略 */ }
      try { if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath); } catch (_) { /* 忽略 */ }
      resolve(v);
    };
    const timer = setTimeout(() => {
      try { if (child) child.kill(); } catch (_) { /* 忽略 */ }
      finish({ ok: false, err: '检测超时' });
    }, timeoutMs || 20000);
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath, outPath], { windowsHide: true });
    } catch (e) {
      finish({ ok: false, err: '无法启动 PowerShell：' + (e && e.message) });
      return;
    }
    child.on('exit', () => {
      try {
        const obj = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        const langs = Array.isArray(obj.langs) ? obj.langs : [];
        finish({
          ok: true,
          langs: langs,
          current: String(obj.current || ''),
          zhOk: !!obj.zhOk,
          hasZh: langs.some((t) => /^zh/i.test(String(t))) || !!obj.zhOk
        });
      } catch (e) {
        finish({ ok: false, err: '读取检测结果失败：' + (e && e.message) });
      }
    });
    child.on('error', (e) => finish({ ok: false, err: '启动检测进程失败：' + (e && e.message) }));
  });
}

/* ================= 统一入口 ================= */

/**
 * 识别一张磁盘上的图片。
 *   opts.engine = 'auto' | 'ai' | 'windows'
 *   opts.hasAiKey      —— auto 模式下决定先试谁
 *   opts.ai            —— aiOcr 的配置（含 model / fallbackModel）
 *   opts.lang          —— Windows OCR 语言，留空走脚本内置的降级链
 * auto 顺序：AI（主→备）→ 系统 OCR。任何一步成功就返回。
 * 返回值里的 attempts 记录每一档的成败，界面可以如实告诉用户"是谁识别的、谁失败了"。
 */
async function recognize(imagePath, opts) {
  const o = opts || {};
  const engine = String(o.engine || 'auto');
  const t0 = Date.now();
  const attempts = [];
  const errors = [];

  if (!imagePath || !fs.existsSync(imagePath)) {
    return { ok: false, err: '找不到图片文件', attempts: attempts, errors: errors, ms: 0 };
  }

  const wantAi = (engine === 'ai') || (engine === 'auto' && (o.hasAiKey || o.preferAi));
  const wantWin = (engine === 'windows') || (engine === 'auto');

  if (wantAi) {
    const r = await aiOcr(imagePath, o.ai || {});
    if (Array.isArray(r.attempts)) {
      for (const a of r.attempts) attempts.push({ provider: 'ai', model: a.model, ok: !!a.ok, err: a.err || '', ms: a.ms || 0 });
    } else {
      attempts.push({ provider: 'ai', ok: !!r.ok, err: r.err || '', ms: r.ms || 0 });
    }
    if (r.ok) return Object.assign({}, r, { attempts: attempts, errors: errors, ms: Date.now() - t0 });
    errors.push('AI 识别：' + r.err);
    if (engine === 'ai') {
      return { ok: false, err: r.err, attempts: attempts, errors: errors, ms: Date.now() - t0 };
    }
  }

  if (wantWin) {
    const w = await winOcr(imagePath, { lang: o.lang, timeoutMs: o.timeoutMs });
    attempts.push({ provider: 'windows', ok: !!w.ok, err: w.err || '', ms: w.ms || 0 });
    if (w.ok) return Object.assign({}, w, { attempts: attempts, errors: errors, ms: Date.now() - t0 });
    errors.push('系统 OCR：' + w.err);
    if (engine === 'windows') {
      return { ok: false, err: w.err, attempts: attempts, errors: errors, ms: Date.now() - t0 };
    }
  }

  const last = errors.length ? errors[errors.length - 1] : '没有可用的识别引擎';
  return { ok: false, err: last, attempts: attempts, errors: errors, ms: Date.now() - t0 };
}

module.exports = {
  recognize, aiOcr, aiOcrOne, winOcr, listWinOcrLanguages, aiEndpoint, mapWinErr,
  tightenCjk, tidyLines, stripCodeFence, humanizeAiError,
  AI_OCR_PROMPT
};
