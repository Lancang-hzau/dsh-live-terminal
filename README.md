# dsh-live-terminal

[DeepSeek Harness](https://deepseek.com)（DSH）的**可见终端面板**插件：把 agent 执行的 shell 命令放进应用内终端窗口里实时显示，允许 agent 对终端屏幕“截图”（文本 / ANSI / PNG），并提供一整套面向 agent 的终端控制工具。

Visible terminal panel for DeepSeek Harness: stream agent shell commands into an in-app terminal **live**, let the agent capture the screen (text, ANSI or PNG), and control terminals with a full `live_terminal_*` toolset.

[![npm](https://img.shields.io/npm/v/dsh-live-terminal)](https://www.npmjs.com/package/dsh-live-terminal)
[![license](https://img.shields.io/npm/l/dsh-live-terminal)](./LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.2-blue)](https://github.com/deepseek-ai/deepseek-harness)

![agent command panel](https://raw.githubusercontent.com/Lancang-hzau/dsh-live-terminal/HEAD/docs/screenshots/01-agent-command-panel.png)

![agent screenshot](https://raw.githubusercontent.com/Lancang-hzau/dsh-live-terminal/HEAD/docs/screenshots/02-screenshot.png)

![v1.2.1 compact panel with session strip, sandbox disclosure and status bar](https://raw.githubusercontent.com/Lancang-hzau/dsh-live-terminal/HEAD/docs/screenshots/05-v1.2.1-panel.png)

![v1.3.0 focus mode: a wide terminal overlay with 185 columns](https://raw.githubusercontent.com/Lancang-hzau/dsh-live-terminal/HEAD/docs/screenshots/06-focus-mode.png)

## v1.3.0 专注模式与窄栏可读性（2026-10-26）

- **专注模式（放大终端）**：侧栏太窄导致命令换行时，点 chrome 上的放大按钮、菜单里的“展开”，或按 `Ctrl+Alt+Enter`，终端会覆盖到约 93% 视口宽（实测 PTY 从 88 列提升到 **185 列**），命令行不再被窄侧栏折断；按 `Esc`（终端未聚焦时）、点背景或再点最小化按钮退出。终端内运行 vim/TUI 时 `Esc` 仍发给程序，不会被抢走。
- **字体大小可调**：`⋯ → 字体放大/缩小` 或 `Ctrl+Alt+=` / `Ctrl+Alt+-`，10–20px 可调，持久化到 localStorage；`Ctrl+Alt+0` 恢复跟随 DSH 字体设置。
- **视觉细节**：放大态使用圆角浮层 + 背景模糊 + 阴影，终端区更宽的留白；暂停/倒计时/未读等状态徽标保持紧凑。

## v1.2.2 修复（2026-10-26）

- **修复“终端显示已退出但一直不关”**：v1.2.1 的悬停/选中暂停是单向的，点开一个已结束的命令页签后自动关闭会永久暂停，页签看起来已关闭却一直留着。1.2.2 改为：
  - 鼠标在终端/页签上**移动时临时暂停**，移开后自动恢复倒计时并关闭；
  - **点击/选中页签不再永久暂停**，只有点“保留”才会永久保留；
  - 暂停中的页签直接显示“已暂停”徽标，不再伪装成普通已退出状态。
- **关闭失败不再“假关闭”**：`/close` 非 404 失败时重新同步会话列表；Host 端 terminate 失败也不再返回 500，而是记录日志后完成关闭。
- 版本号/构建/文档统一为 **1.2.2**。

## v1.2.1 一览

v1.2.1 把评审报告中的功能、交互和界面建议全部落在一个版本里：

- **可读**：命令结束后默认 8s（失败 30s）才自动关闭，关闭前有倒计时；鼠标悬停时临时暂停、移开恢复；点“保留”永久保留。关闭的命令进入**最近命令历史**并可回看、复制、搜索、导出。
- **可看**：短命令阈值改为从 **shell 就绪后**计时，默认 1.5s；Windows 的 PowerShell 启动开销不再吞掉普通命令；被隐藏的短命令也有提示入口。
- **可控**：新增 `wait` / `status` / `signal` / `resize` / `read` 分页 / `search` / `expect` / `send.keys` / `exec` / `rename` / `history` / `export` 等工具；`run/open` 支持 `cwd`、`shell`、`cols/rows`、`env`；截图支持 `text`、`ansi`、`png`。
- **可操作**：会话切换器、重命名、保留、复制选区、右键菜单、`Ctrl+F` 搜索、跟随/固定、未读角标、关闭全部已结束、配置面板、快捷键。
- **可恢复**：失败通知不再依赖面板是否打开；断线保留最后屏幕而不是全屏遮罩；连接态、错误态、只读态都有明确状态条。
- **可信**：未套 DSH 文件沙箱的事实会在首次提示、状态栏和工具结果中明确标注；`requireSandbox` 可强制回退到内置沙箱工具。

## 功能

- **在 DSH 右侧栏拉起真实终端**（xterm.js + PTY，支持 PowerShell / cmd / bash），可直接键盘输入、多标签、resize、刷新重连；窄侧栏可一键进入**专注模式**放大到接近全屏，字体大小可调。
- **接管默认 shell 命令**：DSH agent 的前台 `pwsh` / `bash` 调用自动在面板里执行，输出实时滚动；agent 开始执行时右侧栏自动弹出（每个 DSH 会话最多一次，失败会重试）。
- **终端截图**：agent 可用 `live_terminal_screenshot` 拿到当前可见屏幕文本 + 光标/尺寸；`format:"png"` 时由浏览器渲染图片并按附件返回；`format:"ansi"` 返回 ANSI。
- **完整 agent 控制面**：等待结束/匹配、查询状态、发送信号、调整尺寸、分页读取、搜索、按键序列、在已有 shell 中执行命令、重命名、导出、历史查询。
- **最近命令历史**：关闭的命令终端默认保留最近 20 条（可配置、可落盘），面板和 agent 都能回看，Host 重启后历史仍在。
- **本地链接可点击**：终端输出里的 `http://localhost:PORT` 等地址自动变成可点击链接；工具结果也会返回检测到的端口。
- **界面**：中英文、跟随 DSH 主题与终端字体字号设置、紧凑会话条、可折叠状态栏、响应式窄栏、深色/浅色主题、键盘与读屏可访问性。
- **安全回退**：带 `run_in_background` 或 `sandbox_permissions`（升权）的 shell 调用不会被接管，仍走 DSH 原生实现，保持原有审批/沙箱/后台语义。

## 安装

**桌面版 DSH**（安装后需完全退出并重新打开 DeepSeek Harness 一次）：

```powershell
dsh plugin --profile desktop add dsh-live-terminal
```

**Web 版 DSH**：

```powershell
dsh plugin --profile web add dsh-live-terminal
# 重启该 Host 后生效
```

**图形界面**：设置 → 插件 → 添加插件，输入 `dsh-live-terminal`。

**插件市场**：在 [awesome-dsh-plugin](https://awesome-dsh-plugin.com/) / dsh-market 中搜索 **Live Terminal** 或 `dsh-live-terminal`。

**从本地 `link:` 开发切回 npm 安装**（可选）：完全退出 DeepSeek Harness 后，在仓库根目录运行

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\switch-desktop-to-npm.ps1
```

脚本会先检测 DSH 是否仍在运行（运行中会被文件锁挡住并直接退出），并**先安全移除 profile 里的 `link:` junction**（规避 DSH/pnpm 在 link→npm 替换失败时清理删除被链接仓库 `.git` 元数据的问题；只删 reparse point，不动仓库目录），再把 Desktop profile 的依赖换成 npm 上的版本并校验安装结果；失败会自动恢复本地 link，加 `-RestoreLink` 可手动切回本地链接。

## 使用

### 用户侧

1. 正常和 DSH 对话，让它执行命令（例如“运行 npm test”）。命令会自动出现在右侧栏的**终端面板**中，实时输出。
2. 自己敲命令：右侧栏 → **终端面板** → 会话条上的 **+**。
3. 命令结束后面板会显示倒计时：**保留** 可让该终端不自动关闭；鼠标移到终端/页签上会临时暂停，移开恢复。点击页签本身不会永久暂停。
4. 想回看已关闭的命令：会话条 **⋯ → 历史**（或命令失败通知上的“查看历史”）。
5. 想复制终端内容：选中文本后 `Ctrl+Shift+C`，或右键 → 复制；整屏复制在 **⋯ → 复制屏幕文本**。
6. 想搜索输出：`Ctrl+F` 打开搜索条，`Enter` / `Shift+Enter` 跳转。
7. 需要更大的终端：DSH 右侧栏支持全屏/浮动（侧栏右上角），面板会自动 fit。
8. 快捷键（面板内置，页面聚焦时生效）：
   - `Ctrl+Shift+\`` 打开/聚焦终端面板
   - `Ctrl+Alt+T` 新建终端
   - `Ctrl+Alt+Shift+W` 关闭当前终端
   - `Ctrl+Alt+F` 切换“跟随最新命令”
9. 侧栏太窄、命令换行影响阅读时：点终端条右侧放大按钮（或 `⋯ → 展开`、`Ctrl+Alt+Enter`）进入**专注模式**；终端会放大到接近全屏，按 `Esc`（终端未聚焦时）或点背景退出。`⋯ → 字体放大/缩小` 可调字号。
10. 面板 **⋯ → 设置** 可查看当前生效的配置（短命令阈值、自动关闭时间、历史条数等）并复制配置片段。

### Agent 工具

| 工具 | 作用 |
|---|---|
| `live_terminal_run` | 在可见终端里跑一条命令（独立会话），可等待或立即返回；支持 `cwd/shell/cols/rows/env/keepOpen` |
| `live_terminal_screenshot` | 截取终端屏幕：`text`（默认）/ `ansi` / `png`；可带 scrollback |
| `live_terminal_send` | 向交互终端写入文本/按键（`keys:["Up","Enter"]`、`C-c`、`paste:true`） |
| `live_terminal_read` | 读取尾部/区间/全部输出（已关闭终端自动回退历史） |
| `live_terminal_search` | 在保留输出中搜索字面量或正则，返回行号与上下文 |
| `live_terminal_wait` | 等待进程退出或输出匹配，不杀进程 |
| `live_terminal_expect` | 等待某个模式出现（dev server ready / 提示符） |
| `live_terminal_status` | 查询状态、退出码、信号、耗时、cwd、端口、沙箱标注 |
| `live_terminal_signal` | 发送 SIGINT / SIGTERM / SIGKILL / SIGHUP（SIGINT 写 Ctrl-C） |
| `live_terminal_resize` | 调整 PTY/屏幕尺寸，TUI 截图前很有用 |
| `live_terminal_exec` | 在已有交互终端里执行命令，保留 `cd`/env/venv/alias |
| `live_terminal_list` | 列出可见终端与历史数量 |
| `live_terminal_history` | 最近关闭的命令（退出码/耗时/输出尾部） |
| `live_terminal_open` | 新建可见交互终端（成为该 agent 的默认交互终端） |
| `live_terminal_close` | 关闭终端并终止进程树（退出命令会进历史） |
| `live_terminal_rename` | 重命名终端 |
| `live_terminal_export` | 导出 text/ansi（大文件落盘并返回路径） |

## 自动清理与历史（v1.2.1）

- **短命令不上屏**：被接管的内置 `pwsh`/`bash` 前台命令如果运行时间短于 `interceptMinVisibleMs`（默认 **1500ms**），不会产生终端 tab、不触发右侧栏自动弹出、也不发 `sessions` 事件。与旧版不同，计时从 **shell 首个输出帧（就绪）** 开始，因此 Windows 的 PowerShell/ConPTY 启动开销不会吞掉普通命令。失败时仍会发 `notice`。设为 `0` 可全部上屏。
- **结束后自动关闭**：一次性命令终端在命令结束后自动关闭——成功默认 **8s**，失败/超时/中止默认 **30s**。关闭前有倒计时；鼠标移入终端/页签时临时暂停，移开恢复；点“保留”后永不自动关闭。`live_terminal_run` 创建的终端同样适用（`autoCloseToolTerminals: false` 可关闭该行为），工具参数 `keepOpen: true` 可保留。
- **最近命令历史**：命令终端关闭（自动或手动）后写入历史（默认 20 条，尾部 ≤64KB），可通过面板“历史”或 `live_terminal_history` / `live_terminal_read`（按原 terminalId）回看；`historyPersist: true` 时落盘，Host 重启后仍可查看。
- **失败通知**：通过全局 SSE（`GET /dsh-terminal-panel/events`）发 `notice` 事件；即使面板未打开也能收到可点击的全局 Toast。`autoCloseNotice` 控制发送范围：`failed` / `all`（默认）/ `none`。
- **端口**：命令输出中的 loopback 地址会检测并作为可点击链接；`live_terminal_status/read/export` 等结果也带 `ports`。

## 配置

在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 覆盖：

```yaml
- id: dsh-live-terminal
  name: dsh-live-terminal
  config:
    interceptShellTools: true    # 是否接管内置 pwsh/bash 前台命令（默认 true）
    shellPath: null              # 交互 shell 路径；null = 自动探测 pwsh → powershell → cmd
    scrollback: 2000             # 每个终端的回滚行数
    maxOutputBytes: 262144       # 单会话保留输出字节
    maxSessions: 16              # 全局终端会话上限
    perSessionMaxSessions: 8     # 单个 DSH 会话的终端上限
    commandTimeoutMs: 180000     # live_terminal_run(wait:true) 的默认等待超时；被接管的 pwsh 前台调用固定 120s 上限
    retainExited: 10             # 保留多少个已退出但未关闭的会话（兼容旧键）
    historySize: 20              # 最近关闭命令历史条数
    historyPath: null            # 历史文件；null = <home>/.dsh/dsh-live-terminal/history.json；空串禁用
    historyPersist: true         # 是否落盘历史
    interceptMinVisibleMs: 1500  # 被接管命令从 shell 就绪起至少运行多久才上屏；0 = 全部上屏
    autoCloseCommandDelayMs: 8000   # 成功结束的一次性命令终端延迟多久自动关闭；-1 = 永不
    autoCloseFailedDelayMs: 30000   # 失败/超时/中止的一次性命令终端延迟；-1 = 永不
    autoCloseToolTerminals: true    # false = 只自动关闭被接管的命令，live_terminal_run 创建的终端不自动关
    autoCloseNotice: all            # failed | all | none
    requireSandbox: false        # true = 当前 DSH 沙箱非 danger-full-access 时回退内置工具/拒绝新建
    allowUnconfined: true        # agent 终端未套沙箱是否允许（配合 UI 徽标与首次提示）
    portDetection: true          # 是否检测 localhost 端口并生成可点击链接
```

把 `interceptShellTools` 设为 `false` 可完全恢复原生 shell 行为，只保留 agent 主动使用的 `live_terminal_*`。

### 关于沙箱（重要）

面板里的命令行与 agent 创建的终端都以**当前系统用户权限**运行，`ctx.subprocess.spawnTerminal` 分配的 PTY **不套 DSH 的文件沙箱**，这与 DSH 自带的“用户终端”语义一致。v1.2.1 的处理方式是**如实标注 + 可强制**：

- 工具结果带 `sandbox: { mode, confined, required }`；面板状态栏和首次提示会显示“未沙箱”；
- `requireSandbox: true` 时，若当前会话沙箱不是 `danger-full-access`，被接管的内置 shell 调用会回退到 DSH 原生（受沙箱）工具，`live_terminal_run/open` 会以 `SANDBOX_REQUIRED` 拒绝；
- 带 `run_in_background` 或 `sandbox_permissions` 的调用永远不会被接管。

如果你的部署依赖 DSH 沙箱，请设置 `requireSandbox: true`。

## 快捷键

| 操作 | 默认 |
|---|---|
| 打开/聚焦终端面板 | `Ctrl+Shift+\`` |
| 新建终端 | `Ctrl+Alt+T` |
| 关闭当前终端 | `Ctrl+Alt+Shift+W` |
| 专注模式（放大/还原终端） | `Ctrl+Alt+Enter` |
| 字体放大/缩小/恢复 | `Ctrl+Alt+=` / `Ctrl+Alt+-` / `Ctrl+Alt+0` |
| 跟随最新命令 | `Ctrl+Alt+F` |
| 搜索终端输出 | `Ctrl+F`（面板内） |
| 复制选区 | `Ctrl+Shift+C` |
| 粘贴 | `Ctrl+Shift+V` |

以上快捷键由面板自身的局部键盘映射处理（`Ctrl+F`/`Ctrl+Shift+C` 等在终端聚焦时由 xterm 捕获），不占用 DSH 的全局快捷键注册表，因此不会与页面/终端快捷键冲突。

## 兼容性

- DSH **0.2.1-rc.2**（`engines.dsh: >=0.2.1-rc.2 <0.3.0-0`；`dsh.compatibility.dshReleases` 声明 0.2.1-rc.2 兼容）。
- Windows 10/11（PowerShell / cmd / Git Bash）与 POSIX（bash）。
- 运行时依赖：`@xterm/headless`、`@xterm/addon-serialize`（安装时自动安装，纯 JS）；客户端额外打包 `@xterm/addon-search`、`@xterm/addon-web-links`、`@xterm/addon-unicode11`。

## 安全说明

- 面板里的命令以**当前系统用户权限**运行，等价于你自己打开的终端，**不套 DSH 的 agent 文件沙箱**；见上文“关于沙箱”。
- 插件 HTTP/SSE 接口复用 DSH 浏览器签名 cookie 鉴权（`ctx.connection.admit`），未授权请求返回 401/403。
- 截图只读取终端屏幕缓冲；PNG 由本机浏览器渲染并作为 DSH 附件保存，不上传外部服务。
- 历史文件只保存在本机 `~/.dsh/dsh-live-terminal/history.json`，可用 `historyPersist: false` 关闭。
- DSH 插件以进程内代码运行；只从本仓库/npm 官方源安装可信版本。

## 已知限制

- 实时终端会话只存在于 Host 进程内，DSH 重启不会恢复正在运行的进程（**历史**会保留，见上）。
- 被接管命令的 stdout/stderr 在 PTY 中合并（结果仍符合内置工具 schema）。
- `wait:false` 的后台命令不再被默认超时自动终止，需要用户手动关闭或等其自行结束。
- `live_terminal_screenshot(format:"png")` 需要浏览器端面板处于连接状态；没有连接时自动回退为文本 + warnings。
- `live_terminal_exec` 依赖 shell 的 marker 包装，极少数会重写提示符/别名的 shell 配置可能影响输出边界。
- 终端会话归属全局 Host：不同 DSH 会话的终端会在同一面板中显示，可用面板的“本会话”过滤/标识区分。
- DSH 升级到新 minor 版本后可能需要适配插件 API（`tools/execute` 拦截、client 模块基座）。

## v1.2.1 变更

- **自动清理可读化**：自动关闭倒计时；鼠标移入临时暂停、移开恢复（1.2.2 修复单向暂停）；一键保留；失败延迟 30s（成功 8s）；关闭命令进入历史。
- **可见性**：`interceptMinVisibleMs` 默认 1500ms 且从 shell 就绪计时；隐藏命令提示/入口；自动打开按 DSH 会话一次并重试。
- **历史**：最近关闭命令 LRU + 持久化；面板历史视图；`live_terminal_history`；read/screenshot/status/search 支持按原 terminalId 回退历史。
- **工具面**：新增 wait/status/signal/resize/read 分页/search/expect/send.keys/exec/rename/history/export；run/open 支持 cwd/shell/cols/rows/env；run 返回 cwd/signal/duration/truncated/ports/sandbox；screenshot 支持 text/ansi/png；只读工具有并发安全声明；工具输出 12KB/6k 字符双上限。
- **Host**：多客户端输入租约（`take-control`）、回放（`/replay`）、导出（`/export`）、localhost 端口检测、每 DSH 会话配额、沙箱标注与 `requireSandbox`、失败/完成/端口通知。
- **界面**：去掉重复标题/工具栏，会话条 + ⋯ 菜单 + 跟随开关；页签重命名/保留/关闭已结束/自动滚入；选中复制、右键菜单、`Ctrl+F` 搜索、粘贴；焦点管理、错误横幅替代全屏遮罩、连接态、对比度与 24px 命中区、深色与窄栏适配、reduced-motion。
- **通知**：全局 Toast（不依赖面板挂载）+ 首次使用引导（含未沙箱说明）。
- **配置/文档**：`GET /config` 与面板设置；README/架构/测试报告统一按 **1.2.1**。

## 为什么自研

调研了 DSH 插件市场中的终端/截图类插件后自研：

- 官方右侧栏终端有窗口，但**不把输出交给 agent**、不支持 agent 截图；
- 官方“持久终端”bundle 有 agent 工具，但**没有可见窗口**；
- 社区最接近的 `@hyzyn/dsh-tty` 有自己的 `tty_*` 工具，但**不接管默认 pwsh**，且依赖内部句柄实现、版本耦合风险较高。

本插件用官方插件机制 + 官方 `ctx.subprocess.spawnTerminal` PTY 原语 + headless xterm 屏幕镜像，同时满足“默认命令可见 + agent 截图”，并保留原生工具的回退路径。

---

## 开发

仓库根目录就是可发布的插件包（`package.json` 中的 `dsh.bundle` 声明使其可被 `dsh plugin add` 安装）。

```
lib/                 host 半侧（PTY 会话、SSE、工具、shell 拦截、历史/端口/按键/exec）
client-src/          浏览器半侧源码（xterm 面板，esbuild 打包成 lib/client.js）
tests/               host 纯逻辑单元测试（node:test）
tools/               构建、安装、e2e 脚本
docs/                architecture.md（接口契约）、test-report.md（验收报告）、impl-1.2.1-contract.md（实现契约）
qa/                  独立 QA 测试计划与脚本
screenshots.json     市场截图清单
```

```powershell
npm install                          # 安装构建/测试依赖
npm run build                        # 构建 client-src → lib/client.js
npm test                             # host 单元测试
npm run typecheck

# 独立 dev host（不影响正在运行的 Desktop DSH）
& "D:\DSH\resources\runtime\cli\bin\dsh.cmd" --profile dev --no-open --port 3101
# 用日志里的带 token URL 打开页面；右侧栏快捷键：Ctrl+Shift+B

# 本地验收（需要上面的 dev host 与带 token URL）
node tools/smoke-ui-121.mjs "<url-with-token>"   # 面板/输入/搜索/菜单/配置 16 项
node tools/accept-121.mjs "<url-with-token>"     # 真实 agent：拦截/自动打开/自动关闭/历史/tool 17 项
```

CI（GitHub Actions）：`windows-latest` 用 Node 22/24 跑全量（`npm ci` → `npm run build` → bundle freshness（`git diff --exit-code -- lib/client.js`，产物未同步即失败）→ `npm test` → `npm run typecheck`）；`ubuntu-latest`（Node 24）跑平台无关测试子集（排除断言 Windows 路径语义的 `tests/registry.test.mjs`）。配置见 `.github/workflows/ci.yml`。

### 发布

发布到 npm 与提交插件市场的完整步骤见 [`PUBLISHING.md`](./PUBLISHING.md)。

## License

MIT
