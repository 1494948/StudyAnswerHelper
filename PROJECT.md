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
node tools/make-question-image.js   # 生成示例题目图（assets/sample-question.png）

npm run build      # 打包（输出目录见 package.json 的 build.directories.output）
npm run build:dir  # 只生成 win-unpacked，不生成安装包
```

打包时**显式指定一个新的输出目录**，否则会被本环境的删除钩子拦下：

```bash
node node_modules/electron-builder/out/cli/cli.js --win --x64 --config.directories.output=dist-installer-v5
```

**本机打包必须带 `NODE_TLS_REJECT_UNAUTHORIZED=0`**（踩坑记录见 6.4-7）：

```bash
env -u ELECTRON_RUN_AS_NODE NODE_TLS_REJECT_UNAUTHORIZED=0 \
  ./node_modules/.bin/electron-builder --win
```

只跑 `--dir` 时不需要 winCodeSign，所以历史上 `dist-installer-v1~v4` 里**只有 `win-unpacked`、没有安装包**。
要真正产出 Setup/Portable，第一次必须让 winCodeSign 下载成功（约 2.5 MB，落到
`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign`），之后离线也能打。

## 4. 发布信息

| 项 | 值 |
|---|---|
| GitHub 仓库 | https://github.com/1494948/StudyAnswerHelper |
| 分支 | `main` |
| 当前版本 | v1.2.0 |
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
│   │   ├── main.js                 # 窗口 / 托盘 / IPC / 生命周期 / 搜答案 + 识别编排
│   │   ├── preload.js              # contextBridge 白名单 API
│   │   ├── preload-capture.js      # 截图遮罩窗口专用 preload
│   │   ├── engine/input-engine.js  # 键盘注入引擎（被 fork，必须 asarUnpack）
│   │   └── lib/
│   │       ├── store.js            # JSON 持久化（草稿/队列/历史/设置）
│   │       ├── http.js             # 零依赖 HTTP（重定向/超时/gzip/大小上限）
│   │       ├── html.js             # HTML 实体解码 / 去标签 / 属性提取
│   │       ├── textsim.js          # 题目归一化 / 相似度 / 检索式构造 / 答案抽取
│   │       ├── answer-bank.js      # 本地题库（匹配 / 增删 / 批量导入导出）
│   │       ├── answer-search.js    # 三源检索编排 + 搜狗/360/必应解析 + AI 客户端
│   │       ├── ocr.js              # 识别编排：AI 视觉（主备双模型）+ 系统 OCR 兜底
│   │       └── ocr-win.ps1         # WinRT Windows.Media.Ocr 的 PowerShell 桥（asarUnpack）
│   └── renderer/
│       ├── index.html              # 4 个标签页 + 题库弹窗
│       ├── capture.html            # 全屏框选截图遮罩
│       ├── css/app.css
│       ├── css/capture.css
│       └── js/
│           ├── app.js
│           └── capture.js
├── tools/
│   ├── make-icons.js               # 纯 Node 生成 PNG/ICO
│   ├── make-question-image.js      # 纯 Node 生成"像照片"的示例题目图（离线测识别）
│   ├── probe-koffi.js              # koffi / FFI 假设验证探针
│   └── selftest-script.js          # 注入渲染进程的自检脚本（SP_SELFTEST，39 项）
├── assets/                         # icon.ico / tray.ico / png / sample-question.png
├── preview/                        # 界面截图（含 dark/ 深色版）— 进仓库
├── release/                        # 交付目录 — gitignore
└── dist-installer-vN/              # electron-builder 输出 — gitignore，可整目录删
```

**界面结构**：左侧主区（前台窗口条 + 答案大框 + 工具栏 + 输入按钮 + 自动模式开关），
右侧侧栏 400px，4 个标签页：`答案队列` / `搜答案` / `历史` / `设置`；
题库管理是独立弹窗（`#bankModal`），不在标签页里。
v1.2.0 起「搜答案」页顶部是**识别条**：`截图选题` 主按钮 + `重新识别` / `修正题目`，
下面是**只读**题目框（内容只能来自识别，不再支持手动键入）。

截图遮罩是**独立 BrowserWindow**（无边框、`setAlwaysOnTop(true,'screen-saver')`），
不是主窗口里的一个层——所以它有自己的一套 html/css/js/preload，四个文件都别漏。

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

### 6.4 图片识别与框选截图相关（v1.2.0 新增，全是实测踩出来的）

22. **系统自带 OCR 认不出数学公式，只能当兜底。** 拿 `assets/sample-question.png` 实测，
    WinRT OCR 把 `a²` 认成 `a2`、把 `3²` 认成 `32`、把减号 `−` 认成汉字 `一`，
    还整行丢掉了 `A.3 B.4` 那一行。用这种文本去搜题必然搜不到。
    所以 `ocrEngine` 默认 `ai`，界面在系统 OCR 结果上**必须**挂 `ocrQualityWarn()` 的黄色警告，
    否则用户会以为"识别成功了"。
23. **PowerShell 5.1 不能对 WinRT 的 `IAsyncOperation` 用 `.GetAwaiter()`**，
    报 `无法对 System.__ComObject 调用方法`。必须用 `AsTask` 反射桥接。
    另外 `IAsyncOperation\`1` 里的反引号在**双引号字符串**里是转义符，会被吃掉，
    要用单引号字符串。这两点都写在 `ocr-win.ps1` 的注释里了。
24. **WinRT 的文件 API 不认正斜杠。** `StorageFile.GetFileFromPathAsync` 传
    `C:/a/b.png` 报"指定的路径无效"，必须 `$Image.Replace('/','\')`。
25. **`$res.Lines` 直接读 `.Count` 会得到空值**（PowerShell 对 WinRT 集合不展开），
    要写 `@($res.Lines).Count`。`RecognizedLanguage` 也可能为空，得留 `$usedTag` 兜底。
26. **遮罩窗口会被"工作区"限制住。** 无边框窗口默认高度是屏幕减去任务栏（实测 1920×1040，
    而屏幕是 1920×1080）。这会让底图被 CSS 拉伸，于是**用户框的位置和实际截到的内容错位**
    （早期实测：框住题目，识别出的是任务栏的日期）。
    两道保险：① 底图 `#bg` 按屏幕真实像素 **1:1** 摆，绝不用百分比/CSS 拉伸；
    ② `show()` 之后再 `setBounds()` 强行铺满整屏边界。
27. **`desktopCapturer` 的缩略图尺寸要在 `thumbnailSize` 里显式给屏幕尺寸**，
    否则拿到的可能不是 1:1；裁剪时按 `kx = thumb.width / display.bounds.width` 换算，
    不要假设恒等于 1（多屏/缩放下会变）。
28. **裁剪内容要比对像素，但只能在"不放大"的前提下比。**
    `ocrUpscale > 1` 时用的是高质量插值，放大图每个像素都是邻域混合值，
    逐字节比对必然差几个色阶（实测 `[64,55,54]` vs `[70,60,59]`）。
    `SP_CAPTURETEST` 里把 `ocrUpscale` 置 1 再比 16×16，才是"框哪裁哪"的硬证明。
29. **`captureCtx` 在识别收尾时会被置 `null`。** 自检里如果在那之后再读
    `captureCtx.full`，会抛 `Cannot read properties of null`，被空 `catch` 吞掉后
    表现为"校验字段莫名消失"（实测 `cropPixelMatch: undefined`）。**进入流程前先快照引用。**
30. **`document.activeElement` 在窗口没有系统焦点时不可靠。** 状态推送回来时它可能是
    `body`，于是"用户正在输入的关键词"被判成"没在编辑"，直接被覆盖清空。
    统一改用 `syncTextInput(el, value, norm)` + `el.dataset.dirty` 脏标记。
31. **`$` 是 `getElementById`，不是 `querySelector`。** 回调里传 `'#ocrModelInp'` 会静默返回
    `null`，然后在 `.addEventListener` 上抛 `Cannot read properties of null`。
    `onTextChange()` 现在自己兼容两种写法。
32. **本地 electron 会拒绝对 `--disable-gpu` 这类开关参数做文件名。**
    `tools/make-question-image.js` 早期用 `argv[argv.length-1]` 当输出路径，
    结果生成了一个名叫 `--disable-gpu` 的 28 KB PNG。取参数要过滤掉 `-` 开头的开关。

### 6.5 打包相关（v1.2.0 新增）

33. **本机直连 GitHub 会 SSL 失败（`unable to verify the first certificate`）。**
    本环境有 HTTPS 代理（`https_proxy=http://127.0.0.1:14068`）做了 TLS 中间人。
    `curl` 加 `-k` 能正常下载，说明内容完好、只是证书链不被信任。
    所以 `electron-builder` 下载 winCodeSign 时必须带 `NODE_TLS_REJECT_UNAUTHORIZED=0`。
34. **`--dir` 不会下载 winCodeSign，`--win` 才会。** 所以 `dist-installer-v1~v4` 里
    只有 `win-unpacked`，从没真正产出过安装包。首次真正打包需要联网下载
    winCodeSign（约 2.5 MB），落到 `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign` 后可离线复用。

更完整的坑清单与自动化验证方案见技能 `electron-desktop-app`。

## 7. 自检与验证（改代码后必跑）

```bash
set SP_SELFTEST=1 && npm start       # 交互级自检 39 项（离线可复现）
set SP_SMOKE=1 && npm start          # 真实键盘注入冒烟
set SP_SHOT=1 && npm start           # 视觉走查截图（6 个页面 × 2 套主题）
set SP_SEARCHTEST=1 && npm start     # 真实联网检索链路（需要网络，结果只写日志）
set SP_CAPTURETEST=1 && npm start    # 真实「框选截图 → 裁剪 → 识别」链路（本机会真开遮罩窗口）
node tools/make-question-image.js    # 先造一张示例题目图，给 ocr:test 用
```

`SP_SEARCHTEST` 支持环境变量覆盖：`SP_SEARCH_Q` / `SP_SEARCH_ENGINE` / `SP_AI_KEY` /
`SP_AI_BASE` / `SP_AI_MODEL`。
`SP_CAPTURETEST` 加 `SP_CAPTURE_KEEP=<路径>.png` 会把"遮罩画面"和"裁剪结果"各存一份，
用来人工核对"框的位置 vs 裁到的内容"。

**注意**：`SP_SELFTEST` **必须离线可复现**，不要在自检里加任何联网断言；
**也不要在自检里点 `截图选题`**（会弹出全屏遮罩把后续断言全毁掉），
自动输入浮层只能通过 `App.previewAutoInput()` 走演示路径。

**打包后也要对 `win-unpacked\学习通答题助手.exe` 和便携版各跑一遍**
`SP_SELFTEST` / `SP_SMOKE` / `SP_SEARCHTEST`，确认 asar 封装没破坏相对路径
（识别链路特别依赖 `ocr-win.ps1` 能按相对路径读到，已进 `asarUnpack`）。

v1.1.0 验证结果（开发态与两个打包产物各跑一遍，结果一致）：

```
SP_SELFTEST   32 项通过 / 0 项失败 / 0 个渲染层 JS 错误
SP_SMOKE       5 项通过 / 0 项失败，键盘注入 21 字逐字一致（450 ms）
SP_SEARCHTEST  本地题库命中 1.000 并自动填入大框；搜狗 9 条线索，头名相关度 0.905
               全程 900 ms（开发态 747 ms）；状态里无 API Key 泄漏
```

v1.2.0 验证结果（开发态）：

```
SP_SELFTEST     39 项通过 / 0 项失败 / 0 个渲染层 JS 错误
SP_SMOKE         5 项通过 / 0 项失败，键盘注入 21 字逐字一致（459 ms）
SP_SHOT         6 个页面 × 2 套主题，含新增 main-autoinput.png
SP_CAPTURETEST  遮罩窗口 1920×1080（与屏幕一致）、底图 1:1 未被拉伸、
                裁剪尺寸 960×324 == 选区换算值、
                16×16 逐字节比对完全一致（cropPixelDiffAt = -1）、
                识别出 132 字并落盘（questionPersisted = true）、
                遮罩关闭、主窗口恢复
```

**坐标映射的自检要点**（这是本版最容易悄悄坏掉的地方）：
`SP_CAPTURETEST` 会在"关掉放大"的前提下，把裁剪图左上角 16×16 与整屏截图对应位置的
16×16 做逐字节比对。只要 DPI 换算、遮罩窗口尺寸、底图 CSS 尺寸任何一处错了，
这个断言立刻红。**改截图相关代码后必须重跑它。**

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
| 2026-09-24 | 清理垃圾文件（经用户确认，工作台 1.06 GB → 666.0 MB） | 释放 418 MB：① `cleanup.py --clean --aggressive` 清掉 Claw/ 与 v1~v4 的旧构建输出，释放 266.8 MB；② 手工删除 dist-installer-v4 下与 v1.1.0 归档 MD5 完全一致的 2 个 exe 副本 + 构建元数据，以及项目内 `release/` 下与 v1.0.0 归档 MD5 一致的 2 个旧 txt，释放 150.7 MB。**残留 4 个 `dist-installer-v*/win-unpacked` 空壳（含被进程占用的 app.asar，错误码 32）删不掉，重启后重跑 `cleanup.py` 即可** |
| 2026-09-24 | 推送 v1.1.0 到 GitHub | 先 `ls-remote` 探明远端 main 停在 `3348149`（本地领先 3 个提交，可快进，未强推）。推送 `main`（`3348149..3ca2260`）+ 注解标签 `v1.1.0`，实测无认证弹窗。推后核验：远端 `refs/heads/main` == 本地 HEAD == `3ca2260`，`refs/tags/v1.1.0^{}` == `3ca2260`，`git status -sb` 显示正常 upstream。仓库体积 527 KiB / 37 个跟踪文件（exe 未进仓库，走 Releases 附件） |
| 2026-09-24 | **v1.2.0：新增图片识别题目 + 框选截图 + 识别后自动输入** | 新增 `src/main/lib/ocr.js`（AI 视觉主备双模型 + 系统 OCR 兜底）与 `ocr-win.ps1`（WinRT `Windows.Media.Ocr` 的 PowerShell 桥，走 JSON 文件回传以绕开 GBK 控制台乱码）；新增全屏框选遮罩窗口（`capture.html` / `capture.css` / `capture.js` / `preload-capture.js`，独立 BrowserWindow）；新增截图热键 `Ctrl+Alt+X`、识别后 5 秒自动切窗输入（可调 3/5/8/12 秒、可整组关闭）；`tools/make-question-image.js` 生成离线测识别用的示例题目图 |
| 2026-09-24 | v1.2.0：**取消手动输入题目**，题目框改为只读 | 题目框内容只由识别产生，默认 `readonly`；点「修正题目」解锁、改完「保存修正」。同时删掉 `#qPasteBtn`/`#qClearBtn`/`#qUseDraftBtn` 与相关逻辑 |
| 2026-09-24 | 修掉截图坐标错位（本版最危险的一个 bug） | 无边框遮罩窗口默认被"工作区"限制成 1920×1040（屏幕是 1920×1080），底图被 CSS 拉伸 → 用户框住题目却截到任务栏。改为底图按屏幕真实像素 **1:1** 摆 + `show()` 后 `setBounds()` 强制铺满。新增 `SP_CAPTURETEST` 做 16×16 逐字节像素比对守住这条（实测 `cropPixelDiffAt = -1`） |
| 2026-09-24 | 修掉状态推送会清空用户正在输入的识别配置 | 根因是 `document.activeElement` 在窗口没有系统焦点时不可靠，被判成"没在编辑"后被覆盖。统一改用 `syncTextInput()` + `dataset.dirty` 脏标记（与 v1.1.0 同类问题，这次抽成了工具函数） |
| 2026-09-24 | 修掉退出时最后一次改动静默丢失 | `store` 是 160ms 合并延迟写盘，`app.on('before-quit')` 里没有强制 flush，导致"刚识别完就关掉"丢题目。已在退出钩子里补 `store.flush()` + 题库 flush |
| 2026-09-24 | 打包并归档 v1.2.0 | **首次真正产出安装包**：历史上 `--dir` 不下载 winCodeSign，所以 `dist-installer-v1~v4` 里只有 `win-unpacked`。本机代理做 TLS 中间人导致 `unable to verify the first certificate`，改用 `curl -k` 预取 winCodeSign-2.6.0.7z（sha256 与官方 `cdaec715…16743a4` 完全一致）放入缓存后，构建 1m40s 通过，退出码 0。产物 `dist-installer-v5`（Setup 79,057,649 B / Portable 78,922,985 B，均 MZ 头 + Nullsoft 特征），归档到 `releases\StudyAnswerHelper\v1.2.0\`（MD5 逐一比对一致）。开发态 + win-unpacked + 便携版三处各跑过 SP_SELFTEST 39/0、SP_SMOKE 5/0，win-unpacked 另跑通 SP_CAPTURETEST 全绿 |
| 2026-09-24 | 删除误生成的垃圾文件 `--disable-gpu` | 另一个模型在用 `make-question-image.js` 时把 electron 的开关参数当成了输出文件名，生成了一个 28,812 B 的 PNG。经用户确认删除；同时修掉 `make-question-image.js` 的 argv 解析（过滤 `-` 开头的开关） |
