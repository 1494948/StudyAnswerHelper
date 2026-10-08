'use strict';
/* 富文本输入：把答案文本切成「纯文本 / 数学公式 / 代码」三类片段，
 * 并负责把公式片段（LaTeX 或类 LaTeX 写法）转成 Unicode 数学符号。
 *
 * 为什么要有这一层：
 *   学习通主观题的答题框是富文本编辑器（Baidu UEditor）：它自带「公式」与「代码」
 *   按钮，能把 LaTeX 渲染成真正的数学公式、把代码渲染成代码块。但桌面版是"模拟键盘
 *   逐字输入"，只会输普通文本，于是 `a^2` 到屏幕上就是 `a^2` 而不是 a²，
 *   分数、根号、积分这类二维排版更不可能出现。
 *
 * 两条路线（由调用方选择，见 main.js 的 settings.richInput）：
 *   unicode —— 不碰学习通界面，把公式转成 Unicode 数学符号后按普通文本输入。
 *              零风险、离线可验证，能解决上下标、希腊字母、运算符、根号、分数（写作 a/b）。
 *   editor  —— 在 unicode 的基础上，进一步用 UI Automation 去点学习通自己的
 *              「公式」/「代码」按钮，把 LaTeX 填进它的公式弹窗。真正用上了学习通的
 *              排版能力，但依赖工具栏控件被无障碍接口暴露出来，失败时逐段回退到 unicode。
 *
 * 设计取舍（都很重要）：
 *   1. **只改显式标记过的内容**。没写 `$...$` 的文本一个字都不动 —— 绝不"自作主张"
 *      把 `1/2` 改成 `½`、把 `a^2` 改成 `a²`。用户的答案必须原样送达。
 *   2. **认不出就原样保留并记账**。不认识的 LaTeX 命令保持 `\cmd` 原文并计入 warnings，
 *      宁可难看也不静默吞掉用户写的内容。
 *   3. 零依赖、纯函数。SP_SELFTEST 直接断言，不起进程、不联网。
 */

/* ---------------- 符号表（LaTeX 命令 → Unicode） ----------------
 * 只收"有确定 Unicode 对应"的符号；没有对应的一律不写进来，
 * 让它们走 unknown 分支原样保留（例如 \overbrace 之类需要二维排版的宏）。
 */
const SYMBOLS = {
  /* 希腊字母（小写） */
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', varpi: 'ϖ',
  rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ',
  phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  /* 希腊字母（大写） */
  Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Epsilon: 'Ε', Zeta: 'Ζ',
  Eta: 'Η', Theta: 'Θ', Iota: 'Ι', Kappa: 'Κ', Lambda: 'Λ', Mu: 'Μ', Nu: 'Ν',
  Xi: 'Ξ', Omicron: 'Ο', Pi: 'Π', Rho: 'Ρ', Sigma: 'Σ', Tau: 'Τ', Upsilon: 'Υ',
  Phi: 'Φ', Chi: 'Χ', Psi: 'Ψ', Omega: 'Ω',
  /* 运算与关系 */
  times: '×', div: '÷', pm: '±', mp: '∓', cdot: '·', ast: '∗', star: '⋆',
  circ: '∘', bullet: '∙', oplus: '⊕', ominus: '⊖', otimes: '⊗', oslash: '⊘',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', equiv: '≡',
  approx: '≈', sim: '∼', simeq: '≃', cong: '≅', propto: '∝', ll: '≪', gg: '≫',
  prec: '≺', succ: '≻', asymp: '≍', doteq: '≐',
  /* 集合与逻辑 */
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', supset: '⊃', subseteq: '⊆',
  supseteq: '⊇', nsubseteq: '⊈', cup: '∪', cap: '∩', setminus: '∖',
  emptyset: '∅', varnothing: '∅', forall: '∀', exists: '∃', nexists: '∄',
  neg: '¬', lnot: '¬', land: '∧', wedge: '∧', lor: '∨', vee: '∨',
  top: '⊤', bot: '⊥', models: '⊨',
  /* 箭头 */
  to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔',
  Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', implies: '⟹',
  iff: '⟺', mapsto: '↦', uparrow: '↑', downarrow: '↓',
  longrightarrow: '⟶', longleftarrow: '⟵', updownarrow: '↕',
  /* 几何与其他 */
  angle: '∠', perp: '⊥', parallel: '∥', triangle: '△', square: '□',
  because: '∵', therefore: '∴', ldots: '…', dots: '…', cdots: '⋯',
  vdots: '⋮', ddots: '⋱', prime: '′', hbar: 'ℏ', ell: 'ℓ',
  Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ', wp: '℘', checkmark: '✓',
  langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉',
  vert: '|', Vert: '‖', backslash: '\\', lbrace: '{', rbrace: '}',
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭',
  oint: '∮', bigcup: '⋃', bigcap: '⋂', bigoplus: '⨁', bigotimes: '⨂',
  infty: '∞', partial: '∂', nabla: '∇', deg: '°', degree: '°',
  S: '§', P: '¶', copyright: '©', dollars: '$',
  /* 空白与排版命令：转成空格或空串 */
  quad: ' ', qquad: '  ', thinspace: ' ', enspace: ' ', ' ': ' ',
  left: '', right: '', limits: '', nolimits: '', displaystyle: '',
  textstyle: '', scriptstyle: '', bmod: ' ', pmod: ' ', choosing: ''
};

/* 这些命令后面跟的是"函数名"，直接原样输出（\sin x → sin x） */
const FUNCS = {
  sin: 1, cos: 1, tan: 1, cot: 1, sec: 1, csc: 1, arcsin: 1, arccos: 1,
  arctan: 1, sinh: 1, cosh: 1, tanh: 1, log: 1, ln: 1, lg: 1, exp: 1,
  lim: 1, max: 1, min: 1, sup: 1, inf: 1, det: 1, dim: 1, ker: 1, deg: 1,
  gcd: 1, lcm: 1, arg: 1, mod: 1, Pr: 1
};

/* 上下标可用字符（有 Unicode 形式的才收；没有的整段回退成 ^x / _x） */
const SUP = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶',
  '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼',
  '(': '⁽', ')': '⁾', 'n': 'ⁿ', 'i': 'ⁱ', 'a': 'ᵃ', 'b': 'ᵇ', 'c': 'ᶜ',
  'd': 'ᵈ', 'e': 'ᵉ', 'g': 'ᵍ', 'h': 'ʰ', 'j': 'ʲ', 'k': 'ᵏ', 'l': 'ˡ',
  'm': 'ᵐ', 'o': 'ᵒ', 'p': 'ᵖ', 'r': 'ʳ', 's': 'ˢ', 't': 'ᵗ', 'u': 'ᵘ',
  'v': 'ᵛ', 'w': 'ʷ', 'x': 'ˣ', 'y': 'ʸ', 'z': 'ᶻ'
};
const SUB = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆',
  '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '−': '₋', '=': '₌',
  '(': '₍', ')': '₎', 'a': 'ₐ', 'e': 'ₑ', 'h': 'ₕ', 'i': 'ᵢ', 'j': 'ⱼ',
  'k': 'ₖ', 'l': 'ₗ', 'm': 'ₘ', 'n': 'ₙ', 'o': 'ₒ', 'p': 'ₚ', 'r': 'ᵣ',
  's': 'ₛ', 't': 'ₜ', 'u': 'ᵤ', 'v': 'ᵥ', 'x': 'ₓ'
};

/* 命令名按长度倒序，保证 \leq 不会先被 \le 吃掉 */
const SYM_KEYS = Object.keys(SYMBOLS).sort(function (a, b) { return b.length - a.length; });

/* ---------------- LaTeX → Unicode ---------------- */

/** 从 i 处读一个 {...} 分组（支持嵌套），返回 { body, next }；不是分组时返回 null */
function readGroup(s, i) {
  let k = i;
  while (k < s.length && /\s/.test(s[k])) k++;
  if (s[k] !== '{') return null;
  let depth = 1;
  let j = k + 1;
  let body = '';
  while (j < s.length && depth > 0) {
    const c = s[j];
    if (c === '\\') { body += c + (s[j + 1] || ''); j += 2; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { j++; break; } }
    body += c;
    j++;
  }
  return { body: body, next: j };
}

/** 读一个可选参数 [...]，没有就返回 { body:null, next:i } */
function readOpt(s, i) {
  let k = i;
  while (k < s.length && /\s/.test(s[k])) k++;
  if (s[k] !== '[') return { body: null, next: i };
  const end = s.indexOf(']', k);
  if (end < 0) return { body: null, next: i };
  return { body: s.slice(k + 1, end), next: end + 1 };
}

/** 读一个"原子"：{...} 分组 > 反斜杠命令 > 单个字符（供 ^ / _ 使用）
 *  必须把整条命令当一个原子，否则 `90^\circ` 会被拆成 `^` + `\`，
 *  上标里只剩一个反斜杠，输出 `90^\`。 */
function readAtom(s, i) {
  const g = readGroup(s, i);
  if (g) return g;
  let k = i;
  while (k < s.length && /\s/.test(s[k])) k++;
  if (s[k] === '\\') {
    let j = k + 1;
    while (j < s.length && /[A-Za-z]/.test(s[j])) j++;
    if (j === k + 1) j = Math.min(s.length, k + 2);   /* 单字符命令，如 \( */
    return { body: s.slice(k, j), next: j };
  }
  return { body: s[k] || '', next: Math.min(s.length, k + 1) };
}

/** 逐字符映射成上标/下标；有一个字符映射不了就整体放弃（返回 null） */
function mapScripts(text, table) {
  const out = [];
  for (const ch of String(text)) {
    if (ch === ' ') { out.push(' '); continue; }
    const m = table[ch];
    if (!m) return null;
    out.push(m);
  }
  return out.join('');
}

/** 分数：a/b 能直白表示就直接写，否则加括号 (a)/(b)，避免歧义 */
function renderFrac(a, b) {
  const simple = function (x) { return /^[0-9A-Za-zα-ωΑ-Ωπ.]{1,4}$/.test(x); };
  const A = String(a || '').trim();
  const B = String(b || '').trim();
  if (simple(A) && simple(B)) return A + '/' + B;
  return '(' + A + ')/(' + B + ')';
}

/**
 * 把一个公式片段（LaTeX 或朴素写法）转成可逐字输入的 Unicode 文本。
 * @param {string} src
 * @returns {{ text: string, unknown: string[], notes: string[] }}
 */
function latexToUnicode(src) {
  const s = String(src === undefined || src === null ? '' : src);
  const unknown = [];
  const notes = [];
  let out = '';
  let i = 0;

  const push = function (x) { out += x; };

  while (i < s.length) {
    const c = s[i];

    /* 换行命令 \\ */
    if (c === '\\' && s[i + 1] === '\\') { push('\n'); i += 2; continue; }

    /* 反斜杠命令 */
    if (c === '\\') {
      let j = i + 1;
      /* 单字符命令：\, \; \! \  \{ \} \% \& \# \$ \_ \^ \~ \| */
      if (j < s.length && !/[A-Za-z]/.test(s[j])) {
        const ch = s[j];
        i = j + 1;
        if (ch === ',' || ch === ';' || ch === ':' || ch === '!' || ch === ' ') push(' ');
        else if ('{}%$#_^&~'.indexOf(ch) >= 0) push(ch);
        else if (ch === '|') push('‖');
        else if (ch === '-' ) push('');
        else push(ch);
        continue;
      }
      /* 多字符命令名 */
      let name = '';
      while (j < s.length && /[A-Za-z]/.test(s[j])) { name += s[j]; j++; }
      i = j;
      if (!name) { push('\\'); continue; }

      /* 分数族 */
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'cfrac' || name === 'binom') {
        const g1 = readGroup(s, i);
        const g2 = g1 ? readGroup(s, g1.next) : null;
        if (g1 && g2) {
          const a = latexToUnicode(g1.body).text;
          const b = latexToUnicode(g2.body).text;
          push(name === 'binom' ? 'C(' + a + ', ' + b + ')' : renderFrac(a, b));
          i = g2.next;
        } else {
          notes.push('\\' + name + ' 缺少参数，已原样保留');
          push('\\' + name);
        }
        continue;
      }

      /* 根号 */
      if (name === 'sqrt') {
        const o = readOpt(s, i);
        let k = o.next;
        const g = readGroup(s, k);
        const inner = g ? latexToUnicode(g.body).text : '';
        if (g) k = g.next;
        let idx = '';
        if (o.body) {
          const m = mapScripts(latexToUnicode(o.body).text, SUP);
          idx = m === null ? '^' + latexToUnicode(o.body).text : m;
        }
        const needParen = /[+\-−×÷=<>≤≥()/]/.test(inner) && inner.length > 1;
        push('√' + idx + (needParen ? '(' + inner + ')' : (g ? inner : '')));
        if (!g) { notes.push('\\sqrt 后面没有 {}，已按空处理'); }
        i = k;
        continue;
      }

      /* 纯文字包装：取内容，丢掉命令本身 */
      if (name === 'text' || name === 'mathrm' || name === 'mathbf' || name === 'mathit' ||
          name === 'mathsf' || name === 'mathtt' || name === 'operatorname' || name === 'mbox' ||
          name === 'textnormal' || name === 'mathcal' || name === 'mathbb') {
        const g = readGroup(s, i);
        if (g) { push(latexToUnicode(g.body).text); i = g.next; }
        else { push(''); }
        continue;
      }

      /* 长命令 + 短命令共用一张表（键已按长度倒序，但这里是整名匹配，直接用即可） */
      if (Object.prototype.hasOwnProperty.call(SYMBOLS, name)) {
        push(SYMBOLS[name]);
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(FUNCS, name)) {
        push(name);
        continue;
      }
      /* 认不出：原样保留，并记账。
         若后面紧跟 {...}，要把花括号一起吐回去 —— 否则 \begin{cases} 会被拆成
         `\begin` + 去掉括号的 `cases`，变成 `\begincases`，用户的内容就毁了。 */
      if (unknown.indexOf(name) < 0) unknown.push(name);
      const nb = readGroup(s, i);
      if (nb) {
        push('\\' + name + '{' + nb.body + '}');
        i = nb.next;
      } else {
        push('\\' + name);
      }
      continue;
    }

    /* 上下标 */
    if (c === '^' || c === '_') {
      const a = readAtom(s, i + 1);
      const inner = latexToUnicode(a.body).text;
      /* 特殊情形：^\circ 就是"度"，Unicode 里有现成的 °，别写成 ^(∘) */
      if (c === '^' && (inner === '∘' || inner === 'o')) {
        push('°');
        i = a.next;
        continue;
      }
      const mapped = mapScripts(inner, c === '^' ? SUP : SUB);
      if (mapped === null) {
        /* 没有对应 Unicode 字形（例如 x^{n+1}）→ 写成 ^(n+1)，保持可读且不失真 */
        push(c + (inner.length > 1 ? '(' + inner + ')' : inner));
        notes.push('「' + inner + '」没有对应的' + (c === '^' ? '上' : '下') + '标字形，已写成 ' +
          c + '(' + inner + ')');
      } else {
        push(mapped);
      }
      i = a.next;
      continue;
    }

    /* 花括号只是分组，本身不输出 */
    if (c === '{' || c === '}') { i++; continue; }

    /* 其它 LaTeX 细节：~ 是不换行空格，$ 已由上层剥离 */
    if (c === '~') { push(' '); i++; continue; }
    if (c === '&') { push(' '); i++; continue; }

    push(c);
    i++;
  }

  /* 收尾清理：多余空格、行首空格 */
  let text = out.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/^[ \t]+|[ \t]+$/g, '');
  return { text: text, unknown: unknown, notes: notes };
}

/* ---------------- 分词：把答案切成 文本 / 公式 / 代码 ---------------- */

const CODE_LANGS = ['js', 'javascript', 'ts', 'python', 'py', 'java', 'c', 'cpp', 'c++', 'csharp',
  'cs', 'go', 'rust', 'php', 'sql', 'html', 'css', 'json', 'xml', 'bash', 'sh', 'cmd', 'matlab', 'r'];

/** 判断代码围栏后面那个词是不是语言名（是就记下来，不是就当代码第一行） */
function normLang(w) {
  const t = String(w || '').trim().toLowerCase();
  return CODE_LANGS.indexOf(t) >= 0 ? t : '';
}

/**
 * 把文本切成片段数组。
 * 支持的标记（只有这些，其余一律按纯文本）：
 *   $$...$$       显示公式（可跨行）
 *   $...$         行内公式（不跨行；$ 后不能是空白，$ 前不能是空白，避免误伤价格）
 *   ```lang ... ```  代码块（围栏必须独占一行）
 *   `...`         行内代码（不跨行）
 * 反斜杠转义：\$ 表示字面量 $。
 *
 * @returns {Array<{type:'text'|'math'|'code', value:string, lang?:string, raw:string}>}
 */
function tokenize(input) {
  const s = String(input === undefined || input === null ? '' : input);
  const segs = [];
  let buf = '';
  let i = 0;

  const flush = function () {
    if (buf) { segs.push({ type: 'text', value: buf, raw: buf }); buf = ''; }
  };

  while (i < s.length) {
    const c = s[i];

    /* 转义的 \$ */
    if (c === '\\' && s[i + 1] === '$') { buf += '$'; i += 2; continue; }

    /* 代码围栏：必须独占一行 */
    if (c === '`' && s.startsWith('```', i) && (i === 0 || s[i - 1] === '\n')) {
      const lineEnd = s.indexOf('\n', i);
      const fenceLine = lineEnd < 0 ? s.slice(i) : s.slice(i, lineEnd);
      if (/^```[A-Za-z0-9+#._-]*\s*$/.test(fenceLine)) {
        const lang = normLang(fenceLine.slice(3));
        const bodyStart = lineEnd < 0 ? s.length : lineEnd + 1;
        /* 找配对的关闭围栏（同样要独占一行） */
        let closeAt = -1;
        let k = bodyStart;
        while (k < s.length) {
          const nl = s.indexOf('\n', k);
          const le = nl < 0 ? s.length : nl;
          const line = s.slice(k, le);
          if (/^```\s*$/.test(line)) { closeAt = k; break; }
          if (nl < 0) break;
          k = nl + 1;
        }
        if (closeAt >= 0) {
          flush();
          let body = s.slice(bodyStart, closeAt);
          body = body.replace(/\n$/, '');
          /* i 停在关闭围栏那一行的末尾之前（endIdx 指向它后面的换行）——
             不能把这枚换行也吃掉，否则"代码块下面那一行"会和代码粘在一起。 */
          const endIdx = s.indexOf('\n', closeAt);
          segs.push({ type: 'code', value: body, lang: lang, raw: s.slice(i, endIdx < 0 ? s.length : endIdx) });
          i = endIdx < 0 ? s.length : endIdx;
          continue;
        }
        /* 没有关闭围栏 → 当普通文本，不猜 */
      }
    }

    /* 行内代码 */
    if (c === '`') {
      const end = s.indexOf('`', i + 1);
      if (end >= 0 && s.slice(i + 1, end).indexOf('\n') < 0 && end > i + 1) {
        flush();
        segs.push({ type: 'code', value: s.slice(i + 1, end), lang: '', raw: s.slice(i, end + 1), inline: true });
        i = end + 1;
        continue;
      }
    }

    /* 显示公式 $$...$$ */
    if (c === '$' && s.startsWith('$$', i)) {
      const end = s.indexOf('$$', i + 2);
      if (end > i + 1) {
        flush();
        segs.push({ type: 'math', value: s.slice(i + 2, end), display: true, raw: s.slice(i, end + 2) });
        i = end + 2;
        continue;
      }
    }

    /* 行内公式 $...$ （两端不能是空白，避免误伤货币写法） */
    if (c === '$') {
      let end = -1;
      for (let k = i + 1; k < s.length; k++) {
        if (s[k] === '\n') break;
        if (s[k] === '\\') { k++; continue; }
        if (s[k] === '$') { end = k; break; }
      }
      if (end > i + 1 && !/\s/.test(s[i + 1]) && !/\s/.test(s[end - 1])) {
        flush();
        segs.push({ type: 'math', value: s.slice(i + 1, end), display: false, raw: s.slice(i, end + 1) });
        i = end + 1;
        continue;
      }
    }

    buf += c;
    i++;
  }

  flush();
  return segs;
}

/* ---------------- 生成"输入计划" ---------------- */

/* 代码块在纯文本模式下怎么落地：'' = 只输代码正文，'fence' = 连围栏一起输 */
const CODE_PLAIN = 'plain';

/**
 * 把一段文本转成有序的输入步骤。
 *
 * 步骤类型：
 *   { kind:'text',    text }              普通文本，逐字输入
 *   { kind:'formula', latex, unicode }    数学公式：editor 模式走学习通公式按钮，失败用 unicode
 *   { kind:'code',    code, lang, plain } 代码：editor 模式走学习通代码按钮，失败用 plain
 *
 * @param {string} input 原始答案
 * @param {{mode?:string, clean?:Function, codeFallback?:string}} opts
 *        mode: 'off' | 'unicode' | 'editor'
 *        clean: 可选，对"纯文本片段"再做一次清理（传入 main.js 的 cleanupText）
 * @returns {{steps:Array, segments:Array, mathCount:number, codeCount:number,
 *            warnings:string[], unknown:string[]}}
 */
function buildPlan(input, opts) {
  const o = opts || {};
  const mode = o.mode === 'unicode' || o.mode === 'editor' ? o.mode : 'off';
  const clean = typeof o.clean === 'function' ? o.clean : function (x) { return x; };
  const codeFallback = o.codeFallback === 'fence' ? 'fence' : CODE_PLAIN;
  const warnings = [];
  const unknown = [];

  /* 关掉富输入 = 完全沿用旧行为（一个字都不动），保证默认零风险 */
  if (mode === 'off') {
    return {
      steps: [{ kind: 'text', text: clean(String(input || '')) }],
      segments: [{ type: 'text', value: String(input || '') }],
      mathCount: 0, codeCount: 0, warnings: [], unknown: []
    };
  }

  const segments = tokenize(input);
  const steps = [];
  let mathCount = 0;
  let codeCount = 0;

  const addText = function (t) {
    if (!t) return;
    const last = steps[steps.length - 1];
    if (last && last.kind === 'text') last.text += t;
    else steps.push({ kind: 'text', text: t });
  };

  for (const seg of segments) {
    if (seg.type === 'text') {
      addText(clean(seg.value));
      continue;
    }
    if (seg.type === 'math') {
      mathCount++;
      const conv = latexToUnicode(seg.value);
      for (const u of conv.unknown) if (unknown.indexOf(u) < 0) unknown.push(u);
      for (const n of conv.notes) if (warnings.indexOf(n) < 0) warnings.push(n);
      if (mode === 'editor') {
        steps.push({ kind: 'formula', latex: String(seg.value).trim(), unicode: conv.text, display: !!seg.display });
      } else {
        addText(seg.display ? '\n' + conv.text + '\n' : conv.text);
      }
      continue;
    }
    if (seg.type === 'code') {
      codeCount++;
      const body = seg.inline ? String(seg.value) : String(seg.value);
      if (mode === 'editor' && !seg.inline) {
        steps.push({ kind: 'code', code: body, lang: seg.lang || '', plain: body });
      } else {
        addText(codeFallback === 'fence' && !seg.inline
          ? '```' + (seg.lang || '') + '\n' + body + '\n```'
          : body);
      }
      continue;
    }
  }

  if (unknown.length) {
    warnings.push('这些 LaTeX 命令没有对应符号，已按原文输入：' + unknown.map(function (x) { return '\\' + x; }).join(' '));
  }

  return {
    steps: steps,
    segments: segments,
    mathCount: mathCount,
    codeCount: codeCount,
    warnings: warnings,
    unknown: unknown
  };
}

/** 计划最终会变成的纯文本（用于界面预览与日志：与"真打进去的字"一致，不含编辑器动作） */
function renderPlan(plan) {
  const steps = (plan && plan.steps) || [];
  return steps.map(function (s) {
    if (s.kind === 'text') return s.text;
    if (s.kind === 'formula') return s.unicode;
    if (s.kind === 'code') return s.plain;
    return '';
  }).join('');
}

/** 给界面用的一句话摘要，例如「2 个公式、1 段代码」 */
function summary(plan) {
  if (!plan) return '';
  const parts = [];
  if (plan.mathCount) parts.push(plan.mathCount + ' 个公式');
  if (plan.codeCount) parts.push(plan.codeCount + ' 段代码');
  return parts.join('、');
}

module.exports = {
  tokenize, latexToUnicode, buildPlan, renderPlan, summary,
  SYMBOLS, SUP, SUB, CODE_LANGS
};
