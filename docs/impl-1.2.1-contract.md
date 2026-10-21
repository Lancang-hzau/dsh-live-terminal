# dsh-live-terminal 1.2.1 实现契约（内部工作文档）

> 本文件是 v1.2.1 并行实现的唯一接口契约。所有新增能力统一归入 **1.2.1**，不再拆分 1.3/1.4。
> 工作方式：按文件写作用域并行；本契约是跨作用域的唯一事实来源。若实现需要偏离，先改本文件并在任务消息中说明。

## 0. 版本与交付

- `package.json` version = `1.2.1`；README、docs、客户端构建注入版本、`lib/client.js` 全部一致。
- 发布内容：host 代码、`lib/client.js` 构建产物、测试、README/架构/测试报告、`docs/review-2026-10-21-ux-feature.md` 引用的全部建议均落到 1.2.1。
- 验收：`npm test` 全绿、`npm run typecheck` 通过、`npm run build` 产物更新、最终 diff 由 Lead 复核。

## 1. 配置（`resolveConfig`，lib/index.js）

旧键保留兼容，新键生效；README 只写 1.2.1 的最终值。

| 键 | 默认 | 说明 |
|---|---|---|
| `interceptShellTools` | true | 拦截内置 pwsh/bash 前台命令 |
| `shellPath` | undefined | 交互 shell 覆盖 |
| `scrollback` | 2000 | 终端回滚行数 |
| `maxOutputBytes` | 262144 | 单会话保留输出字节 |
| `maxSessions` | 16 | 全局会话上限 |
| `perSessionMaxSessions` | 8 | 同一 DSH 会话的命令+交互终端上限；超出时优先回收已退出的 |
| `commandTimeoutMs` | 180000 | run(wait) 默认超时 |
| `retainExited` | 10 | **兼容旧键**，等价 historySize 的会话保留数（已退出但未关闭） |
| `historySize` | 20 | 最近关闭命令历史条数（LRU，落盘） |
| `historyPath` | `<homedir>/.dsh/dsh-live-terminal/history.json` | 历史持久化路径；空串禁用 |
| `interceptMinVisibleMs` | 1500 | **从 shell ready（首帧输出）起计时**；0 = 全部上屏 |
| `autoCloseCommandDelayMs` | 8000 | 成功命令自动关闭延迟；-1 = 永不 |
| `autoCloseFailedDelayMs` | 30000 | 失败/超时命令自动关闭延迟；-1 = 永不 |
| `autoCloseToolTerminals` | true | 是否自动关闭 tool 创建的终端 |
| `autoCloseNotice` | 'all' | failed / all / none；success 通知主要用于历史角标 |
| `requireSandbox` | false | true 时：当前 DSH 沙箱 mode != danger-full-access 则拦截回退原生工具，agent 创建终端报 SANDBOX_REQUIRED |
| `allowUnconfined` | true | agent 终端未套沙箱是否允许（配合 requireSandbox 与 UI 徽标） |
| `historyPersist` | true | 是否落盘历史 |
| `portDetection` | true | 是否从输出检测 localhost URL |

Sandbox 语义：`spawnTerminal` 本身不支持 DSH 文件沙箱；v1.2.1 不伪装沙箱，而是**如实标注 + 可强制**：
- `SessionInfo.sandbox = { mode: 'read-only'|'workspace-write'|'danger-full-access', confined: false, required: requireSandbox }`；
- 所有工具结果带 `sandbox`；
- UI 状态栏对 `mode!=='danger-full-access'` 显示「未沙箱」徽标与说明；
- `requireSandbox:true` 时按上表回退/拒绝。

## 2. SessionInfo（host 与 client 共用）

在现有字段上新增（全部可选，旧客户端可忽略）：

```ts
type PortInfo = { url: string; port: number; host: string; firstSeenAt: number; lastSeenAt: number }
type SandboxInfo = { mode: string; confined: boolean; required: boolean }
type SessionInfo = {
  id, title, kind: 'command'|'interactive', owner: 'agent'|'user', sessionId?, agentId?, command?,
  cwd, cols, rows, state: 'running'|'exited'|'failed', exitCode: number|null, error?,
  createdAt, updatedAt,
  signal: string|null
  startedAt: number
  endedAt: number|null
  durationMs: number|null
  shellKind: string
  ports: PortInfo[]
  sandbox: SandboxInfo
  autoCloseAt: number|null     // epoch ms；null = 不自动关
  autoClosePaused: boolean
  pinned: boolean              // 用户点了“保留”
}
```

### 历史记录（closed command）

```ts
type HistoryEntry = {
  id: string                  // 记录 id（= 原 terminalId）
  title: string
  command: string
  cwd: string
  kind: 'command'
  exitCode: number|null
  signal: string|null
  startedAt: number
  endedAt: number
  durationMs: number
  cols: number
  rows: number
  reason: 'auto-close'|'closed'|'failed'
  text: string                // 尾部纯文本，≤64KB
  truncated: boolean
  ports: PortInfo[]
  sandbox: SandboxInfo
  agentId?: string            // 写入时记录；agent 工具按此过滤
  sessionId?: string
  owner?: 'agent'|'user'
}
```

## 3. HTTP / SSE 契约（`/dsh-terminal-panel`）

所有请求走 `ctx.connection.admit`；JSON 错误 `{ error, code? }`。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/config` | — | `{ version, config, sandbox: {mode}, shell: {kind,path} }`（只读生效值） |
| GET | `/sessions?sessionId=` | — | `{ sessions }`（可按 DSH sessionId 过滤） |
| GET | `/snapshot?id=` | — | `{ info, screen, text, cursor, seq, writerClientId }` |
| GET | `/events?id=&clientId=&fromSeq=` | — | SSE：`snapshot`/`output`/`state`/`exit`/`capture-request`/`notice`；`fromSeq` 时先补 `replay` 帧 |
| GET | `/events` | — | 全局 SSE：`sessions` + `notice` |
| GET | `/history?limit=&terminalId=` | — | `{ entries: HistoryEntry[] }` |
| GET | `/replay?id=&fromSeq=` | — | `{ frames: [{seq,chunk}], nextSeq }` |
| GET | `/export?id=&format=text\|ansi` | — | `text/plain` 附件下载（`Content-Disposition`） |
| POST | `/create` | `{ cols?,rows?,title?,sessionId?,cwd?,shell? }` | `{ session }`（用户终端） |
| POST | `/input` | `{ id, data, clientId }` | `{ ok:true }`；非 writer → 409 `{code:'READ_ONLY'}` |
| POST | `/resize` | `{ id, cols, rows }` | `{ ok:true }` |
| POST | `/close` | `{ id }` | `{ ok:true }`（退出会话进入历史） |
| POST | `/keep` | `{ id }` | `{ ok:true, info }` 取消自动关闭并 pinned |
| POST | `/auto-close` | `{ id, action:'pause'|'resume', reason? }` | `{ ok:true, info }` |
| POST | `/rename` | `{ id, title }` | `{ ok:true, info }` |
| POST | `/take-control` | `{ id, clientId }` | `{ ok:true, writerClientId }` |
| POST | `/signal` | `{ id, signal }` | `{ ok:true, delivered }` |
| POST | `/capture` | `{ id, requestId, dataUrl, width?, height? }` | `{ ok:true }`（PNG 回传；body 上限 8MiB、decoded 4MiB） |
| GET | `/ping` | — | `{ ok:true, plugin, version, sessions }` |

SSE `notice` 类型扩展（保持 `auto-close` 兼容）：

```ts
type Notice =
  | { type:'auto-close'; reason:'failed'|'succeeded'; terminalId; historyId?; title; exitCode; signal; excerpt; durationMs }
  | { type:'command-finished'; terminalId; title; exitCode; signal; durationMs; keepOpen:boolean }
  | { type:'port'; terminalId; url; port; host }
  | { type:'capture-request'; terminalId; requestId }
```

## 4. 客户端模块契约

### 4.1 `types.ts` / `api.ts`（ux-flow 所有）

- 上述 `SessionInfo/HistoryEntry/PortInfo/SandboxInfo/Notice` 类型；`ConfigInfo`。
- `clientId`：`localStorage['dsh-live-terminal.client-id']`，缺失时 `crypto.randomUUID()`。
- API 函数：`fetchConfig`, `listSessions({sessionId})`, `fetchHistory`, `fetchReplay`, `createSession({cols,rows,title,cwd,shell,sessionId})`, `sendInput(id,data,clientId)`, `resizeSession`, `closeSession`, `keepSession`, `setAutoClosePaused(id,paused)`, `renameSession`, `takeControl`, `signalSession`, `openSessionStream(id,{clientId,fromSeq,onSnapshot,onOutput,onState,onExit,onCaptureRequest,onOpen,onError})`, `openSessionsStream({onSessions,onNotice,onCaptureRequest})`, `postCapture`.
- 所有请求 10s 超时；409/503 带 code。

### 4.2 `Panel.tsx` 结构（ux-flow 所有；class 名固定）

```
<section class="dshtp-root">
  <div class="dshtp-chrome">
    <button class="dshtp-new" data-action="create" aria-label=... title=...>+</button>
    <div class="dshtp-session-strip" role="tablist">
      <div class="dshtp-tab" role="tab" data-active data-state data-pinned aria-selected>
        <span class="dshtp-dot"/>
        <span class="dshtp-tab-title"/>
        <span class="dshtp-tab-badge"/>         // 运行/shell/未沙箱/倒计时/未读
        <button class="dshtp-tab-keep"/>        // 图钉，仅 hover/active
        <button class="dshtp-tab-close"/>
      </div>
      ...
      <button class="dshtp-more" aria-label="更多操作">⋯</button>
    </div>
    <button class="dshtp-follow" data-follow="true|false"/>  // 跟随最新
  </div>
  <div class="dshtp-body" role="tabpanel">
    <TerminalView/> | 空态/加载/错误 | 历史只读视图
    <div class="dshtp-banner" data-kind="error|warn|readonly"/>  // 断线/只读/未沙箱，不遮屏
    <div class="dshtp-toast" role="status"/>  // 面板内操作反馈（全局通知在 index.tsx）
  </div>
  <div class="dshtp-statusbar">…（正常状态隐藏，异常/悬停显示）</div>
  <div class="dshtp-menu" role="menu"/>        // ⋯ 弹出
  <div class="dshtp-dialog" role="dialog"/>    // 配置/历史/快捷键帮助
</section>
```

### 4.3 `index.tsx`（ux-flow 所有）

- `inject` **不包含** `shortcuts`：实测注入 DSH shortcuts 服务会与 `page.close` 及保留键冲突，并导致 `uiWorkspace` 客户端启动失败；v1.2.1 改为面板局部 keymap（`Ctrl+Shift+\``/`Ctrl+Alt+T`/`Ctrl+Alt+Shift+W`/`Ctrl+Alt+F`），不占用全局注册表。
- 命令：`open` / `new` / `close` / `follow`；通过 `window` CustomEvent `dsh-live-terminal:command` 通知已挂载 Panel；未挂载时先 `sidebarRight.openTab` 再延迟 dispatch（最多 4 次）。
- 全局 `shell.overlay` watcher 改为渲染 `<GlobalNotice/>`：订阅全局 SSE（sessions+notice），提供：
  - 失败命令 Toast（可点击「查看历史/打开面板」，8s 后自动消失，可关闭）；
  - capture-request 不在这里处理；
  - 自动打开规则：每个 DSH sessionId 首次 agent command 打开一次（`autoOpenBySession`），失败重试 3 次退避；用户手动关闭后该 session 不再自动打开。
- 首次使用引导：localStorage `dsh-live-terminal.welcome.v1`，一次性提示（含“未套沙箱”说明）“不再提示”。

### 4.4 `TerminalView.tsx`（ux-flow 所有）

- addons：`FitAddon` + `SearchAddon` + `WebLinksAddon`（链接点击 `window.open`）+ `Unicode11Addon`（`terminal.unicode.activeVersion='11'`）。
- `TerminalController` 扩展：`focus`, `fit`, `getVisibleText`, `getDimensions`, `getSelection`, `selectAll`, `clear`, `findNext`, `findPrevious`, `clearSearch`, `search`, `savePng`, `paste`, `copySelection`。
- 键盘：`attachCustomKeyEventHandler` 拦截 `Ctrl/Cmd+F`（搜索）、`Ctrl/Cmd+Shift+C`（复制选区）、`Ctrl/Cmd+Shift+V`（粘贴）、`Ctrl/Cmd+Shift+F`（搜索）；其余交给 PTY。
- 右键菜单：复制/粘贴/全选/查找/清屏（自定义 DOM `.dshtp-context-menu`）。
- 连接态：`onReady(ready)`；首帧前显示 `.dshtp-connecting` skeleton/spinner。
- `onError(message)` 真实错误（snapshot 失败/流异常），供 banner 使用。
- capture-request：收到 `capture-request` 后调用 `savePng()` 生成 dataURL，`postCapture(id,requestId,dataUrl)`；失败 POST 错误上报。
- 滚动/滚轮触发 `onUserActivity`（用于固定选择）；`onSelectionChange` 上报选区状态。
- 主题：新增 `observeTheme` 已支持；光标/选区与 `readTerminalTheme` 对齐；`prefers-reduced-motion` 关闭 cursorBlink。
- 端口链接：注册 xterm link provider，匹配 `http(s)://...` 与 `localhost:port`；点击 `window.open`。

### 4.5 `styles.ts` / `icons.tsx` / `locale.ts` / `theme.ts`（ui-visual 所有）

- 实现 §4.2 所有 class；窄栏 `@container (max-width: 340px)` 隐藏标题/文字按钮；工具栏高度 ≤32px；状态栏正常隐藏（`.dshtp-statusbar[data-visible=false]{display:none}`）；颜色对比达 AA（见 review §3.3）；关闭热区 ≥24×24。
- 图标新增：`IconClipboard`, `IconSearch`, `IconChevron`, `IconPin`, `IconHistory`, `IconSettings`, `IconMore`, `IconClear`, `IconExport`, `IconPause`, `IconPlay`, `IconMaximize`, `IconKeyboard`, `IconSandbox`, `IconLink`。
- locale 新增键（中英）：
  `newTerminalShort`, `more`, `followLatest`, `following`, `pin`, `unpin`, `pinned`, `rename`, `renamePrompt`, `search`, `searchPlaceholder`, `searchNoResult`, `searchResult`, `copySelection`, `paste`, `selectAll`, `clearScreen`, `history`, `historyEmpty`, `historyHint`, `reopen`, `viewHistory`, `autoCloseIn`, `autoCloseNow`, `keepOpen`, `keepOpenHint`, `paused`, `unread`, `sandboxBadge`, `sandboxHint`, `readonlyBadge`, `takeControl`, `takeControlHint`, `reconnect`, `reconnecting`, `connectingShell`, `connectionLostScreenKept`, `hostNotReadyShort`, `config`, `configTitle`, `configCopy`, `configCopied`, `configHint`, `shortcuts`, `shortcutHelp`, `welcomeTitle`, `welcomeBody`, `welcomeDontShow`, `welcomeOpen`, `failedCommand`, `viewTerminal`, `dismiss`, `closeAllExited`, `closeOthers`, `exportText`, `maximize`, `notSandboxedTitle`, `notSandboxedBody`, `exitedShort`, `runningShort`, `connectingShort`, `shellLabel`, `sizeLabel`, `cwdLabel`, `sessionCountShort`, `noSelection`.
- theme：`FONT_SIZE` fallback 13；字体列表追加 `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`；cursor 对 cell 背景 ≥3:1；`prefers-reduced-motion` 支持。

## 5. Host 模块契约

### 5.1 `session.js`（feature-gap）

新增字段/方法（现有 API 不破坏）：

```js
// fields
signal, startedAt, endedAt, durationMs, shellKind, sandbox, keepOpen,
ports: Map<string, PortInfo>, writerClientId, autoCloseAt, autoClosePaused, pinned
firstOutputAt
// methods
setTitle(title)                        // 广播 state，registry onChange
setKeepOpen(value)
pauseAutoClose(reason) / resumeAutoClose()
signal(name) -> Promise<{delivered:string}>   // SIGINT 写 \x03；其余 terminate()
readLines({offset=0, lines=50}) -> { text, startLine, endLine, totalLines, truncated }
search({ pattern, regex=false, scope='all', maxResults=50, contextLines=0 })
framesSince(seq) -> [{seq, chunk}]
exportText(format='text'|'ansi') -> { text, bytes, truncated }
attachClient(clientId) / detachClient(clientId) / takeControl(clientId)
requestCapture({ timeoutMs=3000 }) -> Promise<{ buffer, width, height }>
resolveCapture(requestId, { buffer, width, height })
```

- 首帧输出回调 `options.onFirstOutput`（registry 用来启动可见性计时）。
- 输出处理中：扫描端口（`portDetection`）、记录 frames ring（≤4MB）、更新 autoClose 倒计时字段由 registry 写。
- 订阅广播新增事件：`capture-request`；state 帧含 `writerClientId`。
- `terminate` 保持幂等；`dispose` 清理 capture 等待者。

### 5.2 `registry.js`（feature-gap）

新增/变更：

```js
createCommandSession({ command, cwd, shellKindHint, title, cols, rows, env, owner, agentId, sessionId, agent, signal, origin, keepOpen, requireSandbox })
createInteractive({ cwd, shellKindHint, title, cols, rows, env, owner, agentId, sessionId, agent, signal, startingDefault })
setDefaultTerminal(agentId, sessionId)
ensureAgentTerminal(agent, options)             // 复用逻辑不变；open 成功也走这里登记
keep(id) -> info
pauseAutoClose(id) / resumeAutoClose(id) -> info
setTitle(id, title) -> info
signal(id, name) -> { delivered }
history: CommandHistory                          // 见 history.js
historyList(limit, terminalId) -> HistoryEntry[]
resolveRecentForAgent(agent, options)            // options.prefer: 'active'|'command'|'any'，默认 active
resolveVisible(agent, terminalId, { writable? }) // 权限校验
perSessionCount(sessionId)
sandboxFor(agent) -> SandboxInfo
attachClient(id, clientId) / detachClient / takeControl / isWritable
requestCapture(id, opts)
resolveCapture(id, requestId, payload)
replay(id, fromSeq)
exportSession(id, format)
dispose()
```

- 可见性计时：命令会话创建时记录 `hideForMs`；在**首帧输出**后开始计时；若 4s 内无输出，从创建起算兜底。
- 自动关闭：`#scheduleAutoClose(id, delayMs)` 同时写 `session.autoCloseAt`；pause/keep 清 timer；`autoCloseNotice` 默认 all；关闭前若出现在活跃 subscriber（用户正在看）**不自动暂停**，由 client 主动 pause；失败默认 30s。
- 历史：任何 command 会话关闭（自动或手动/退出）都写入 `history.add(entry)`；`retainExited` 控制未关闭退出会话数量；历史 LRU historySize；持久化见 history.js。
- 容量：`maxSessions` + `perSessionMaxSessions`；超限先回收同 sessionId 的 exited/非 pinned 命令终端，再回收 agent 非默认交互终端，最后抛错。
- 沙箱：`sandboxFor(agent)` 通过注入的 `resolveSandboxPolicy(agent)` 返回；`requireSandbox` 时创建 agent 终端拒绝；编排由 tools/intercept 处理（registry 只提供信息/校验）。
- Notice：`command-finished`（每个非自动关闭命令退出时）、`auto-close`、`port`。
- 历史文件：`history.js` 负责 load/save（debounce 500ms，原子写 tmp+rename，忽略损坏并日志）。

### 5.3 `history.js`（feature-gap）

```js
class CommandHistory {
  constructor({ size=20, file, logger, persist=true })
  add(entry) -> entry
  list({ limit=50, terminalId } = {}) -> HistoryEntry[]
  get(id) -> HistoryEntry|undefined
  load() / save() / dispose()
}
```

### 5.4 `keys.js` / `ports.js` / `exec.js`（feature-gap）

```js
// keys.js
export function keySequence(name) -> string|undefined   // Enter/Tab/Shift+Tab/Esc/Backspace/Delete/Insert/Up/Down/Left/Right/Home/End/PageUp/PageDown/F1-F12/C-a..C-z
export function bracketPaste(text) -> string             // ESC[200~ ... ESC[201~
// ports.js
export function extractPorts(text) -> PortInfo[]
// exec.js
export async function execInSession(session, command, { timeoutMs, shellKind }) -> { exitCode, output, timedOut, durationMs }
```

- `exec.js` 复用 `wrapper.js` 的 marker 思路；pwsh 与 bash 两套包装；轮询 `session.plainText()` 25ms；不 terminate 会话；超时返回已捕获输出。
- 仅允许 agent 自己的交互终端；串行化（session 级互斥）。

## 6. 工具契约（Lead）

| 工具 | 参数 | 返回（value） | 备注 |
|---|---|---|---|
| `live_terminal_run` | `command`(必), `description`, `wait`=true, `timeoutMs`, `keepOpen`, `cwd`, `shell:'pwsh'\|'bash'\|'cmd'`, `cols`, `rows`, `env?` | `terminalId,title,cwd,output,exitCode,signal,timedOut,aborted,stillRunning,durationMs,truncated,ports,sandbox` | description 作为 title |
| `live_terminal_screenshot` | `terminalId`, `format:'text'\|'ansi'\|'png'`=text, `withScrollback`(兼容), `scrollback`, `maxBytes` | `terminalId,title,state,cols,rows,cursor,text,scrollback?,ansi?,image?,truncated,ports,sandbox,warnings` | png 需 client 在线，否则 warnings+text 回退 |
| `live_terminal_send` | `terminalId`, `text`, `submit`=true, `keys?:string[]`, `paste?` | `ok,terminalId,sent,keys` | 未知键名报错 |
| `live_terminal_read` | `terminalId`, `maxBytes`, `offset=0`, `lines?`, `format:'tail'\|'range'\|'all'`, `raw?` | `terminalId,state,text,truncated,startLine,endLine,totalLines,exitCode,signal,durationMs,ports` | 已关闭终端回退 history |
| `live_terminal_search` | `terminalId`, `pattern`, `regex?`, `scope`, `maxResults`, `contextLines` | `terminalId,matches,truncated,totalLines` | 只读 |
| `live_terminal_wait` | `terminalId`, `timeoutMs`, `pattern?`, `mode:'exit'\|'pattern'\|'either'` | `terminalId,state,exitCode,signal,durationMs,timedOut,matched,text,truncated` | 不杀进程 |
| `live_terminal_status` | `terminalId` | `terminalId,state,exitCode,signal,durationMs,running,title,kind,cwd,ports,sandbox` | history 回退 |
| `live_terminal_signal` | `terminalId`, `signal` | `ok,delivered,terminalId` | SIGINT 写 ETX；其余 terminate |
| `live_terminal_resize` | `terminalId`, `cols`, `rows` | `ok,cols,rows` | 仅 running |
| `live_terminal_expect` | `terminalId`, `pattern`, `timeoutMs`, `since` | 同 wait | wait 的别名语义 |
| `live_terminal_exec` | `terminalId`, `command`, `timeoutMs`, `echo?` | `terminalId,exitCode,output,timedOut,durationMs` | 在现有交互终端执行 |
| `live_terminal_list` | `{}` | `terminals,historyCount` | 只读、并发安全 |
| `live_terminal_history` | `limit`, `terminalId?` | `entries` | 只读、并发安全 |
| `live_terminal_open` | `title`, `cwd`, `shell`, `cols`, `rows`, `env?` | `terminalId,info` | 成功后 setDefaultTerminal |
| `live_terminal_close` | `terminalId` | `ok,historyId` | 退出会话写历史 |
| `live_terminal_rename` | `terminalId`, `title` | `ok,info` | |
| `live_terminal_export` | `terminalId`, `format:'text'\|'ansi'` | `terminalId,path?,text?,bytes,truncated` | 大于 100KB 落盘到 history 目录 |

- 所有只读工具 `isConcurrencySafe: () => true`。
- 渲染上限：`12KB / 6000 chars` 双上限；输出标注 truncated。
- 所有结果带 `sandbox`；`live_terminal_*` 对 agent 的可见性/可写性沿用现有规则。
- `description` 若提供则 title 使用；`screenshot` 默认目标 = 最近活跃可见会话（running 优先），其次最近 command。

## 7. 拦截器（Lead）

- `interceptShellTools` 且非 background/升权：按当前沙箱 policy：
  - `requireSandbox` 且 mode !== danger-full-access → `next()`；
  - 否则接管，会话 `sandbox` 标注 `confined:false`。
- 阈值计时按 registry shell-ready 规则。
- 失败回退保持。

## 8. 文件写作用域（并行）

| 角色 | 可写文件 |
|---|---|
| feature-gap | `lib/host/registry.js`, `lib/host/session.js`, `lib/host/history.js`, `lib/host/keys.js`, `lib/host/ports.js`, `lib/host/exec.js` |
| ux-flow | `client-src/Panel.tsx`, `client-src/TerminalView.tsx`, `client-src/index.tsx`, `client-src/api.ts`, `client-src/types.ts` |
| ui-visual | `client-src/styles.ts`, `client-src/icons.tsx`, `client-src/locale.ts`, `client-src/theme.ts` |
| Lead | `lib/host/tools.js`, `lib/host/routes.js`, `lib/host/prompt.js`, `lib/host/intercept.js`, `lib/index.js`, `README.md`, `docs/**`, `package.json`, `tests/**`, `tools/**`, `lib/client.js`（构建产物） |

禁止跨作用域写文件；需要接口变更先改本契约并通知 Lead。

## 9. 测试要求（Lead + 各 owner 提供可测纯函数）

- host 单测新增：history / keys / ports / exec / auto-close pause-keep / shell-ready 阈值 / open 默认终端 / tools 新 schema 与 render / routes config/history/keep/input-lease / per-session 容量 / sandbox 标注。
- client 解析器单测：notice 新类型、history、config、capture-request。
- e2e（已有 `tools/verify-ui.mjs`）扩展断言：紧凑 chrome、倒计时保留、搜索、历史、只读接管、深色与窄栏截图（若环境允许）。

## 10. 文档与版本统一

- README：功能、工具表、配置表、安全说明、已知限制全部按 1.2.1 重写；新增「1.2.1 变更」章节，**不再出现 1.3/1.4 版本号**。
- `docs/architecture.md`：更新工具/路由/会话契约与 §8 修订记录（1.2.1）。
- `docs/test-report.md`：新增 1.2.1 验证章节（测试数字、e2e、构建）。
- `docs/review-2026-10-21-ux-feature.md` 保留为评审输入；README 可链接。
- `lib/client.js` 由 `npm run build` 重新生成；`package-lock.json` version 同步 1.2.1。
