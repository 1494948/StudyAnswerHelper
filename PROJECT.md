# PROJECT.md — 学习通答题助手（StudyAnswerHelper）

> 本项目的 AI 工作卡。**任何 AI 会话接手本项目，先读这里，再动代码。**
> 规范见 `C:\AI Document\AGENTS.md`。

## 1. 定位

Windows 桌面工具。左边一个大输入框写答案，切到学习通（超星）窗口后按一个热键，
程序用**模拟键盘输入**（SendInput）把答案逐字打进答题框——绕过学习通禁止复制粘贴的限制。

| 项 | 值 |
|---|---|
| 中文名 / 产品名 | 学习通答题助手 |
| 目录名 | `projects/StudyAnswerHelper`（与 GitHub 仓库名逐字一致） |
| 状态 | **可用** — v1.0.0 已发布 |
| 最后更新 | 2026-09-22 |

## 2. 技术栈

| 项 | 值 |
|---|---|
| 运行时 | Electron **32.3.3** |
| 原生调用 | koffi **^3.3.1**（SendInput / 全局热键 / 读前台窗口） |
| 打包 | electron-builder **^26.15.3** |
| 持久化 | 自研 JSON Store（`src/main/lib/store.js`），零第三方依赖 |
| 界面 | 原生 HTML / CSS / JS，无框架、无 CDN、完全离线 |

## 3. 常用命令

```bash
cd C:\AI Document\projects\StudyAnswerHelper

npm start          # 开发态启动
npm start:safe     # 受限环境启动（渲染进程被杀时用这个）
npm run icons      # 重新生成图标

npm run build      # 打包（先读第 6 节第 3 条：必须换新输出目录）
npm run build:dir  # 只生成 win-unpacked，不生成安装包
```

打包时**显式指定一个新的输出目录**，否则会被本环境的删除钩子拦下：

```powershell
node node_modules\electron-builder\out\cli\cli.js --win nsis --x64 --config.directories.output=dist-installer-v4
```

## 4. 发布信息

| 项 | 值 |
|---|---|
| GitHub 仓库 | https://github.com/1494948/StudyAnswerHelper |
| 分支 | `main` |
| 当前版本 | v1.0.0（tag 已推送到远端） |
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
│   │   ├── main.js                 # 窗口 / 托盘 / IPC / 生命周期
│   │   ├── preload.js              # contextBridge 白名单 API
│   │   ├── engine/input-engine.js  # 键盘注入引擎（被 fork，必须 asarUnpack）
│   │   └── lib/store.js            # JSON 持久化
│   └── renderer/
│       ├── index.html
│       ├── css/app.css
│       └── js/app.js
├── tools/
│   ├── make-icons.js               # 纯 Node 生成 PNG/ICO
│   ├── probe-koffi.js              # koffi / FFI 假设验证探针
│   └── selftest-script.js          # 注入渲染进程的自检脚本（SP_SELFTEST）
├── assets/                         # icon.ico / tray.ico / png
├── preview/                        # 界面截图（含 dark/ 深色版）
├── release/                        # 交付目录（构建后把 exe 放这里）— gitignore
└── dist-installer-vN/              # electron-builder 输出 — gitignore，可整目录删
```

## 6. 已知的坑（本机实测，别重复踩）

1. **`ELECTRON_RUN_AS_NODE` 必须清除。** 本机 shell 预设了该变量，不清除时 electron.exe 会以纯 Node
   模式启动，报 `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`。
   ```powershell
   Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
   ```
2. **受限环境要加沙箱参数。** 否则渲染进程被杀（`render-process-gone {"reason":"killed"}`）。
   用 `npm run start:safe`，参数 `--no-sandbox --disable-gpu --disable-software-rasterizer`。
3. **打包必须换新输出目录。** 本环境的删除钩子会拦截 electron-builder 清理旧 `win-unpacked`
   （报 `[safe-delete] ... trash operation`）。收尾阶段也可能报失败，**但产物已生成**——
   判据是产物是否存在且有效，不是退出码。检查方法：读前两字节是否为 `MZ`，且含 `Nullsoft` 字样。
4. **`EBUSY: app.asar 正由另一进程使用`。** 上一次运行的进程没退干净。构建前先结束残留进程：
   `Get-Process -Name "学习通答题助手","electron" | Stop-Process -Force`。
5. **asarUnpack 三件套。** 原生模块（`koffi`、`@koromix/**`）、被 `fork` 的 `src/main/engine/**`、
   `assets/**` 都必须解包，否则打包版启动即崩。取路径用 `unpackAware()` 把 `app.asar` 换成
   `app.asar.unpacked`；`fork` 的 `cwd` 用 `path.dirname(scriptPath)`。
6. **koffi 返回的句柄是 bigint。** 直接丢进 `process.send` 会因 `JSON.stringify(BigInt)` 抛异常；
   若发送处写了空 `catch`，消息会**静默消失**（症状：前台窗口永远读不到、调用方卡到超时）。
   读取处统一 `Number()` 归一化，发送处做 JSON 安全兜底，绝不静默吞异常。
7. **托盘常驻会抢走单实例锁。** 测试模式必须在 `app.requestSingleInstanceLock()` **之前**
   把 `userData` 切到临时目录，否则测试实例一启动就退出，日志只有一行。
8. **常驻托盘要关后台节流。** `webPreferences: { backgroundThrottling: false }`，
   否则窗口被遮挡时定时器降频到约 1 秒，倒计时跳字卡顿、落盘变慢，
   自检里"等落盘"的断言会假失败——改成轮询等待。
9. **管理员窗口收不到按键（UIPI）。** 普通权限进程无法向以管理员身份运行的窗口注入按键。
   这是 Windows 安全模型，不是 bug。使用说明里已写明"请以管理员身份运行"。
10. **搬动项目目录用 `robocopy /MIR`，不要用 `shutil.move`。** 本环境 `shutil.move` 的删除环节会被
    回收站钩子拦下，结果是"源和目标各一份、目标可能不完整"。2026-09-22 迁移时踩过一次。

更完整的坑清单与自动化验证方案见技能 `electron-desktop-app`。

## 7. 自检与验证（改代码后必跑）

```bash
set SP_SELFTEST=1 && npm start   # 交互级自检：每个视图渲染、表单落盘、命中测试、0 JS 错误
set SP_SMOKE=1 && npm start      # 冒烟 + 命中测试探针
set SP_SHOT=1 && npm start       # 视觉走查截图
```

**打包后也要对 `win-unpacked\<名字>.exe` 和便携版各跑一遍**，确认 asar 封装没破坏相对路径。

v1.0.0 的验证结果：`SP_SELFTEST` 20 项通过 / 0 失败 / 0 个渲染层 JS 错误；
`SP_SMOKE` 5 项通过，真实键盘注入 21 字逐字一致（开发态与打包后的 exe 各跑一遍）。

另外注意**不要对同一个文件并行发多个 Edit**——本环境会出现"每条都报成功、但改动互相覆盖丢失"，
批量改同一文件要串行或整体重写，改完落盘核对。

## 8. 变更记录

| 日期 | 变更 | 说明 |
|---|---|---|
| 2026-09-22 | 项目从 `2026-09-21-23-21-04\StudyAnswerHelper\` 迁移到 `projects\StudyAnswerHelper\` | 纳入 AI Document 目录规范。迁移后逐字节校验一致（8186 文件 / 955,452,999 B），`git status` 干净，HEAD 仍为 `3348149`，远端配置未变。未改动任何源码 |
| 2026-09-22 | 建立本文件 PROJECT.md | 补齐 AI 工作卡，记录本机环境坑 |
| 2026-09-22 | 分发包归档至 `releases\StudyAnswerHelper\v1.0.0\` | 安装包 + 便携版 + 使用说明 + 发布说明 |
