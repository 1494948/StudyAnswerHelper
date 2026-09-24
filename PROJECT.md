# PROJECT.md — 学习通答题助手（StudyAnswerHelper）

> 本项目的 AI 工作卡。**任何 AI 会话接手本项目，先读这里，再动代码。**
> 规范见 `C:\AI Document\AGENTS.md`。

## 1. 定位

Windows 桌面工具。两件事：

1. **输入答案** —— 左边一个大输入框写答案，切到学习通（超星）窗口后按一个热键，
   程序用**模拟键盘输入**（SendInput）把答案逐字打进答题框，绕过学习通禁止复制粘贴的限制。
2. **搜答案**（v1.1.0 新增）—— 把题目贴进来，三路答案来源并发检索：
   本地题库（离线）/ 网络检索（搜狗 → 360 → 必应）/ AI 解答（OpenAI 兼容接口），
   结果按相关度排序，一键填进大框，再走上面那条输入链路。

| 项 | 值 |
|---|---|
| 中文名 / 产品名 | 学习通答题助手 |
| 目录名 | `projects/StudyAnswerHelper`（与 GitHub 仓库名逐字一致） |
| 状态 | **可用** — v1.1.0 已打包验证 |
| 最后更新 | 2026-09-24 |

## 2. 技术栈

| 项 | 值 |
|---|---|
| 运行时 | Electron **32.3.3** |
| 原生调用 | koffi **^3.3.1**（SendInput / 全局热键 / 读前台窗口） |
| 打包 | electron-builder **^26.15.3** |
| 持久化 | 自研 JSON Store（`src/main/lib/store.js`）+ 自研题库（`src/main/lib/answer-bank.js`），零第三方依赖 |
| 联网 | 自研 HTTP 客户端（`src/main/lib/http.js`），基于 Node 内置 `http/https/zlib` |
| HTML 解析 | 自研正则 + 实体解码（`src/main/lib/html.js`），不引 DOM 库 |
| 界面 | 原生 HTML / CSS / JS，无框架、无 CDN、完全离线 |
| 运行时依赖总数 | **2 个**（`electron` + `koffi`），其余全是自研 |

## 3. 常用命令

```bash
cd C:\AI Document\projects\StudyAnswerHelper

npm start          # 开发态启动
npm start:safe     # 受限环境启动（渲染进程被杀时用这个）
npm run icons      # 重新生成图标

npm run build      # 打包（输出目录见 package.json 的 build.directories.output）
npm run build:dir  # 只生成 win-unpacked，不生成安装包
```

打包时**显式指定一个新的输出目录**，否则会被本环境的删除钩子拦下：

```bash
node node_modules/electron-builder/out/cli/cli.js --win --x64 --config.directories.output=dist-installer-v5
```

## 4. 发布信息

| 项 | 值 |
|---|---|
| GitHub 仓库 | https://github.com/1494948/StudyAnswerHelper |
| 分支 | `main` |
| 当前版本 | v1.1.0 |
| appId | `com.xu.studyanswerhelper` |
| 安装包命名 | `StudyAnswerHelper-Setup-<版本>.exe`（NSIS，中文安装界面） |
| 便携版命名 | `StudyAnswerHelper-Portable-<版本>.exe` |
| 归档位置 | `C:\AI Document\releases\StudyAnswerHelper\v<版本>\` |
| 发布说明 | 归档目录下的 `发布说明-复制到GitHub.txt`，内容可直接贴到 GitHub Release 页面 |

- 产物约 75 MB／个。GitHub 单文件 >100 MB 会被拒绝，**禁止提交进仓库**。
- `.gitignore` 已排除 `node_modules/`、`dist-installer*/`、`release/`、`_*.txt`。
- 需要发布 Release 时：tag 用 `git push` 推（走 git 协议，认证是通的），
  附件由用户在网页拖拽上传，不要把账号凭据交给脚本。

## 5. 目录结构

```
StudyAnswerHelper/
├── src/
│   ├── main/
│   │   ├── main.js                 # 窗口 / 托盘 / IPC / 生命周期 / 搜答案编排
│   │   ├── preload.js              # contextBridge 白名单 API
│   │   ├── engine/input-engine.js  # 键盘注入引擎（被 fork，必须 asarUnpack）
│   │   └── lib/
│   │       ├── store.js            # JSON 持久化（草稿/队列/历史/设置）
│   │       ├── http.js             # 零依赖 HTTP（重定向/超时/gzip/大小上限）
│   │       ├── html.js             # HTML 实体解码 / 去标签 / 属性提取
│   │       ├── textsim.js          # 题目归一化 / 相似度 / 检索式构造 / 答案抽取
│   │       ├── answer-bank.js      # 本地题库（匹配 / 增删 / 批量导入导出）
│   │       └── answer-search.js    # 三源检索编排 + 搜狗/360/必应解析 + AI 客户端
│   └── renderer/
│       ├── index.html              # 4 个标签页 + 题库弹窗
│       ├── css/app.css
│       └── js/app.js
├── tools/
│   ├── make-icons.js               # 纯 Node 生成 PNG/ICO
│   ├── probe-koffi.js              # koffi / FFI 假设验证探针
│   └── selftest-script.js          # 注入渲染进程的自检脚本（SP_SELFTEST，32 项）
├── assets/                         # icon.ico / tray.ico / png
├── preview/                        # 界面截图（含 dark/ 深色版）— 进仓库
├── release/                        # 交付目录 — gitignore
└── dist-installer-vN/              # electron-builder 输出 — gitignore，可整目录删
```

**界面结构**：左侧主区（前台窗口条 + 答案大框 + 工具栏 + 输入按钮 + 自动模式开关），
右侧侧栏 400px，4 个标签页：`答案队列` / `搜答案` / `历史` / `设置`；
题库管理是独立弹窗（`#bankModal`），不在标签页里。

## 6. 已知的坑（本机实测，别重复踩）

### 6.1 输入引擎相关

1. **`ELECTRON_RUN_AS_NODE` 必须清除。** 本机 shell 预设了该变量，不清除时 electron.exe 会以纯 Node
   模式启动，报 `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`。
2. **受限环境要加沙箱参数。** 否则渲染进程被杀（`render-process-gone {"reason":"killed"}`）。
   用 `npm run start:safe`，参数 `--no-sandbox --disable-gpu --disable-software-rasterizer`。
3. **`EBUSY: app.asar 正由另一进程使用`。** 构建前先结束残留进程：
   `taskkill //F //IM electron.exe //T`。
4. **asarUnpack 三件套。** 原生模块（`koffi`、`@koromix/**`）、被 `fork` 的 `src/main/engine/**`、
   `assets/**` 都必须解包，否则打包版启动即崩。取路径用 `unpackAware()`。
   > `src/main/lib/**` **不需要**解包 —— 它们只被 `require`，不原生、不 fork，`require` 能直接读 asar。
5. **koffi 返回的句柄是 bigint。** 直接丢进 `process.send` 会因 `JSON.stringify(BigInt)` 抛异常；
   若发送处写了空 `catch`，消息会**静默消失**。读取处统一 `Number()`，发送处做 JSON 安全兜底。
6. **托盘常驻会抢走单实例锁。** 测试模式必须在 `app.requestSingleInstanceLock()` **之前**
   把 `userData` 切到临时目录。
7. **常驻托盘要关后台节流。** `webPreferences: { backgroundThrottling: false }`，
   否则窗口被遮挡时定时器降频到约 1 秒。自检里"等落盘"的断言一律用**轮询等待**。
8. **管理员窗口收不到按键（UIPI）。** Windows 安全模型，不是 bug。

### 6.2 搜答案相关（v1.1.0 新增，都是实测踩出来的）

9. **`a+b=3` 和 `a-b=3` 会被文本相似度判成同一道题。**
   实测 bigram Dice = 0.867、数字序列完全一致，加权怎么调都压不到阈值以下（约 0.68）。
   解法见 `textsim.js` 里的 `criticalMinorDiff()`：归一化后长度相同、差异仅 1~2 字符、
   且差异落在运算符/数字上 → 直接判为不同题（分数压到 0.3）。
   **改动相似度逻辑后，务必回归 `tools/` 之外的那组用例（见第 8 节）。**
10. **归一化不能删标点。** `+ - = . / ( ) ² √ π` 在数学题里都是有效信息，
    按普通文本预处理删掉标点会把 `a+b=3` 与 `a-b=3` 压成同一个串。
11. **网页摘要不能整段比对。** 题干十几字、摘要三四百字，整段比会被摊薄到 0.2 左右。
    `webScore()` 分别对"标题""摘要前 140 字""整段"各算一次取最大值。
12. **搜狗会弹人机验证页且 Cookie 预热无效。** 实测：取首页 Cookie 再检索，仍然拿到
    `antispider.min.js` 页面。判定方式是页面里出现 `antispider` / `verify.css` / `g-recaptcha`
    等特征（`looksBlocked()`）。对策是**三引擎依次降级 + 该引擎冷却 3 分钟**，
    而不是重试。搜狗最快被限流，360 最抗压（且结果页带 `data-mdurl` 真实地址，不必解跳转），
    必应对中文数学题基本无效（只留作最后兜底）。**这两个引擎都不能删。**
13. **两个引擎的 HTML 结构差异大且会变。** 搜狗：`<div class="vrwrap">` 分块，标题在 `h3`，
    摘要取 `.text-layout`/`.fz-mid`，真实地址在尾部 `data-url`。360：`<li class="res-list">` 分块，
    标题在 `h3.res-title`，真实地址在 `a[data-mdurl]`，摘要取 `p.res-desc` 或
    `span.res-list-summary`。解析失败一律安静降级成"没有解析到结果"，**不要让异常冒到界面**。
14. **360 结果流里夹着"其他人还搜了"这类相关搜索块**，没有真实链接。
    `parse360()` 里要求必须有 URL 才收，并显式过滤标题以"其他人还搜/相关搜索/大家还在搜"开头的块。
15. **从网页摘要抽答案会抽出文档碎片**（实测抽出过"向左平移个单位长度 4.(2009年高考辽宁卷改编)…"）。
    `plausibleTextAnswer()` 做结构校验：长度 ≤ 30、不含句号分号、不含 `4.(2009` 类题号、
    不含年份、不含半截括号。另外 `kind = 'answer'` 还要求相关度 ≥ 0.25（`WEB_ANSWER_MIN_SCORE`），
    否则降级成线索 —— 不给它"填入大框"按钮。
16. **搜题热键触发时主窗口必须在前面。** 热键回调里先 `showMain()`，再 `setTimeout(180ms)`
    去读剪贴板并检索，否则界面还在后台、用户看不到结果。
17. **AI Key 不能推给渲染层。** `publicSettings()` 删掉 `aiApiKey`，只暴露 `aiKeySet` 与
    `aiKeyHint`（尾号）。自检里有一条专门断言守着（往状态里塞一个明文 Key，断言
    `JSON.stringify(state)` 里不含它）。**改 `publicState()` 时别把这条破坏掉。**
18. **AI 接口一律走 OpenAI 兼容 `/chat/completions`。** 未配置 Key、地址非法、主机不存在、
    密钥被拒，四种情况都要返回友好文案而不是抛异常（实测四种都覆盖了）。

### 6.3 工程相关

19. **搬动项目目录用 `robocopy /MIR`，不要用 `shutil.move`**（本环境删除钩子会拦下删除环节）。
20. **不要对同一个文件并行发多个 Edit** —— 本环境会出现"每条都报成功、但改动互相覆盖丢失"，
    批量改同一文件要串行或整体重写，改完落盘核对。
21. **截图模式不要用真实数据。** 早期 `SP_SHOT` 会复制真实 `answer-data.json` 来生成 `preview/`
    截图，会把用户的答案内容截进**要提交进仓库**的 PNG 里。现在改成 `seedShotData()` 现造演示数据，
    所有测试模式启动时都清空两个数据文件。

更完整的坑清单与自动化验证方案见技能 `electron-desktop-app`。

## 7. 自检与验证（改代码后必跑）

```bash
set SP_SELFTEST=1 && npm start       # 交互级自检 32 项（离线可复现）
set SP_SMOKE=1 && npm start          # 真实键盘注入冒烟
set SP_SHOT=1 && npm start           # 视觉走查截图（5 个页面 × 2 套主题）
set SP_SEARCHTEST=1 && npm start     # 真实联网检索链路（需要网络，结果只写日志）
```

`SP_SEARCHTEST` 支持环境变量覆盖：`SP_SEARCH_Q` / `SP_SEARCH_ENGINE` / `SP_AI_KEY` /
`SP_AI_BASE` / `SP_AI_MODEL`。

**注意**：`SP_SELFTEST` **必须离线可复现**，不要在自检里加任何联网断言。

**打包后也要对 `win-unpacked\学习通答题助手.exe` 和便携版各跑一遍**
`SP_SELFTEST` / `SP_SMOKE` / `SP_SEARCHTEST`，确认 asar 封装没破坏相对路径。

v1.1.0 验证结果（开发态与两个打包产物各跑一遍，结果一致）：

```
SP_SELFTEST   32 项通过 / 0 项失败 / 0 个渲染层 JS 错误
SP_SMOKE       5 项通过 / 0 项失败，键盘注入 21 字逐字一致（450 ms）
SP_SEARCHTEST  本地题库命中 1.000 并自动填入大框；搜狗 9 条线索，头名相关度 0.905
               全程 900 ms（开发态 747 ms）；状态里无 API Key 泄漏
```

**相似度回归用例（改 `textsim.js` 后必须手工跑一遍）**——这些是离线纯函数，
可以直接写临时脚本 `require` 验证，不用起 Electron：

| 题目 A | 题目 B | 期望 |
|---|---|---|
| `已知a+b=3，ab=2，则a²+b²的值为（  ）` | `已知a+b=3,ab=2,则a²+b²的值为（）` | `= 1.0`（全半角/标点差异视为同题） |
| `已知a+b=3，ab=2，则a²+b²的值为` | `已知a-b=3，ab=2，则a²+b²的值为` | `< 0.55`（**只差一个符号必须不同题**） |
| `函数f(x)=x²-2x+3在区间[0,3]上的最大值是` | 同题但区间 `[1,4]` | `< 0.55` |
| `求圆的面积，半径r=5，π取3.14` | `完全不同的题目：求三角形周长` | `< 0.3` |

## 8. 变更记录

| 日期 | 变更 | 说明 |
|---|---|---|
| 2026-09-22 | 项目从 `2026-09-21-23-21-04\StudyAnswerHelper\` 迁移到 `projects\StudyAnswerHelper\` | 纳入 AI Document 目录规范。迁移后逐字节校验一致（8186 文件 / 955,452,999 B），`git status` 干净，HEAD 仍为 `3348149`，远端配置未变。未改动任何源码 |
| 2026-09-22 | 建立本文件 PROJECT.md | 补齐 AI 工作卡，记录本机环境坑 |
| 2026-09-22 | 分发包归档至 `releases\StudyAnswerHelper\v1.0.0\` | 安装包 + 便携版 + 使用说明 + 发布说明 |
| 2026-09-23 | 删除项目内重复的 4 个 exe（`release\` 与 `dist-installer-v3\`） | 执行规范「分发包只保留 `releases/` 一份」。删除前已逐一比对 MD5，三处副本完全一致；保留的 `releases\StudyAnswerHelper\v1.0.0\` 归档完整。释放 301.0 MB，工作台 804.8 MB → 503.7 MB |
| 2026-09-24 | **v1.1.0：新增「搜答案」功能** | 新增 5 个主进程库（http / html / textsim / answer-bank / answer-search，全零依赖）+ 侧栏第 4 个标签页 + 题库管理弹窗 + 设置页两个分组；新增搜题热键 `Ctrl+Alt+F`（剪贴板取题）。三路答案来源并发：本地题库（离线模糊匹配）/ 网络检索（搜狗→360→必应，自动降级与冷却）/ AI 解答（OpenAI 兼容）。AI 密钥只留主进程。侧栏 344→400px，窗口 1000×700→1100×720 |
| 2026-09-24 | 修正相似度算法的危险误判 | 只差一个运算符的题目（`a+b=3` vs `a-b=3`）原被判为 0.92 高相似，会串题。引入运算符特征 + `criticalMinorDiff()` 硬否决规则，实测降到 0.3。加了 8 条回归用例 |
| 2026-09-24 | 修正 `SP_SHOT` 会把用户真实答案截进公开截图 | 改为 `seedShotData()` 现造演示数据；所有测试模式启动时清空数据文件，保证自检可复现 |
| 2026-09-24 | 打包并归档 v1.1.0 | 输出目录 `dist-installer-v4`，构建退出码 0（未触发删除钩子）。产物归档到 `releases\StudyAnswerHelper\v1.1.0\`（MD5 与构建目录逐一比对一致）。开发态与两个打包产物各自跑过 SP_SELFTEST 32/0、SP_SMOKE 5/0、SP_SEARCHTEST 通过 |
