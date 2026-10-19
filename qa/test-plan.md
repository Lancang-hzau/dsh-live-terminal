# dsh-terminal-panel — 独立测试计划（QA）

| 项 | 值 |
|---|---|
| 文档版本 | v1.1（阶段 A；纳入 2026-10-19 Lead 契约更新：`live_` 工具前缀 / 自动打开 / 截图=文本屏幕） |
| 作者 | qa-verifier（独立 QA） |
| 日期 | 2026-10-19 Asia/Shanghai |
| 契约来源 | `docs/architecture.md`（尤其 §4 接口、§5 客户端、§6 测试与验收） |
| 被测对象 | `packages/dsh-terminal-panel`（host: `lib/index.js` + `lib/host/**`；client: `lib/client.js` 由 `tools/build-client.mjs` 从 `client-src/**` 构建） |
| 测试环境 | DSH 0.2.1-rc.2 Desktop 提供 runtime，`--profile dev` 独立 dev host，端口 **3105**（QA 专用）；Lead 的 3101、用户 Desktop 的 58966 一律不动 |
| 自动化入口 | `tools/qa-e2e.mjs`（Playwright-core + 系统 Chrome + HTTP/SSE 断言） |
| 证据目录 | `qa/artifacts/<runId>/`（截图 + `summary.json` + `console.log`） |
| 报告 | `docs/test-report.md` |

---

## 1. 目标与范围

独立验证插件满足用户三条核心需求（architecture.md §1）：

- **A** 在 DSH Web GUI 中拉起可见、可交互的真实 PTY 终端面板；
- **B** DSH agent 执行的终端命令在面板中实时可见；
- **C** agent 能截取终端当前屏幕**文本**（用户已确认：文本屏幕快照，不做 PNG/图片）并把结果交给模型（`live_terminal_screenshot`）；
- **D**（契约 §5.2 自动打开）出现新的 agent 命令会话时，终端面板在右侧栏自动打开（每浏览器标签页最多一次）。

范围为 architecture.md §6.2 全部 e2e 场景 + §6.3 验收门槛 + §4 接口契约 + §5 客户端行为，并覆盖任务书要求的边界：中文/ANSI/长输出/超时/关闭/重连/resize/多会话/未鉴权 401/拦截回退。

**不在范围**：修改实现代码；重启用户 Desktop DSH（58966）；消耗模型额度的真实对话验证（工具/拦截类由 Lead 或 host-engine 单测验证，QA 给出验证方法与判定）；非 Windows 平台。

---

## 2. 环境与前置条件

### 2.1 启动 QA 自己的 dev host（端口 3105）

```powershell
# 后台启动（日志必须落盘，便于断言“无插件报错”）
& "D:\DSH\resources\runtime\cli\bin\dsh.cmd" --profile dev --no-open --port 3105 *> "C:\Users\LANCANG\Desktop\Code\DSH plugin\qa\artifacts\devhost-3105.log"
# 从日志提取 URL：
#   dsh web: http://127.0.0.1:3105/?token=...
```

约束：
- 只 kill 自己 3105 端口的 host；**不得 kill 3101 / 58966**。
- 重启 host 才能加载新的 host 半侧与 client bundle（client-modules 在启动时快照）。
- dev profile 已通过 junction 安装插件：`C:\Users\LANCANG\.dsh\profiles\dev\node_modules\dsh-terminal-panel -> packages\dsh-terminal-panel`，无需重新安装。
- 启动/重启耗时 10–30s：等待日志出现 `dsh web: http://127.0.0.1:3105/?token=` 后再执行 e2e。

### 2.2 浏览器

- 系统 Chrome：`C:/Program Files/Google/Chrome/Application/chrome.exe`
- `playwright-core` `chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] })`
- 允许 `DSH_TEST_BROWSER` 覆盖可执行文件路径（沿用仓库既有脚本约定）。

### 2.3 测试数据与副作用控制

- **不向真实对话发送消息、不触发模型调用**（避免消耗用户额度）：面板测试只用本地 PowerShell 命令（`Write-Output` 等）。
- 新建的终端会话在测试结束时尽量 `POST /close` 清理；UI 关闭按钮单独覆盖。
- 优先级：复用 dev 实例已有会话打开右侧栏；无会话时允许 UI“新建会话”（不发送消息）。
- 已知噪声：DSH 自身的 `GET /api/changes.summary?...` 可能 404，与插件无关，不判失败，单独记录。

### 2.4 认证

- token URL 首次访问交换出签名 cookie；e2e 用 Playwright `BrowserContext.request` 复用 cookie 做 HTTP 断言。
- **未鉴权基线**：同机 Node/Playwright 独立请求（无 cookie、无 Origin，Host 为 127.0.0.1:3105）期望 **401 `{error}`**；跨站 Origin 期望 403（可仅记录）。依据：`connection.admit(req)` 返回 `{ peer }` 或 `{ rejection: 401|403 }`。

---

## 3. 测试分层与手段

| 层 | 手段 | 覆盖 | 判定方 |
|---|---|---|---|
| L1 静态契约审查 | 阅读 `lib/index.js`、`lib/host/**`、`client-src/**`、`lib/client.js`、`cordis.patch.yml`、`package.json`，逐条对照 architecture.md §3–§5 | 接口名、事件格式、工具 schema、鉴权、错误处理、external 模块、构建产物包装 | QA |
| L2 host 单测 | `node --test packages/dsh-terminal-panel/tests/`（host-engine 的 tests；QA 独立运行并核对 6.1 覆盖） | ansi/ring/wrapper 解析/value 映射 | QA 运行，host-engine 维护 |
| L3 HTTP/SSE 黑盒 | `context.request` + 浏览器内 `fetch`/`EventSource` | 路由、状态码、JSON 形状、SSE 事件名/时序/实时性、边界 | QA 自动 |
| L4 UI e2e | Playwright 驱动真实 GUI（右侧栏 guide → 面板 → xterm 输入/输出/resize/关闭/重连） | A、面板可用性 | QA 自动 |
| L5 工具/拦截 | 需由 agent 触发内置 `pwsh` 与 `live_terminal_*` 工具，浏览器无法直接调用 | B（拦截）、C（截图工具）、超时、wait:false、自动打开 | **人工/Lead 验证**（QA 给出步骤与判定，见 §4.5） |

> 工具型断言（`live_terminal_run`/`live_terminal_screenshot`/拦截/自动打开）在报告中标注 `MANUAL` 或 `BLOCKED-BY-CREDITS`，并在 §4.5 给出可执行的人工验证方法与期望证据；host-engine 的单测（value 映射/schema 合法性）作为静态与单元层面的补充证据。

---

## 4. 用例清单

状态枚举：`P0` 阻断验收｜`P1` 重要｜`P2` 一般。执行方式：`AUTO-HTTP` / `AUTO-SSE` / `AUTO-UI` / `MANUAL` / `STATIC`。

### 4.1 验收门槛（architecture.md §6.3）

| ID | P | 场景 | 步骤 | 期望 | 方式 |
|---|---|---|---|---|---|
| E-01 | P0 | dev host 启动无插件报错 | 启动 3105，检查日志 | 无 `dsh-terminal-panel` 相关 error/exception；出现 `client half loaded` 与路由注册日志 | MANUAL/日志 |
| E-02 | P0 | `/sessions` 带 cookie 200 | `GET /dsh-terminal-panel/sessions`（带 cookie） | 200，`{ sessions: [...] }` | AUTO-HTTP |
| E-03 | P0 | client bundle 加载无 console error | 打开页面，监控 console/pageerror | 无与 `dsh-terminal-panel` 相关的 console error / pageerror；`__DSH_TERMINAL_PANEL__` 可达（若实现保留该调试标记，否则以客户端日志为准） | AUTO-UI |
| E-04 | P0 | 面板可开 | Ctrl+Shift+B → 点 guide“终端面板” | 面板 body 出现（`[data-dsh-terminal-panel="body"]`），截图 | AUTO-UI |
| E-05 | P0 | 面板可输入 | xterm 输入 `Write-Output 'qa-hello'` + Enter | 屏幕出现 `qa-hello`（≤10s） | AUTO-UI |
| E-06 | P0 | resize | 改变视口/容器尺寸，或 `POST /resize` | 无报错；`GET /snapshot` 的 cols/rows 与生效值一致 | AUTO-UI/HTTP |
| E-07 | P0 | 可关会话 | UI 关闭按钮 / `POST /close` | 会话从列表移除；`/sessions` 不再含该 id；snapshot 对该 id 4xx | AUTO-HTTP/UI |
| E-08 | P0 | SSE 实时输出 | `GET /events?id=` 订阅后执行命令 | `output` 帧在产品化时延内到达（目标 <2s），`seq` 递增；首帧 `snapshot` | AUTO-SSE |
| E-09 | P0 | 拦截生效（B） | agent 调用内置 `pwsh` 工具执行命令 | 面板出现 `kind:'command'` 会话并实时输出；工具结果正常（agent 不报错）；value 符合内置工具 schema | MANUAL（见 §4.5 T-02） |
| E-10 | P0 | `live_terminal_screenshot` 返回屏幕文本（C） | agent 调 `live_terminal_screenshot` | value 含 `text`/`ansi`/`cols`/`rows`/`cursor`，`text` 与当前屏幕一致；**不含图片块**（用户确认文本快照） | MANUAL（见 §4.5 T-04） |
| E-11 | P1 | desktop profile 安装后同样工作 | Lead 在确认后安装到 desktop profile 并重启 Desktop | 同 E-04/E-05 | Lead（不在 QA 自动范围） |
| E-12 | P0 | agent 命令会话自动打开面板（契约 §5.2） | 右侧栏未打开面板时，agent 执行一条前台 `pwsh` 命令（拦截管线） | 右侧栏自动打开并显示“终端面板”tab，可看到命令会话实时输出；同一浏览器标签页最多自动打开一次；若面板已打开则不重复开 tab | MANUAL-LEAD（见 §4.5 T-11） |

### 4.2 e2e 场景（architecture.md §6.2）

| ID | P | 场景 | 步骤 | 期望 | 方式 |
|---|---|---|---|---|---|
| U-01 | P0 | 打开 dev GUI | `page.goto(token URL)` | 页面渲染，进入工作台（无登录墙/错误页） | AUTO-UI |
| U-02 | P0 | 关闭预览弹窗 | 检测并关闭“继续/预览/知道了”类弹窗 | 弹窗消失，不遮挡右侧栏 | AUTO-UI |
| U-03 | P0 | 打开会话 | 复用已有会话（优先按标题），否则新建会话（不发消息） | 会话视图出现（编辑器/输入区可见） | AUTO-UI |
| U-04 | P0 | Ctrl+Shift+B → guide | 按快捷键打开右侧栏，查找“终端面板”guide 入口 | 右侧栏展开；guide 入口可见且可点击 | AUTO-UI |
| U-05 | P0 | 点 guide → 面板 body | 点击入口 | 面板 tab 打开；body 渲染；截图 | AUTO-UI |
| U-06 | P0 | 新建终端 → xterm | 面板内点“新建终端” | 出现 xterm 视图（`.xterm`）；会话列表含 running 会话；`/sessions` 新增项 | AUTO-UI |
| U-07 | P0 | 输入命令 → 屏幕输出 | xterm 内输入 `Write-Output 'qa-hello'` + Enter | 屏幕出现 `qa-hello`；无 pageerror | AUTO-UI |
| U-08 | P1 | 中文输出 | 输入 `Write-Output '中文测试-终端面板'` | 屏幕正确显示中文（无乱码/�） | AUTO-UI |
| U-09 | P1 | resize 生效 | 改变窗口大小或拖拽面板 | xterm `fit()` 正常，cols/rows 变化并 POST `/resize`；无报错 | AUTO-UI |
| U-10 | P1 | 关闭当前会话 | 点面板关闭按钮 | 会话列表移除；xterm 切到空态/其他会话；host `/sessions` 同步 | AUTO-UI |
| U-11 | P1 | 页面刷新重连 | 刷新页面 → 重新打开右侧栏与面板 | 面板重新加载；已有会话仍在列表（host 不因断连销毁）；SSE 重连后屏幕内容恢复 | AUTO-UI |
| U-12 | P1 | 多会话 | 新建 2 个终端并分别输入不同命令 | 两个会话内容互不串台；切换后各自屏幕正确 | AUTO-UI |
| U-13 | P2 | UI 截图按钮 | 点面板“截图/复制”按钮 | 剪贴板/提示包含当前屏幕文本（若权限受限标 SKIP） | AUTO-UI |
| U-14 | P2 | 空态 | 无会话时 | 显示“新建终端”引导按钮 | AUTO-UI |

### 4.3 HTTP/SSE 契约（architecture.md §4.4）

所有路径前缀 `/dsh-terminal-panel`，JSON 错误统一 `{ error: string }` + 4xx/5xx。

| ID | P | 检查 | 期望 |
|---|---|---|---|
| H-01 | P0 | `GET /sessions` 带 cookie | 200 `{sessions: SessionInfo[]}`；含已退出保留会话 |
| H-02 | P0 | `GET /sessions` 无 cookie | 401 `{error}`（或 403，须记录实际并对照契约） |
| H-03 | P0 | `POST /create {cols,rows,title?}` | 200 `{session}`；SessionInfo 字段齐全且枚举合法 |
| H-04 | P1 | `POST /create` 省略 cols/rows | 使用默认值（>0），不 500 |
| H-05 | P0 | `GET /snapshot?id=` | 200 `{info, screen, text, cursor:{x,y}}`；`screen` 为 ANSI 字符串，`text` 为可见屏纯文本 |
| H-06 | P0 | `POST /input` 写入命令 | 200 `{ok:true}`；随后 snapshot.text 出现输出 |
| H-07 | P0 | `GET /events?id=` SSE 格式 | `Content-Type: text/event-stream`；帧格式 `event: <name>\ndata: <json>\n\n`；事件名 ∈ {snapshot, output, state, exit}；`data` 为 JSON |
| H-08 | P0 | SSE 实时性与 seq | 命令输出在 <2s 内以 `output` 帧到达；`seq` 单调递增（记录实测延迟） |
| H-09 | P1 | `GET /events` 全局 SSE | 新会话/状态变化时收到 `sessions` 事件 |
| H-10 | P0 | `POST /resize {id,cols,rows}` | 200 `{ok:true}`；后续 snapshot.info.cols/rows 更新 |
| H-11 | P0 | `POST /close {id}` | 200 `{ok:true}`；`/sessions` 移除；snapshot 该 id 4xx `{error}` |
| H-12 | P1 | snapshot 缺 id / 未知 id | 4xx + `{error:string}`，不崩溃、不 500 堆栈泄漏 |
| H-13 | P1 | `POST /input` 未知 id | 4xx + `{error}` |
| H-14 | P1 | `POST /resize` 非整数 cols/rows（字符串等） | 4xx + `{error}`；越界数值（0/负数）接受 4xx 或安全钳制（实现策略记录在报告中） |
| H-15 | P1 | 非法 JSON body | 4xx；进程不崩溃、后续请求仍正常 |
| H-16 | P1 | 请求体 > 上限（>1MB） | 有界读取：4xx/413（`{error}`）或不 OOM、不挂起；若连接被直接重置导致客户端拿不到错误响应，记为缺陷（契约 §4.4 错误统一 JSON） |
| H-17 | P2 | 客户端在 SSE 中触发 `req.close` 清理 | 连续 5 次建立/断开 SSE 后 `/sessions`、新 SSE 仍正常（无订阅泄漏迹象） |
| H-18 | P2 | 20s 心跳注释 | SSE 连接 21s 内收到 `:` 注释帧（`--slow` 时执行） |

### 4.4 边界与数据正确性（HTTP 端到端）

| ID | P | 场景 | 命令（PowerShell，经 `/input` 下发） | 期望 |
|---|---|---|---|---|
| B-01 | P0 | 中文/UTF-8 | `Write-Output '中文测试-终端面板-ABC'` | snapshot.text 精确包含该串；无 `�` |
| B-02 | P1 | UTF-8 跨块 | `Write-Output ('中文ABC' * 400)`（大段 CJK 输出，覆盖解码器流式边界） | text 无替换符 `\uFFFD`；内容连续正确 |
| B-03 | P1 | ANSI | `Write-Host 'qa-red' -ForegroundColor Red`（及直接 ESC 序列命令） | snapshot.screen 含 `\x1b[`；snapshot.text 不含 ESC 控制符且含 `qa-red` |
| B-04 | P1 | 长输出 | `1..500 \| ForEach-Object { "qa-line-$_" }` | 无超时/崩溃；可见屏只保留屏高文本，最后一行包含 `qa-line-500`；ring 字节约为 `maxOutputBytes` 上限语义（可用 `live_terminal_read` 人工验证） |
| B-05 | P1 | 已退出会话 | 交互 shell 输入 `exit\r` | `/sessions` 中 state 变 `exited`，exitCode=0；快照仍可读；不重复 exit 帧 |
| B-06 | P1 | 多会话隔离 | 2 个会话分别输出 `qa-A` / `qa-B` | 各自 snapshot 只含自己的输出 |
| B-07 | P2 | 大输入（合法上限内） | 一次 `/input` 发 ~64KB 文本 | 200 且不破坏会话；超出上限则 4xx |
| B-08 | P2 | 控制字符 | `POST /input` 发 `\u0003`（Ctrl-C） | 中断当前命令，会话仍 running；不崩溃 |
| B-09 | P2 | 非法 UTF-8 字节 | 原样发送 `\xFF`（JSON 无法表达时以二进制 body 尝试） | 不崩溃；替换/忽略可接受，记录行为 |

### 4.5 工具与拦截（人工/Lead 验证；QA 给出方法与判定）

> 浏览器侧无法直接调用 DSH 工具；以下项由 Lead 在确认后驱动 agent 执行（会消耗模型额度，需 Lead 决定），QA 记录证据与结论。

| ID | P | 项 | 验证方法 | 期望/判定 |
|---|---|---|---|---|
| T-01 | P0 | 工具注册齐全 | 静态审查 + dev host 工具目录/日志；或 Lead 让 agent 调 `live_terminal_list` | 7 个工具均注册：`live_terminal_run/screenshot/send/read/list/open/close`；参数为 JSON Schema 对象；`output.schema` 合法且 runtime 校验通过 |
| T-02 | P0 | 拦截内置 pwsh | Lead 在 dev host 新会话发：“用 pwsh 工具运行 `Write-Output 'intercept-ok'`” | 面板出现命令会话（标题=命令首行）并实时输出 `intercept-ok`；工具结果正常，agent 不报错 |
| T-03 | P0 | 拦截回退 | Lead 发：“用 pwsh 运行 `Start-Sleep 3; Write-Output done` 并 `run_in_background: true`” | 不进入可见面板（走原实现/后台 job）；无报错；沙箱/审批语义不变 |
| T-04 | P0 | `live_terminal_screenshot` | Lead 发：“打开一个终端运行 `vim` 或 `Get-Process`，然后 live_terminal_screenshot” | 返回 `text` 是当前可见屏内容（TUI 场景可读）；value 严格符合 schema；render 首行含 `[terminal ...]` 标记；返回文本而非图片（用户确认） |
| T-05 | P1 | 命令超时 | Lead 发：“live_terminal_run 执行 `Start-Sleep 10`，timeoutMs 2000” | `timedOut:true`、`exitCode:null`；会话终止；下次 `live_terminal_run` 自动重建会话 |
| T-06 | P1 | `wait:false` + `live_terminal_read` | Lead 发：“live_terminal_run `1..20 \| %{ Start-Sleep -Milliseconds 200; $_ }`，wait:false，然后 live_terminal_read” | 立即返回 `stillRunning:true`；read 能读到递增输出 |
| T-07 | P1 | `live_terminal_send/open/close/list` | Lead 驱动 | open 创建新可见交互会话；send 写入并 submit；list 返回 SessionInfo[]；close 移除 |
| T-08 | P1 | agent 默认终端复用 | Lead 连续两次 `live_terminal_run` | 同一 agent 复用同一默认交互终端（terminalId 相同），不重复创建 |
| T-09 | P2 | 系统提示指南 | 静态审查 `prompt.js` | `ctx.systemPrompt.section` 注册 `tool:terminal-panel`，文案说明“命令自动显示在终端面板 / 用 live_terminal_screenshot 看屏幕” |
| T-10 | P2 | 超时取消（exec.signal abort） | host-engine 单测/人工 | abort 时 terminate 会话并返回 `aborted:true` |
| T-11 | P0 | 自动打开行为（契约 §5.2） | Lead 驱动：先关闭右侧栏/面板，再让 agent 执行一条前台 pwsh 命令；由 QA 在浏览器观察（可配合 `qa-e2e.mjs` 的 U-01～U-04 复现布局） | 新 `kind:'command' & owner:'agent' & state:'running'` 会话出现时右侧栏自动打开并显示终端面板；每浏览器标签页最多自动打开一次；面板已开时不重复开 tab |

### 4.6 静态契约一致性（L1，逐条对照 architecture.md）

| ID | P | 检查点 | 契约出处 |
|---|---|---|---|
| S-01 | P0 | 路由：方法/路径/请求/响应形状完全一致；前缀 `/dsh-terminal-panel` | §4.4 |
| S-02 | P0 | SSE：`event:`/`data:` 帧格式、事件名、心跳注释、`req.close` 清理 | §4.4 |
| S-03 | P0 | `SessionInfo` 字段/枚举与 §4.4 一致（id/title/kind/owner/sessionId/agentId/command/cwd/cols/rows/state/exitCode/error/createdAt/updatedAt） | §4.4 |
| S-04 | P0 | 工具名/参数/返回/默认值/render 与 §4.5 完全一致（7 个工具均带 `live_` 前缀；含 `timedOut/aborted/stillRunning`） | §4.5 |
| S-05 | P0 | 拦截条件与回退：仅 `pwsh`/`bash`；`run_in_background`/`sandbox_permissions` 走 `next()`；失败回退 `next()` | §4.6 |
| S-06 | P1 | 配置项名/默认值：`interceptShellTools/shellPath/scrollback/maxOutputBytes/maxSessions/commandTimeoutMs/retainExited` | §4.1 |
| S-07 | P1 | host 侧 `inject=['tools']`；不 import `@deepseek-ai/*`；headless xterm 经 `createRequire` | §4.1 |
| S-08 | P1 | 客户端：`inject` 服务、`sidebarRightTabs.register`（multiple/priority/guide）、`slots.inject('sidebar.right.pane.tab')`、locale zh/en、guide 文案“终端面板”、自动打开（每标签页一次） | §5.1–5.2 |
| S-09 | P1 | 构建产物：单文件 `lib/client.js`、`window.__ModuleLoader__.load` 包装、external 仅平台基座、xterm/CSS 打包进 bundle、`<style data-plugin>` 幂等注入 | §5.3 |
| S-10 | P1 | 单测覆盖 §6.1：ansi/ring/wrapper 解析/value 映射 | §6.1 |
| S-11 | P2 | 会话语义：命令会话保留 `retainExited`、交互会话不自动移除、单 writer 串行、EOF flush | §4.2–4.3 |

### 4.7 环境/回归

| ID | P | 场景 | 期望 |
|---|---|---|---|
| R-01 | P0 | 重启 dev host 后重新验证 E-02/E-04/E-05 | 插件仍正常；会话注册表从空开始 |
| R-02 | P1 | 重复运行 e2e 两次 | 无状态泄漏（会话清理、端口占用正常） |
| R-03 | P2 | 检查未修改 `D:\DSH` 与用户 Desktop 进程 | 58966 进程 PID 不变（QA 从开始到结束记录一次） |

---

## 5. 证据、裁定与报告

### 5.1 自动证据

`qa/artifacts/<runId>/`：
- `NN-<case>-<label>.png`：关键步骤截图（guide 页、面板打开、xterm 输出、resize 后、关闭后、错误态）；
- `summary.json`：`{ runId, url, startedAt, finishedAt, counts, results[], consoleErrors[], pageErrors[], pluginHttpErrors[], unrelatedHttpErrors[] }`；
- `console.log`：浏览器 console/pageerror 全量；
- 可选 `devhost-3105.log`：host 启动日志（由人工放入 run 目录或单独记录路径）。

### 5.2 报告格式（`docs/test-report.md`）

每项一行：`ID | 结果 PASS/FAIL/SKIP/MANUAL | 证据路径/命令 | 说明`。Bug 条目模板：

```
### BUG-N：标题
- 级别：P0/P1/P2
- 期望：
- 实际：
- 复现步骤：
- 证据：qa/artifacts/...png / summary.json / 日志行
- 影响：
- 建议 owner：host-engine / client-ui / Lead
- 契约依据：architecture.md §x.y
```

### 5.3 Bug 分级

- **P0**：验收门槛不满足（面板打不开、无法输入、SSE 不工作、鉴权失效、host 崩溃、拦截破坏 agent、契约核心不符）。
- **P1**：主流程可用但明显缺陷（中文乱码、resize 失效、关闭/重连异常、错误处理 500、多会话串台）。
- **P2**：体验/健壮性（心跳、边界输入、提示文案、非关键日志）。

---

## 6. 退出标准

- P0 项全部 PASS 或经 Lead 明确接受（有书面风险说明）；
- P1 项无未解释的 FAIL（FAIL 必须有 bug 记录并分派 owner）；
- `docs/test-report.md` 给出每项结论、证据路径与统计（PASS/FAIL/SKIP/MANUAL 数量）；
- 已知边界（工具/拦截/desktop 安装）明确标注为人工验证项，不作为隐藏遗漏。

---

## 7. 已知约束与风险

1. **无法从浏览器直接调工具**：工具/拦截类断言由人工驱动 agent 完成，QA 提供脚本化可验证的替代（HTTP snapshot 与 terminal_screenshot 同源、host 单测）。
2. **模型额度**：严禁 QA 触发真实对话/模型调用；人工验证需 Lead 决定。
3. **client bundle 需构建 + 重启 host**：联调窗口内 QA 只对当前产物负责，需确认 build 时间戳与 host 启动顺序（先 build 后启动）。
4. **dev profile 数据与 Desktop 可能共享工作区**：UI 用例优先复用已有会话，避免创建过多会话。
5. **DSH 自身 404 噪声**（`/api/changes.summary`）不判失败。
6. **工具输出 schema 运行时校验**：若失败会变成工具错误，人工验证时需检查 agent 是否收到工具错误。

---

## 8. 执行计划

| 阶段 | 内容 | 触发 |
|---|---|---|
| 阶段 A（进行中） | 本计划；`tools/qa-e2e.mjs` 骨架；静态审查已提交实现并报契约不一致 | 立即 |
| 阶段 B | 启动 3105 dev host → 完整跑 `qa-e2e.mjs` → 人工/Lead 项核查 → 写 `docs/test-report.md` → 报 Lead | Lead 通知“可以验收” |
| 复测 | 修复后重跑，报告标注 re-run 结果 | Bug 修复后 |

### 附：e2e 用法

```powershell
# 完整运行（UI + HTTP/SSE）
node tools/qa-e2e.mjs "http://127.0.0.1:3105/?token=..."

# 跳过 UI 交互（仍加载页面换 cookie；适合 host 已就绪、client 未就绪）
node tools/qa-e2e.mjs --http-only "http://127.0.0.1:3105/?token=..."

# 慢速项（20s 心跳）
node tools/qa-e2e.mjs --slow "http://127.0.0.1:3105/?token=..."

# 环境变量方式
$env:DSH_QA_URL = "http://127.0.0.1:3105/?token=..."; node tools/qa-e2e.mjs
```

退出码：`0` = 无 FAIL；`1` = 存在 FAIL；`2` = 参数/环境错误（拿不到 URL、浏览器不可用）。
