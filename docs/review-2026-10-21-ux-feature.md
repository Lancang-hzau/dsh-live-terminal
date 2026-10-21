# dsh-live-terminal v1.2.0 评审报告：使用功能 / 用户操作习惯 / 界面 UI

> 评审日期：2026-10-21 · 对象：v1.2.0（`f20c836` + 后续文档提交）· 方式：只读代码评审 + 现有截图/QA 产物 + 官方与社区竞品对照。
> 评审人：Lead（汇总 3 条并行评审线：工作流、UI/无障碍、agent 工具面）。
> 未修改任何代码、未启停 DSH host；文中行号以当前工作区为准。

---

## 0. 一句话结论

**基础能力已经很强**：它是目前唯一同时做到「右侧可见终端面板 + 接管默认 `pwsh`/`bash` 前台命令 + agent 文本截屏」的插件；PTY/xterm/SSE/自动清理的工程实现也扎实。

**但 v1.2 引入的“隐藏短命令 + 结束自动关闭”把核心卖点变成了“大多数时候看不见、刚要看就被关掉”**；同时，用户会把它当普通终端用，而选中复制、查找、重命名、多会话管理这些高频操作缺失。功能层面最大的机会在 agent 控制面（`wait` / `status` / `signal` / `resize` / `keys` / `expect` / `exec`），UI 层面最大的问题是**三层标签/工具栏重复挤占约 93–132px 竖向空间**。

**先做的 8 件事**（详见 §5）：修 `live_terminal_open` 默认终端映射 → 自动关闭倒计时/暂停/失败不提前关 → 阈值改为 shell-ready 后计时 → 最近命令历史 → 全局失败通知 → 选中复制/搜索 → 工具栏与状态栏重构 → agent 工具面补 `wait/signal/keys/exec`。

---

## 1. 使用功能（agent 工具与 host 能力）

### 1.1 先修的正确性问题（P0/P1）

| # | 问题 | 证据 | 影响 | 建议 |
|---|---|---|---|---|
| F-1 | **`live_terminal_open` 不登记默认交互终端** | `tools.js:335-343` 直接 `createInteractive`；默认映射只在 `ensureAgentTerminal` 写入（`registry.js:270-324`），而 `resolveForSend/Read` 只查该映射（`tools.js:467-491`） | 按 README 推荐流程 `open` 后再 `send`（不带 id）会**再建一个终端**，`read` 则报 "no default interactive terminal"；与 `architecture.md:224`、README 矛盾 | `open` 成功后把该会话写入 `#agentTerminals`（或在 registry 加 `setDefaultTerminal(agent, id)`），并补 host 测试 |
| F-2 | **agent 终端绕过 DSH 沙箱/审批** | `lib/index.js:29` 只 `inject: ['tools']`；`registry.js:506-516` spawn 未接 `sandboxPolicy/sandbox`；`intercept.js:99-111` 仅对显式 `sandbox_permissions` 回退 | 默认 `interceptShellTools: true` 时，普通 `pwsh/bash` 调用在 read-only / workspace-write 会话里也以**当前用户权限**执行，且 `live_terminal_*` 不走审批 | 二选一：① agent-owned 会话按当前 policy confine，不允许时回退内置工具；② 保持现状但**在 UI/首启提示中显著标注“未套沙箱”**，并在工具结果里带 `sandbox: {mode, enforcement}`。安全预期必须可见 |
| F-3 | **`wait:false` 结果在自动关闭后丢失** | `tools.js:118-136` 立即返回空 output；`registry.js:590-607, 677-687` 5s/2s 后 `close()` 彻底销毁 | 模型 5s 后回来 `read/screenshot` 得到 "terminal not found"；失败命令只剩 UI toast（且 toast 依赖面板挂载，见 U-3） | host 保留最近 N 条已关闭命令的 `{exitCode, signal, durationMs, tail≤8KB}` LRU 缓存；新增 `live_terminal_wait` / `live_terminal_status`；`read` 先查缓存 |
| F-4 | **`description` 参数被忽略** | schema 声明 “shown in the UI”（`tools.js:76`），但 `execute` 从未使用；`createCommandSession` 的 title 仍取命令首行（`tools.js:106-117`、`registry.js:217`） | agent 认真填的说明不生效，tab 仍显示命令原文 | 用 `args.description` 作 title（无则回退命令首行）；或删掉该参数 |
| F-5 | **screenshot 的 ANSI 字段模型看不到** | `tools.js:196-198` 在 `withScrollback` 时生成 `ansi`，但 `renderScreenshot` 只输出 `text`（`tools.js:612-615`） | 字段/文档行为不一致；`withScrollback:true` 时 `text` 又变成整段 scrollback，语义漂移 | 明确 `text`（可见屏）/`scrollback`（尾部文本）/`ansi`（可选）三字段，并让 render 输出一致的文本；当前建议删除 `ansi` 或改为 `scrollback` 文本 |
| F-6 | **三个默认目标不一致，模型难以预测** | `run` 自建终端；`send/read` → agent 默认交互终端（`tools.js:467-491`）；`screenshot` → 最近 **command** 优先，哪怕已退出（`registry.js:158-169`） | 交互场景下不带 id 的截图会截到旧命令；open→send 还会撞上 F-1 | 统一规则为“最近活跃的、属于本 agent 的可见终端（running 优先）”，并提供显式 `target: 'last-command' | 'active'` 语义 |
| F-7 | **`live_terminal_read` 丢字段** | `tools.js:276-277` 只取 `tail.text`，丢弃 `plainTail().truncated`；无 `exitCode/signal/durationMs` | agent 不知道输出是否被截断、命令怎么结束 | read 返回 `{text, truncated, startLine, endLine, totalLines, state, exitCode, signal}` |

### 1.2 agent 工具面建议补齐（按性价比）

| 建议 | 用途 / schema 要点 | 成本 | 优先级 |
|---|---|---|---|
| **`live_terminal_wait`** | `{terminalId, timeoutMs?, pattern?}` → `{state, exitCode, signal, durationMs, timedOut, text, truncated}`；`wait:false` 后阻塞等待，替代轮询 | S–M | P0 |
| **`live_terminal_status`** | 用 F-3 的缓存，5s 后仍能查 `exitCode/duration/tail` | S | P0 |
| **结果字段补齐** | `run` 增加 `cwd/durationMs/signal/truncated`；`SessionInfo` 暴露 `signal` | S | P0 |
| **`live_terminal_signal`** | `{terminalId, signal: SIGINT\|SIGTERM\|SIGKILL\|SIGHUP}`；SIGINT→写 `\x03`，其余→`session.terminate()`；仅自己的终端 | S | P1 |
| **`live_terminal_resize`** | `{terminalId, cols, rows}`；`run/open` 也支持初始 `cols/rows`，TUI 截屏前可调尺寸（路由 `/resize` 已存在，`routes.js:152-160`） | S | P1 |
| **`live_terminal_read` 分页 / `search`** | `read {offset, lines, raw?}`；`search {pattern, regex?, scope, maxResults}`；长日志精确取段/找错误，省 token | S–M | P1 |
| **`live_terminal_expect`** | `{terminalId, pattern, timeoutMs?, since}` → `{matched, text, timedOut}`；等 dev server ready / 构建完成 / 交互提示 | M | P1 |
| **`live_terminal_send` 按键与粘贴** | `keys?: ['Up','Enter','Tab','C-c','Esc',...]`；`submit:false` 的多行文本用 bracketed paste（DECSET 2004）；未知键名报错 | S | P1 |
| **`live_terminal_exec`** | 在**同一交互终端**执行命令并取单命令输出+退出码，保留 cwd/env/alias。现有 `wrapper.js`（marker 解析）host 完全未使用，正好复用；bash 需等价包装 | M | P1 |
| **`run/open` 参数补齐** | `run` 加 `cwd`、`shell: pwsh\|bash\|cmd`（`shellKindHint` 已实现，`registry.js:202-208`）、`env`（白名单+上限）；`open` 加 `cols/rows` | S–M | P1 |
| **`live_terminal_rename` / run `title?`** | `{terminalId, title}`；多任务面板可读性，也是 UI 双击重命名的 host 支撑 | S | P2 |
| **长输出 spill/export** | 超过阈值写 `<workspace>/.dsh/terminal/<id>.log`，结果带 `spillPath`；`export {format: txt\|ansi}` | S–M | P2 |
| **screenshot `format: png`** | 需光栅化 + `ctx.attachments.saveImage` + `inputModalities` 视觉模型门控；文本截屏已够用，暂列 P2 | L | P2 |
| **`isConcurrencySafe`** | `screenshot/read/list` 等只读工具声明并发安全；否则 `run(wait:false)` + 立即 `read` 也被串行化 | S | P2 |
| **token 预算** | `MAX_RENDER_CHARS=16000` 是**字符**（`tools.js:15`），中文≈16k tokens/次；建议字节+字符双上限（如 12KB / 6k chars）并返回 truncated；工具描述共约 5.5k 字符≈1.4–1.7k tokens/请求，可精简约 40% | S | P2 |

### 1.3 Host 能力差距（相对竞品）

- **录制/回放/导出**：无落盘；客户端重连只拿 snapshot，断线期间 output 帧丢失（`TerminalView.tsx:306-327`），无 `Last-Event-ID`/`fromSeq` 断点续传。（P2）
- **Host 重启持久化**：全丢（README 已列为已知限制）；不建议持久化 terminalId，可持久化 meta + 最后屏快照作只读归档。（P2）
- **端口探测/可点击链接**：无。host 可从输出扫 `localhost/127.0.0.1`，client 注册 xterm link provider——**低成本高价值**，尤其配合 dev server 场景。（P1 但可独立小版本）
- **多端 writer 租约**：SSE 支持多 follower，但没有“最新附件拥有输入”的语义（官方 controller 有）；多标签页可同时输入造成交错。建议加 `writable` 状态与 take-control。（P2）
- **生命周期配额**：全局 `maxSessions=16`，无 per-DSH-session 配额；`wait:false` 长命令在 DSH 会话结束后仍存活；`shellActivity:false`（`registry.js:513`）关闭了活动观测。（P2）
- **跨对话隔离**：`SessionInfo` 带 `sessionId`，但面板列表当前不按对话分组/过滤。若 host 为全局单实例，用户在不同对话间会看到混在一起的终端（建议先运行态确认；若确实如此，UI 应默认“本会话”过滤 + “全部”切换，tab 加所属对话/agent 标识）。（P1 UX）

---

## 2. 用户操作习惯（真实使用流程中的摩擦）

### 2.1 核心矛盾：v1.2 的“自动清理”与“可见”承诺互相抵消

**P0-U1 默认几乎看不到 agent 命令。**
`interceptMinVisibleMs = 4500ms`（`lib/index.js:40`）从 **spawn 开始计时**（`registry.js:543-550`），而 Windows 下 PowerShell/ConPTY 启动实测 3.3–3.9s（`docs/test-report.md:327`）。结果是：普通 `git status`/`npm test` 完全不产生 tab、不弹面板、无提示；即使命令跑 30s，前 4.5s 也没有实时进度。POSIX bash 启动快，<4.5s 全被吞——同一个默认值在两个平台语义不同。空态还写着“agent 执行的命令会自动出现在这里”（`locale.ts:25`），与默认行为矛盾。

建议：
- 计时改为“shell 就绪后”开始（会话已记录首次静默），默认降到 **1200–1500ms**；
- 隐藏命令不再完全无痕：状态栏显示“刚执行了 N 条短命令（已隐藏）”入口，可打开历史；
- 首启引导明确“短于 X 秒的命令默认不上屏（可配置）”。

**P0-U2 命令结束即静默自毁，而且失败比成功关得更快。**
成功 5s、失败 2s（`registry.js:590-607`），**正在看也照关**（README:97），关闭后内容不可恢复。用户实际“读不到刚结束命令的完整输出”；失败时最需要读错误，窗口却最短；成功默认连 toast 都没有（`autoCloseNotice: 'failed'`）。关闭失败命令的 toast 只含最后一行、最多 79 字符、4s 消失且不可点不可复制（`Panel.tsx:249-253`）。

建议（P0）：
- 命令退出后显示**倒计时 + [保留] [立即关闭]**（1s 刷新）；悬停、tab 选中、终端内滚动/输入任一发生即暂停并转“保留”；
- 失败默认 **不自动关**（或 ≥30s）；
- host 增加 `POST /keep`（取消 timer 并转保留区）与**最近命令历史**（保留最近 20 条元数据 + 尾部文本，只读快照页签，可复制/搜索）；
- toast 改成可点击“查看输出/重新运行”，不要 `pointer-events:none`。

**P1-U3 失败通知与面板是否挂载耦合。**
notice 只走全局 SSE，只有挂载的 Panel 订阅（`Panel.tsx:244-301`）；AutoOpenWatcher 只处理 `sessions`（`index.tsx:119-131`）。侧栏收起/页签关掉后，失败命令（尤其被阈值隐藏的）**零反馈**；notice 发出后会话立即 `close`，内容不保留。

建议：在 root `shell.overlay` 的 watcher 里同时消费 notice，通过 DSH 全局 toast/notification 服务发可点击通知；点击打开面板并定位。

**P1-U4 自动打开“每页面一次”，且首次失败不重试。**
`autoOpenConsumed` 模块级（`index.tsx:34`），`start()` 里 list 失败直接 return（`index.tsx:119-132`）。页面加载时 host 未就绪/网络抖动 → 本页面自动打开永久失效；用户关过一次面板后再也不自动出现，且无提示。建议改为“每个 DSH 会话一次 + 记住用户是否手动关闭 + 失败重试”，并在 guide 里保留手动入口。

**P1-U5 选择跟随不完善。**
新命令会自动选中（`Panel.tsx:308-315`），但“钉住”只认 pointerdown/输入/点 tab，**滚轮阅读不会钉住**（`TerminalView.tsx:406`），agent 下一条命令会把画面抢走；钉住后又没有“有新命令”角标，用户容易漏看。建议状态栏加“自动跟随/固定”图钉（localStorage），固定时新命令显示未读点 + “跳转到最新命令”；滚轮滚动也视为固定；当前 tab 被自动关闭时保留最后画面并给出“已结束”提示。

### 2.2 终端应有的高频操作缺失（用户会按普通终端预期使用）

- **选中复制**：无 `attachCustomKeyEventHandler`/选区复制；xterm 画布不是 DOM 选区，右键无复制，`Ctrl+Shift+C` 无效，`Ctrl+C` 直接发 SIGINT。目前只能整屏复制（相机按钮）。→ 增加 Ctrl+Shift+C 复制选区、右键菜单（复制/粘贴/全选/查找）、`Ctrl+Shift+V` 粘贴。
- **查找**：无搜索（`@xterm/addon-search` 即可）；长日志/回滚场景必需。→ `Ctrl+F` 搜索条，高亮/上下/计数。
- **页签管理**：只有关闭；无重命名/固定/关闭全部已结束/溢出菜单；多个 agent 交互终端和用户终端都叫 `PowerShell`（`registry.js:1020-1025`），无法区分；关闭热区 16×16（`styles.ts:146-163`）。→ 双击重命名、owner/kind 徽标、`»` 溢出菜单、“关闭全部已退出”、活动 tab `scrollIntoView`。
- **刷新 ≠ 重连**：`refresh` 只重拉列表（`Panel.tsx:439-441`），`reconnect` 才重建流（432-437）；按钮纯图标，用户只能试。→ 合并为“重新同步”，按状态自动选择；连接正常时隐藏 reconnect。
- **快捷键**：面板没有任何快捷键（`index.tsx:26` 未 inject shortcuts）。→ `Ctrl+Shift+\`` 打开/聚焦、`Alt+T` 新建、`Alt+1..9` 切页签、`Alt+W` 关当前、`Ctrl+Tab`/`Ctrl+PageUp/Down`，并在按钮上加 `aria-keyshortcuts`。
- **首次引导**：建议一次性提示“已启用；agent 命令会显示；短命令默认隐藏；以本机权限运行（不套沙箱）”，可“不再提示”。guide 描述与空态文案统一。

### 2.3 其它交互缺陷（P2，值得顺手修）

- **空态单帧闪烁**：有会话但选中修正 effect 完成前会走一次“暂无终端会话”分支（`Panel.tsx:661-707`）。
- **关页签 vs 自动关闭竞态**：5s 末点 ×，host 已 close → `/close` 返回 404 → toast“关闭终端失败”（`Panel.tsx:424-427`），与用户意图相反。
- **容量失败文案**：`maxSessions` 满时直接拼英文异常（`registry.js:735-737`），无“关一个再试”动作。
- **错误分类/文案**：host 未就绪实际返回 503（`routes.js:96-99`），但 `describeListError` 只把 404/网络当 host 未就绪（`Panel.tsx:65-72`）；文案让用户“重启 dev host”（`locale.ts:28-29`），对 npm 安装用户是开发者口径。`termError` 是死代码：`TerminalView` 从不传非空错误（只有 `onError(null)`，`TerminalView.tsx:326`），错误覆盖层不可达。
- **状态栏误导**：已退出会话仍显示“实时连接”（指 SSE 而非进程，`Panel.tsx:763-765`）；退出码直接贴在 tab 标题后（截图里像命令的一部分）。
- **多面板实例**：`multiple: true`（`index.tsx:189`）可再开一个终端面板页签，两个实例选择/滚动不同步，且对同一会话重复 fit/resize。
- **面板内无配置入口**：看不到生效值（阈值/自动关闭/shell），出问题时无法解释。→ `GET /config` + 齿轮/“⋯”面板显示生效配置与来源，提供“复制配置片段”。

---

## 3. 界面 UI / 视觉 / 无障碍

### 3.1 最大问题：三层标签 + 重复标题

现状（1440×900 实测/截图）：

```
┌ DSH 标签条：[终端面板 ×] [+]                         [分屏][全屏][收起] ┐ 39px
├──────────────────────────────────────────────────────────────────────────┤
│ [+新建终端] 终端面板                        ↻   ⟳   📷   ×              │ 36px  ← 标题重复、4 图标、2px gap
├──────────────────────────────────────────────────────────────────────────┤
│ ● PowerShell ×   ● PowerShell ×   ● Write-Output intercept… ×             │ 35px  ← 二级 tab、220px 截断
├──────────────────────────────────────────────────────────────────────────┤
│ (base) PS C:\...\lancang>  ... xterm ...                                 │
├──────────────────────────────────────────────────────────────────────────┤
│ ● 已退出（0）              86x50  实时连接 ●                             │ 22px  ← 状态重复
└──────────────────────────────────────────────────────────────────────────┘
```

- 标题“终端面板”出现 3 次：DSH 标签条、面板工具栏、guide；创建入口 3 个：工具栏、空态、guide（外加 DSH 标签条 `+`，但语义不同）。
- 面板内 chrome（工具栏+tab 条+状态栏）≈93px；含 DSH 标签条约 132px，占 900px 的 14.7%。官方侧栏终端同位置约 55–63px，且状态条只在异常时出现。
- 窄栏溢出：工具栏无 wrap/overflow（`styles.ts:23-30`），按 12px 字体估算中文 ≈279px、英文 ≈335px 即溢出；截图 `02-screenshot.png` 已有第 4 个 tab 被右缘裁切。
- 屏幕上最多出现 4 个 ×（DSH 标签 ×、工具栏 ×、两个 tab ×），且复制按钮与破坏性关闭 × 仅隔 2px（`Panel.tsx:552-584`、`styles.ts:26`），误点即杀进程。

### 3.2 推荐布局（二选一）

**方案 A（过渡，省 ~58px）**：去掉工具栏标题与 4 个图标；新建并入会话行末尾的 `+`；其余动作收进 `⋯`；当前会话名通过 `sidebar.right.pane.tab.title` seat 显示到 DSH 标签；状态栏正常时隐藏。

```
┌ DSH 标签条：[>_ PowerShell · 运行中 ×] [+]      [分屏][全屏] ┐ 39px
├──────────────────────────────────────────────────────────────┤
│ [● PowerShell ×][● qa-exit ×][+]                       [⋯]   │ 32px
├──────────────────────────────────────────────────────────────┤
│  xterm  (padding 8px)                                        │
├──────────────────────────────────────────────────────────────┤
│ ⚠ 已断开 [重新连接]                                          │ 仅异常时 28px
└──────────────────────────────────────────────────────────────┘
```

**方案 B（推荐，省 ~65px，可扩展到 16 会话）**：会话 tab 换成 28px 的“会话切换器”：`[● 当前会话 ▾] [+ 新建] [⋯]`，▾ 用 DSH primitives Menu 列出全部会话（状态/退出码/cwd）。单会话时只显示 `● 名称 · 状态`。窄栏天然不溢出。

同时把动作放回 DSH 原生位置：`sidebar.right.pane.tab.title` 显示当前会话名，`sidebar.right.tab.menu.item` 放“复制屏幕文本/重新连接/结束终端”，用 `@deepseek-ai/dsh-client-ui-primitives` 的 Button/Menu 获得一致的 hover/focus/ARIA（官方终端已这么做）。

### 3.3 具体 UI/无障碍问题（P1）

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| U-1 | 活动 tab 几乎不可辨：浅色下只有 1.26:1 的边框 | `styles.ts:127-131` | 用 `interactive-bg-active` + `border-l3` + 2px accent；状态加图标/文字 |
| U-2 | 11px 灰字 3.71:1，正文 AA 不达标 | `styles.ts:141-145,240-247,290-296` | 改 12px + `label-secondary`；11px 只留装饰 |
| U-3 | running 6px 绿点对白 2.28:1，且只靠颜色 | `styles.ts:171-186` | 8px 点 + 文本/形状；tab 加 `aria-label="名称，运行中"` |
| U-4 | 断线/错误用不透明全屏 overlay **盖住最后屏幕**，且无焦点管理 | `Panel.tsx:709-740`、`styles.ts:251-268` | 改成保留屏幕的顶部/底部状态条 + 重连按钮；只保留一个 `role=alert`；重连后 `controller.focus()` |
| U-5 | 切 tab/关 tab 后不聚焦 xterm；xterm 无 focus ring | `Panel.tsx:402-405,414-430,497-518`、`TerminalView.tsx:401-408` | 选中/新建/关闭后 `requestAnimationFrame(focus)`；`.dshtp-screen:focus-within` 显示 focus ring；自动切换不抢焦点 |
| U-6 | 新建后白屏，无 connecting 状态 | `06-xterm-created.png`；`TerminalView.tsx:279-399` | TerminalView 暴露 `connecting/ready`，2s 内显示轻量 spinner/“正在连接 Shell…”；列表 skeleton + `aria-busy` |
| U-7 | 会话 tab 溢出无提示、活动 tab 不自动滚入、4px 滚动条几乎不可见 | `styles.ts:87-104`、`Panel.tsx:587-652`、截图 02 | `scrollIntoView({inline:'nearest'})`；两端 mask 渐隐；8px 滚动条 + `scrollbar-gutter:stable` |
| U-8 | tab 内嵌 `<button>`（嵌套交互元素）；关闭 label 不含会话名；非活动 tab 关闭 `tabIndex=-1` 不可达；xterm textarea 无 aria-label | `Panel.tsx:595-650,635-647`、`TerminalView.tsx` | tab 用 button + sibling close；label 带会话名；支持 Delete 关闭；`terminal.textarea.setAttribute('aria-label','终端输入')` |
| U-9 | 窄栏工具栏溢出，关闭按钮被裁 | `styles.ts:23-44`、截图 02 | `container-type:inline-size` + `@container (max-width:340px)` 隐藏 title/图标化；标题 `flex:1;min-width:0` |

### 3.4 P2 视觉细节

- **图标语义**：相机图标实为“复制屏幕文本”（`Panel.tsx:563-573`、`locale.ts:19`），README 又叫截图；`screenshot` locale 键完全未使用。refresh/reconnect 两个转圈箭头 14px 难分；均只有原生 `title` tooltip。→ 相机改剪贴板图标；reconnect 只在断线时出现；refresh 收进 `⋯`；用 DSH 风格 tooltip。
- **guide 图标重复**：DSH 官方“新建终端”与本插件“终端面板”两张卡都用同一蓝色 `>_` artwork（`index.tsx:198`）。→ 换 distinct 图标（终端+眼睛/agent 标记），标题可改“Agent 可见终端”。
- **状态栏冗余**：`● 已退出（0）` 点+文字重复；`86x50 实时连接 ●` 又有第二个传输状态点；`86x50` 属开发信息。→ 正常时隐藏整条；异常时一行“● 运行中 · cwd”+ 重连；尺寸放 tooltip；删列表 SSE 点。
- **字体/间距**：11/12/13 混用；`theme.ts:29` fallback 12 而 DSH 默认 terminal 13；用户字体列表未追加等宽栈（官方会追加）；padding 6/4/6/8 不对称；三条 0.5px hairline；关闭按钮 16×16 < WCAG 2.5.8 的 24×24。→ 13/12 两级、8px 栅格、统一 radius、关闭热区 24×24。
- **toast**：右上角绝对定位覆盖输出第一行（截图 12），1.8s/4s 自动消失，失败 notice 不可暂停/关闭。→ 移到 body 底部/状态栏上方，最多 2 行，失败 ≥8s 或手动关闭；`aria-atomic="true"`。
- **布局抖动**：无会话 → 有会话时 tab 条出现/消失（35px），首个命令结束自动关闭后又消失，xterm 被 fit 两次。→ 固定 tab 条高度或稳定占位。
- **深色/光标/滚动条未验证**：13 张 QA 截图全浅色；`09-resized.png` 与 `08-xterm-chinese.png` 哈希相同（resize 实际未体现）；`theme.ts:202-235` 未处理 OSC 覆盖/cursor 对 cell 背景 3:1；`styles.ts:206-216` 强制 viewport 透明。→ 补深色/高对比截图；`.dshtp-screen` 加背景色；cursor 3:1；滚动条 hover token。
- **reduced-motion / RTL / IME**：无 `prefers-reduced-motion`（`cursorBlink:true` 常开）；RTL 用 physical `right`；当前无自绘输入框，但未来重命名输入需 `isComposing` 保护。→ 低优先级顺手做。

---

## 4. 与竞品的定位（简表）

| 能力 | 本插件 v1.2 | 官方侧栏终端 | 官方 persistent terminals | @hyzyn/dsh-tty | dsh-bash-terminal-ts |
|---|---|---|---|---|---|
| 可见面板 | ✓ | ✓ | ✗ | ✓ | ◐ 需 better-sidebar |
| 接管默认 shell | ✓ pwsh/bash | ✗ | ✗ | ◐ 自己的 tty_run | ✓（受沙箱） |
| agent 工具面 | 7 个 | ✗ | 6 个 | 9+ 个 | shell+terminal |
| 文本截屏 | ✓ | ✗ | read 分页 | ✓ screen/capture | ✗ |
| 图像截屏 | ✗ | ✗ | ✗ | ✗ | ✗ |
| wait/exit/expect | 仅 run(wait) | 退出码 UI | background job | ✓ expect | ✓ foreground/job |
| signal/resize/keys | close only | ✗ | signal | keys（无 signal 工具） | signal ✓ |
| 重命名/搜索/复制 | ✗ / ✗ / 整屏 | ✓ rename | ✗ | ✓ search/link | ✗ |
| cwd 跟随/持久化 | 初始 cwd / Host 重启丢 | 页面刷新恢复 | Host 不恢复 | tmux 持久化 | idle 自动关 |

**结论**：并集优势仍在“可见 + 接管默认 shell + 文本截屏”；差距集中在 **agent 控制面**（wait/signal/keys/exec）和**终端基础体验**（复制/搜索/重命名/多端/链接）。不需要重写架构，补齐即可。

---

## 5. 优先级路线图

### 5.1 建议先做的 8 件事（按顺序）

| # | 改动 | 价值 | 成本 | 版本建议 |
|---|---|---|---|---|
| 1 | 修 `live_terminal_open` 默认终端映射 + F-4/F-6/F-7 小修 | 消除“按文档用会翻车” | S | 1.2.1 ✅ |
| 2 | 自动关闭倒计时 + 悬停/选中暂停 + [保留]；失败默认不关/30s；`POST /keep` | 解决最大用户痛点 | M | 1.2.1 ✅ |
| 3 | `interceptMinVisibleMs` 改为 shell-ready 后计时，默认 1200–1500ms；隐藏命令计数入口 | 让“可见”真正发生 | S | 1.2.1 ✅ |
| 4 | 最近命令历史（host ring + 只读快照页签） | 根治“关了就看不到” | M | 1.2.1 ✅ |
| 5 | 全局失败通知（不依赖 Panel 挂载）+ 可点击 toast | 侧栏收起也不丢反馈 | S–M | 1.2.1 ✅ |
| 6 | 选中复制 / 右键菜单 / `Ctrl+F` 搜索 / 页签 scrollIntoView | 终端变成“可日用” | M | 1.2.1 ✅ |
| 7 | 工具栏/标题/状态栏重构（方案 A/B）+ 焦点管理 + 对比度 | 省 60px、去误触、达 AA | M | 1.2.1 ✅ |
| 8 | agent 工具面：wait/status/signal/resize/read 分页+search/keys/expect/exec + run 参数 | 打开控制面能力上限 | M–L | 1.2.1 ✅ |

### 5.2 1.2.1 落地结果

按用户要求，评审中的**全部内容统一归入一个 1.2.1 版本**（不再拆分 1.3/1.4）：

- **功能与 host**：open 默认终端、描述/结果字段、自动关闭倒计时/保留/暂停、最近命令历史（LRU + 落盘）、shell-ready 阈值、全局通知、工具面（wait/status/signal/resize/read 分页/search/expect/send.keys/exec/rename/history/export）、run/open 的 cwd/shell/cols/rows/env、PNG/ANSI 截图、多端输入租约、回放/导出、端口检测/可点击链接、每 DSH 会话配额、沙箱标注与 `requireSandbox`。
- **界面**：紧凑会话条 + `⋯` 菜单 + 跟随开关；页签重命名/保留/关闭已结束/自动滚入；选中复制、右键菜单、`Ctrl+F` 搜索、粘贴；焦点管理、错误横幅、连接态、对比度/命中区/深色/窄栏/reduced-motion；首次引导与全局 Toast。
- **配置/文档/测试**：`GET /config` 与面板设置；README/architecture/test-report 统一 1.2.1；新增 host 测试覆盖历史/按键/端口/租约/新工具/新路由。
- 实现契约见 [`impl-1.2.1-contract.md`](./impl-1.2.1-contract.md)，验证结果见 [`test-report.md`](./test-report.md) 的 1.2.1 章节。

### 5.3 建议补的测试/验收

1. **单测**：`live_terminal_open → send/read（不带 id）` 命中同一终端；`wait:false` 超 5s 后 `status/read` 命中缓存；auto-close 倒计时暂停/保留；隐藏命令计数；notice 无 Panel 时的全局消费。
2. **e2e**（现有 `tools/verify-ui.mjs`/QA 扩展）：短命令（<1.5s）不产生 tab；2s 命令产生并显示；命令结束倒计时可见、点“保留”后不关；断线保留屏幕而非全屏遮罩；活动 tab 滚入视野；Ctrl+F 搜索；复制选区；深色主题与 320px 窄栏截图。
3. **截图基线**：补深色 + 窄栏 + 多会话（≥8 个）三组；`09-resized.png` 与 `08` 哈希相同说明 resize 断言失效，需要真实 resize 前后尺寸断言。

---

## 6. 证据与代码索引

- 工作流：`client-src/Panel.tsx`、`client-src/index.tsx`、`client-src/TerminalView.tsx`、`lib/host/registry.js`、`README.md`
- agent 工具：`lib/host/tools.js`、`lib/host/routes.js`、`lib/host/session.js`、`lib/host/shell.js`、`lib/host/intercept.js`、`lib/host/wrapper.js`、`lib/index.js`
- UI：`client-src/styles.ts`、`client-src/theme.ts`、`client-src/icons.tsx`、`client-src/locale.ts`
- 文档：`docs/architecture.md`、`docs/test-report.md`、`README.md`
- 竞品快照：`research/existing-plugins.md`、`research/sources/official/*`、`research/sources/extracted/*`
- 截图：`docs/screenshots/01-04`、`qa/artifacts/2026-10-19T10-15-44-399Z/*`、`tools/artifacts/v12-client-notice-toast.png`

> 说明：本报告是基于源码与现有截图的静态评审；个别 UI 对比度为按 token/截图像素计算，运行态（尤其深色、窄栏、多标签页并发输入）建议按 §5.3 补验。
