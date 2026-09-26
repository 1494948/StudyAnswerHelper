'use strict';
/* 学科识别 + 选择题解析：零依赖、纯词法特征打分，不联网。
 *
 * 用途有三个：
 *   1) 让 AI 提示词按学科切换（数学要步骤、英语要给译文、语文要出处…）
 *   2) 让检索式带上学科线索，提高题库站命中率
 *   3) 判断"是不是选择题、正确答案是哪个字母"，供自动点选使用
 *
 * 设计取舍：不做模型、不联网。识别错也不致命 —— 置信度会一起返回，
 * 界面允许人工改，AI 提示词在低置信度时退回"通用"版本。
 */

/* 全角 → 半角（只处理字母、数字与几个常用标点，够用且不会误伤汉字） */
function toHalf(s) {
  return String(s || '').replace(/[\uFF01-\uFF5E]/g, function (ch) {
    return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
  }).replace(/\u3000/g, ' ');
}

const SUBJECTS = [
  {
    id: 'math', label: '数学',
    kw: ['求值', '化简', '解方程', '方程组', '不等式', '函数', '数列', '三角函数', '概率',
      '排列组合', '面积', '体积', '周长', '导数', '积分', '向量', '集合', '最大值', '最小值',
      '取值范围', '证明'],
    /* 弱特征：这些词数学题里很常见，但别的学科也用，单独出现不足以定学科 */
    wk: ['已知', '则', '计算', '解得', '圆的', '三角形', '多边形', '角度', '正确的是'],
    /* 数学符号。注意这里刻意不含字母 —— 早前把 abcxyz 写进这个字符类，
       导致"print(len(\"abc\"))"这种信息技术题被算成数学特征，把数学分顶了上去。 */
    sym: /[√∫∑∏≤≥≠∞°∠∽≈±∵∴∈⊆∪∩²³⁴⁵⁰¹×÷]/g,
    symMin: 3,
    /* 代数式：数字/字母 + 运算符 + 数字/字母。这条比单个符号更能说明"这是数学题" */
    pat: /[a-zA-Z0-9]\s*[+\-*/^=]\s*[a-zA-Z0-9(]/g,
    patMin: 1
  },
  {
    id: 'english', label: '英语',
    kw: ['choose', 'best', 'complete', 'blanks', 'means', 'following', 'passage',
      'according', 'underlined', 'translate', 'sentence', 'word', 'grammar', 'correct',
      '根据短文', '翻译', '单词', '填空', '语法的', '画线部分'],
    sym: /\b[a-zA-Z]{4,}\b/g,
    symMin: 2
  },
  {
    id: 'chinese', label: '语文',
    kw: ['加点字', '读音', '字形', '错别字', '语病', '病句', '成语', '标点', '修辞',
      '诗句', '诗人', '作者是', '文言文', '默写', '名著', '对联', '文学常识', '解释下列',
      '一词多义', '通假字', '实词', '虚词', '表达效果', '下列词语'],
    sym: /[“”《》]/g,
    symMin: 1
  },
  {
    id: 'physics', label: '物理',
    kw: ['速度', '加速度', '牛顿', '重力', '摩擦力', '浮力', '压强', '密度', '做功',
      '功率', '动能', '势能', '机械能', '杠杆', '滑轮', '电路', '电流', '电压', '电阻',
      '欧姆', '电功率', '磁场', '折射', '反射', '焦距', '波长', '频率', '光的', '物体'],
    sym: /(m\/s|kg\/m|N\/|帕|焦|瓦|欧|安培|伏特)/g,
    symMin: 1
  },
  {
    id: 'chemistry', label: '化学',
    kw: ['化学式', '化学方程式', '相对分子质量', '摩尔', '物质的量', '溶液', '溶质',
      '溶解度', '氧化', '还原', '离子', '化合价', '元素', '原子', '分子', '生成物',
      '酸碱', '中和', '沉淀', '气体', '实验现象', '配平', '催化剂'],
    sym: /\b(?:[A-Z][a-z]?\d*){2,}\b|H2O|CO2|NaOH|HCl|O2|H2/g,
    symMin: 1
  },
  {
    id: 'biology', label: '生物',
    kw: ['细胞', '遗传', '基因', '染色体', '蛋白质', '酶', '光合作用', '呼吸作用',
      '生态系统', '种群', '食物链', '细胞膜', '细胞核', '有丝分裂', '减数分裂',
      '显性', '隐性', '生物', '组织', '器官', '消化', '免疫'],
    sym: /(DNA|RNA|ATP|mRNA|tRNA)/g,
    symMin: 1
  },
  {
    id: 'history', label: '历史',
    kw: ['朝代', '世纪', '战争', '革命', '条约', '皇帝', '王朝', '变法', '运动',
      '起义', '会议', '时期', '建立', '灭亡', '统治', '侵略', '解放', '洋务', '维新',
      '改革', '历史意义', '标志着'],
    sym: /(公元前|公元|\d{3,4}\s*年)/g,
    symMin: 1
  },
  {
    id: 'geography', label: '地理',
    kw: ['纬度', '经度', '气候', '地形', '河流', '山脉', '高原', '平原', '盆地',
      '海拔', '季风', '降水', '气温', '时区', '等温线', '洋流', '板块', '城市化',
      '农业区位', '地势', '半球'],
    sym: /(东经|西经|北纬|南纬|\d+\s*°[NSEW])/g,
    symMin: 1
  },
  {
    id: 'politics', label: '道德与法治',
    kw: ['宪法', '人民代表大会', '法律', '权利', '义务', '公民', '政府', '制度',
      '价值观', '市场经济', '民主', '法治', '道德', '集体', '社会主义', '中国共产党',
      '依法', '监察', '政协'],
    sym: null
  },
  {
    id: 'it', label: '信息技术',
    kw: ['算法', '程序', '代码', '变量', '循环', '数组', '字符串', '数据库', '网络',
      '协议', '操作系统', '编程', '二进制', '字节', '内存', '硬盘', '智能', '数据',
      '人工智能', '信息安全'],
    sym: /(CPU|GPU|SQL|HTML|URL|HTTP|Python|Java|IP\b|RAM|USB)/g,
    symMin: 1
  }
];

const GENERAL = { id: 'general', label: '通用' };

/* 每个学科的 AI 提示词补充：只在置信度够时才用 */
const AI_HINTS = {
  math: '这是数学题。写出关键步骤，结果保留到最简形式（分数不要化小数、根式要化简）。选择题在【答案】那行只写选项字母。',
  english: 'This is an English question. Put the option letter (A/B/C/D) or the exact word/phrase in 【答案】. In 【解析】 explain the grammar or vocabulary point, and add a Chinese translation of the key sentence.',
  chinese: '这是语文题。字音字形题给出正确读音或写法，病句题指出病因，文言文给出准确译文，文学常识题写清出处与作者。【解析】简明扼要。',
  physics: '这是物理题。先写用到的公式，再代入数据，结果必须带单位。选择题在【答案】那行只写选项字母。',
  chemistry: '这是化学题。化学方程式必须配平并注明条件与气体/沉淀符号。【解析】写清反应原理或计算过程。',
  biology: '这是生物题。用规范术语作答，选择题在【答案】那行只写选项字母，【解析】说明判断依据。',
  history: '这是历史题。给出史实与时间，说明历史背景或影响，选择题在【答案】那行只写选项字母。',
  geography: '这是地理题。说明地理成因与规律，涉及方位的要写清方向，选择题在【答案】那行只写选项字母。',
  politics: '这是道德与法治题。用规范的政治术语作答，紧扣材料，选择题在【答案】那行只写选项字母。',
  it: '这是信息技术题。给出准确的技术术语，涉及代码时写出关键语句，选择题在【答案】那行只写选项字母。',
  general: '先判断题目的学科，再按该学科的规范作答。选择题在【答案】那行只写选项字母（如 A），不要写选项内容。'
};

/* 语言先验：汉字占比很高且几乎没有英文单词 → 排除"英语" */
function scriptProfile(text) {
  let cjk = 0, latin = 0, other = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c >= 0x4e00 && c <= 0x9fff) cjk++;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++;
    else other++;
  }
  const total = cjk + latin + other || 1;
  return { cjk: cjk / total, latin: latin / total, latinWords: (text.match(/\b[a-zA-Z]{4,}\b/g) || []).length };
}

/**
 * 识别学科。
 * @returns {{subject:string,label:string,confidence:number,scores:object,reasons:object,
 *            ranking:string[],isChoice:boolean,options:string[],note:string}}
 */
function detect(input) {
  const raw = String(input === undefined || input === null ? '' : input);
  const text = toHalf(raw).replace(/\s+/g, ' ').trim();
  const prof = scriptProfile(text);
  const scores = {};
  const reasons = {};

  const empty = Object.assign({}, GENERAL, {
    subject: 'general', confidence: 0, scores: {}, reasons: {}, ranking: ['general'], note: '题目为空'
  });

  if (!text) {
    return Object.assign(empty, choiceInfo(text));
  }

  for (const s of SUBJECTS) {
    let sc = 0;
    const hit = [];
    for (const k of s.kw) {
      if (text.indexOf(k) >= 0) { sc += 2; hit.push(k); }
    }
    for (const k of (s.wk || [])) {
      if (text.indexOf(k) >= 0) { sc += 0.75; hit.push('·' + k); }
    }
    if (s.sym) {
      const m = text.match(s.sym);
      const need = s.symMin || 1;
      if (m && m.length >= need) { sc += Math.min(8, m.length * 1.5); hit.push('符号×' + m.length); }
    }
    if (s.pat) {
      const m = text.match(s.pat);
      const need = s.patMin || 1;
      if (m && m.length >= need) { sc += Math.min(8, m.length * 2); hit.push('式子×' + m.length); }
    }
    if (sc > 0) { scores[s.id] = sc; reasons[s.id] = hit.slice(0, 6); }
  }

  /* 语言先验只做修正，不做决定 —— 避免把"英语题干里夹一个汉字"整体带偏 */
  if (prof.cjk > 0.35) {
    if (scores.english) { scores.english *= 0.25; reasons.english && reasons.english.push('汉字占比高，降权'); }
  }
  if (prof.cjk < 0.08 && prof.latin > 0.55 && prof.latinWords >= 3) {
    scores.english = (scores.english || 0) + 4;
    (reasons.english = reasons.english || []).push('英文单词占比高');
  }

  const ranking = Object.keys(scores).sort(function (a, b) { return scores[b] - scores[a]; });
  if (!ranking.length) {
    return Object.assign({}, GENERAL, {
      subject: 'general', confidence: 0, scores: scores, reasons: reasons, ranking: ['general'],
      note: '没有命中任何学科特征，按通用处理'
    }, choiceInfo(text));
  }

  const best = ranking[0];
  const top = scores[best];
  const second = ranking[1] ? scores[ranking[1]] : 0;
  /* 置信度：既看绝对分，也看与第二名的差距。两科打平时故意压低。 */
  const abs = Math.min(1, top / 8);
  const gap = top > 0 ? (top - second) / top : 0;
  const confidence = Math.round((abs * 0.55 + gap * 0.45) * 100) / 100;
  const meta = SUBJECTS.find(function (s) { return s.id === best; }) || GENERAL;

  return Object.assign({}, choiceInfo(text), {
    subject: best,
    label: meta.label,
    confidence: confidence,
    scores: scores,
    reasons: reasons,
    ranking: ranking,
    note: gap < 0.25 && ranking.length > 1
      ? '命中多个学科且分数接近，已选最高分；可在界面上手动指定'
      : ''
  });
}

/* ---------------- 选择题解析 ---------------- */

/* 选项标记：A. / A、/ A．/ A) / A：
 *
 * 前导字符的判定用"排除法"：只要前一个字符不是数字、英文字母或汉字，就认。
 * 早前写成了"必须紧跟空白或逗号"的白名单，结果 `……的值为（ ）A.3 B.4` 这种
 * 题干括号后直接跟选项的写法全都识别不出来 —— 而这恰恰是最常见的排版。
 * 排除法还能挡住 `H2O`、`pH值`、`AB` 这类字母夹在词中的情况。 */
const OPTION_RE = /(^|[^0-9A-Za-z\u4e00-\u9fff])([A-H])\s*[.、．)）:：]/g;

/** 从题目里抽出选项字母（按出现顺序去重，至少 2 个才算选择题） */
function optionsOf(input) {
  const text = toHalf(String(input || ''));
  const found = [];
  let m;
  OPTION_RE.lastIndex = 0;
  while ((m = OPTION_RE.exec(text)) !== null) {
    const L = m[2].toUpperCase();
    if (found.indexOf(L) < 0) found.push(L);
  }
  /* 只保留从 A 开始连续递增的那一段，避免把解析里的 "B" "C" 误当成选项 */
  const seq = [];
  let next = 'A';
  for (const L of found) {
    if (L === next) { seq.push(L); next = String.fromCharCode(next.charCodeAt(0) + 1); }
  }
  return seq;
}

/** 从答案文本里抠出选项字母；抠不到返回 '' */
function letterOfAnswer(input) {
  const t = toHalf(String(input === undefined || input === null ? '' : input)).trim();
  if (!t) return '';
  const pats = [
    /^[（(【\[]?\s*([A-H])\s*[）)】\]]?\s*$/i,               /* 就是 "A" */
    /^([A-H])\s*[.、．)）:：]/,                               /* "A." / "A、3" */
    /(?:答案|answer|选|应选|故选|正确选项|correct)\s*[:：是]?\s*([A-H])(?![A-Za-z])/i,
    /\b(?:is|are|选|是|为)\s*[:：]?\s*([A-H])(?![A-Za-z])/i,  /* "The answer is C" / "为 C" */
    /^([A-H])(?![A-Za-z])/                                    /* 兜底：以单个字母开头 */
  ];
  for (const p of pats) {
    const m = t.match(p);
    if (m) return m[1].toUpperCase();
  }
  return '';
}

/**
 * 从答案里抽出全部选项字母（多选题会返回多个，如 "AB"、"A、C"、"选 A 和 C"）。
 * 只在"整段答案很短、且字母是独立出现的"时候才认，避免把解析里的英文单词首字母当选项。
 */
function lettersOfAnswer(input) {
  const t = toHalf(String(input === undefined || input === null ? '' : input)).trim();
  if (!t) return [];
  /* 长文本（解析）里翻字母太容易误判，只在 24 字以内做多选识别 */
  if (t.length <= 24) {
    /* 去掉连接词与分隔符后，若剩下的全是 A–H，那就是多选题答案，如
       "AC" / "A、C" / "A和C" / "A, C" / "答案：AC" */
    const compact = t.replace(/^(?:答案|answer|选|应选|故选|correct|是|为)\s*[:：]?\s*/i, '')
      .replace(/[\s、,，.。:：;；和与及/\\|]+/g, '');
    if (compact.length >= 1 && compact.length <= 8 && /^[A-H]+$/.test(compact)) {
      return compact.split('').filter(function (v, i, a) { return a.indexOf(v) === i; }).sort();
    }
  }
  const single = letterOfAnswer(t);
  return single ? [single] : [];
}

/** 综合判断：是不是选择题、选项有哪些、答案是哪个字母 */
function choiceInfo(text, answer) {
  const options = optionsOf(text);
  const isChoice = options.length >= 2;
  const letter = letterOfAnswer(answer || '');
  return {
    isChoice: isChoice,
    options: options,
    answerLetter: isChoice && letter && options.indexOf(letter) >= 0 ? letter : ''
  };
}

/* 把答案包装成"可点选"的信息；给主进程用。
   letters 是权威字段（多选题会有多个），answerLetter 只在单选时才有意义。 */
function resolveChoice(question, answer) {
  const options = optionsOf(question);
  const isChoice = options.length >= 2;
  const letters = isChoice
    ? lettersOfAnswer(answer).filter(function (L) { return options.indexOf(L) >= 0; })
    : [];
  return {
    isChoice: isChoice,
    options: options,
    letters: letters,
    answerLetter: letters.length === 1 ? letters[0] : '',
    clickable: !!(isChoice && letters.length),
    /* 点不了的原因是"信息不足"，要说清楚，方便界面提示 */
    why: !isChoice
      ? '题目里没有识别到 A/B/C/D 选项'
      : (!letters.length ? '答案里没有明确的选项字母（需要形如"答案：A"，或在题目里带上选项）' : '')
  };
}

/** 给 AI 用的学科提示词补充；低置信度时退回通用版 */
function aiHint(subjectId, confidence) {
  if (confidence !== undefined && confidence < 0.35) return AI_HINTS.general;
  return AI_HINTS[subjectId] || AI_HINTS.general;
}

/** 检索式上挂的学科词（题库站常按学科分类，带上能提命中率） */
function searchTag(subjectId) {
  return AI_HINTS[subjectId] ? SUBJECTS.find(function (s) { return s.id === subjectId; }) || null : null;
}

module.exports = {
  detect, optionsOf, letterOfAnswer, lettersOfAnswer, choiceInfo, resolveChoice,
  aiHint, searchTag, toHalf, SUBJECTS, GENERAL, AI_HINTS
};
