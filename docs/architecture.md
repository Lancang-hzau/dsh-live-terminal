# dsh-terminal-panel — 实现蓝图与接口契约

> 本文件是并行开发的唯一契约。Host 引擎、客户端 UI、QA 都必须按这里的路径、接口与事件格式实现；有异议先改本文件并在聊天中说明。

> **修订说明（v1.1，2026-10-19）**：本仓库已迁移为“仓库根即发布包”，包名与目录为 `dsh-live-terminal`；文中出现的 `packages/dsh-terminal-panel`、`packages/dsh-terminal-panel/lib/**` 等路径属于历史并行开发期写法，请按当前仓库根的 `lib/**`、`client-src/**`、`tests/**` 理解。v1.1 新增/调整的契约点（shell 方言、输出流失败、容量回收、`wait:false`、SSE 背压、客户端健壮性）见文末 §8。

## 1. 目标（用户需求）

1. 在 DSH Web GUI 中拉起可见的终端窗口（真实 PTY，可交互）。
2. DSH agent 执行的终端命令显示在这个终端窗口里，实时输出（看到进度，而不是等后台结果）。
3. DSH agent 能“截图”终端窗口当前内容（文本屏幕内容），并有一个工具把结果交给模型。
4. 代码只放在 `C:\Users\LANCANG\Desktop\Code\DSH Plugs\dsh-live-terminal`；不修改 `D:\DSH`。开发测试使用独立的 dev profile / dev host，不重启用户的 Desktop DSH。

### 1.1 用户已确认的决定（2026-10-19）

- 截图：**文本屏幕快照**（不做 PNG/图片给模型）。
- 内置 shell 命令：**开启接管**（`interceptShellTools: true` 默认），前台 pwsh/bash 调用自动显示在终端面板里；保持工具/审批流程不变，但命令按用户终端权限执行（不套 DSH 沙箱）。可通过配置关闭。
- 安装：开发完成后由 Lead 安装进 `~/.dsh/profiles/desktop`（Desktop profile），不改 `D:\DSH`；必要时让用户刷新页面/重启 DSH 生效。


## 2. 运行环境与路径

- DSH 版本：0.2.1-rc.2；Desktop GUI 当前 URL `http://127.0.0.1:58966`（不要动它）。
- 插件仓库：`C:\Users\LANCANG\Desktop\Code\DSH Plugs\dsh-live-terminal`（node/npm/pnpm 可用，网络可用）。
- 插件包：`packages\dsh-terminal-panel`（`name: dsh-terminal-panel`，link 安装进 dev profile）。
- dev profile：`C:\Users\LANCANG\.dsh\profiles\dev`（已安装本插件，package.json 的 `dsh.profile.bundles` 含 `dsh-terminal-panel`）。
- dev host 启动命令（在仓库根目录执行；端口 3101）：
  ```powershell
  & "D:\DSH\resources\runtime\cli\bin\dsh.cmd" --profile dev --no-open --port 3101
  ```
  启动日志打印 `dsh web: http://127.0.0.1:3101/?token=...`。重启 host 才会重新加载 host 半侧与 client bundle（client-modules 在启动时快照）。
- 打开 dev GUI 做 UI 验证：`node tools/verify-ui.mjs "<带 token 的 URL>"`（Playwright + 系统 Chrome；截图落在 `tools/artifacts`）。右侧栏快捷键：`Control+Shift+B`。
- 官方 SDK 提取目录（只读参考）：`C:\Users\LANCANG\AppData\Local\Temp\dsh-sdk\pkg\`（dsh-tools、dsh-terminal、dsh-tool-terminal、dsh-api-terminal-controller、dsh-client-ui-sidebar-terminal、dsh-client-ui-sidebar-right、dsh-web-app、dsh-subprocess 等）。
- 重要参考实现：
  - `dsh-client-ui-sidebar-terminal`：client bundle 格式、`ctx.slots.inject` + `sidebar.right.pane.tab` 注册、xterm 用法。
  - `dsh-tool-terminal`：`defineTool` 用法、`exec.agent`、`ctx.workingDirectory.ensure(agent, signal)`。
  - `dsh-tool-pwsh-persistent`：PowerShell 持久 shell 的命令包装/标记解析（可复用思路）。
  - `dsh-api-terminal-controller`：`ctx.subprocess.spawnTerminal` 调用方式、headless xterm + serialize 屏幕快照。
  - 本仓库 `packages/dsh-terminal-panel/lib/client.js`：已验证可加载的 client 骨架（当前为占位 UI）。

## 3. 插件包结构

```
packages/dsh-terminal-panel/
  package.json          # 已存在；dsh.bundle.patch + dsh.client；dependencies: @xterm/headless, @xterm/addon-serialize
  cordis.patch.yml      # 已存在；插入 host 行 name: dsh-terminal-panel
  lib/
    index.js            # host 入口（最终版；Cordis apply）
    client.js           # 构建产物（勿手改；由 tools/build-client.mjs 生成）
    host/
      ansi.js           # stripAnsi / 纯文本工具
      ring.js           # 有界输出尾缓冲（按 UTF-8 字节截断）
      screen.js         # headless xterm 封装：write、visibleText、cursor、serialize、dispose
      session.js        # TerminalPanelSession：PTY handle + screen + 订阅者 + 状态
      registry.js       # 会话注册表：createEphemeral / ensureInteractive / lookup / close / prune
      shell.js          # 解析 shell 可执行文件与 argv（Windows: pwsh.exe 优先，退回 powershell.exe；POSIX: bash）
      intercept.js      # ctx.on('tools/execute') 拦截 pwsh/bash，把前台命令跑进可见 PTY
      tools.js          # terminal_* 工具注册（JSON Schema 参数/输出，直接 ctx.tools.register）
      routes.js         # HTTP 路由 + SSE
      prompt.js         # ctx.systemPrompt.section 指南
  client-src/           # 浏览器半侧源码（TSX）
    index.tsx           # apply(ctx)、注册 locale / sidebar tab type / body slot / guide
    Panel.tsx           # 面板：会话列表 + xterm 视图 + 控制按钮
    styles.ts           # 注入 CSS 字符串
  tests/                # node:test 单元测试（host 纯逻辑）
tools/
  build-client.mjs      # esbuild 构建 client-src → lib/client.js（ModuleLoader wrapper）
  verify-ui.mjs         # 已有 e2e 冒烟脚本（可扩展）
  dev-restart.ps1       # 便捷重启 dev host（可选）
```

## 4. Host 半侧设计

### 4.1 Cordis 入口 `lib/index.js`

```js
export const name = 'dsh-live-terminal'
export const inject = ['tools'] // 必需；其余服务在 apply 中可选获取

export function apply(ctx) {
  // 1) 读取 ctx.get('subprocess') / ctx.get('workingDirectory') / ctx.get('webServer') / ctx.get('connection') / ctx.get('systemPrompt')
  // 2) 初始化 registry（有 subprocess + workingDirectory 时）
  // 3) 注册 HTTP 路由（webServer 存在时，经 ctx.inject(['webServer','connection'], ...)）
  // 4) 注册 terminal_* 工具（tools 存在时）
  // 5) 注册 tools/execute 拦截（interceptShellTools 开启时）
  // 6) systemPrompt.section（存在时）
}
```

- 不能假设 `@deepseek-ai/*` 包可 import（插件不在 DSH 包树内）。必须用 `ctx.get(...)`、`ctx.inject(...)`、`ctx.on(...)`、`ctx.tools.register(...)` 等运行时服务。
- headless xterm 用 `createRequire(import.meta.url)` 加载 `@xterm/headless` 与 `@xterm/addon-serialize`（CJS）。
- 配置（cordis.patch.yml 的 `config`，apply 第二参数）字段：
  - `interceptShellTools`（默认 `true`）：拦截前台 pwsh/bash 调用
  - `shellPath`：交互 shell 可执行路径覆盖（默认自动探测）
  - `scrollback`（默认 2000）
  - `maxOutputBytes`（默认 262144）
  - `maxSessions`（默认 16）
  - `commandTimeoutMs`（默认 180000）：`live_terminal_run(wait:true)` 的默认等待超时；被拦截的 pwsh 前台调用固定 120s 上限（`INTERCEPT_DEFAULT_TIMEOUT_MS`，不读此配置）
  - `retainExited`（默认 10）：保留多少个已退出的命令会话用于回看
  - `interceptMinVisibleMs`（默认 4500，0..60000）：被接管命令至少运行这么久才上屏；0 = 全部上屏（旧行为）。按 wall-clock 计，包含 shell 进程启动开销（Windows PowerShell/ConPTY 实测约 3–4s），因此默认值保证普通秒级命令完全不上屏。
  - `autoCloseCommandDelayMs`（默认 5000，-1..600000）：成功结束的一次性命令终端自动关闭延迟；-1 = 永不自动关闭；0 = 下一 tick
  - `autoCloseFailedDelayMs`（默认 2000，-1..600000）：失败/超时/中止的一次性命令终端自动关闭延迟；-1 = 永不自动关闭
  - `autoCloseToolTerminals`（默认 true）：false = 只自动关闭被接管的命令，`live_terminal_run` 创建的终端保留
  - `autoCloseNotice`（默认 `'failed'`）：`failed` | `all` | `none`，自动关闭时是否通过全局 SSE 发 `notice` 事件

### 4.2 PTY 会话（`session.js`）

用 `ctx.subprocess.spawnTerminal(request)` 创建；请求形如：

```js
const handle = await subprocess.spawnTerminal({
  argv: [shellPath, ...args],      // 交互 shell：pwsh -NoLogo；命令：pwsh -NoLogo -Command <command>
  cwd,
  cols, rows,
  terminalType: 'xterm-256color',
  env: { DSH_SESSION_ID: sessionId }, // 可选
  shellActivity: false,
  graceMs: 1000,
  signal,
})
```

`handle` 关键接口（已在 `dsh-api-terminal-controller/lib/index.js` 验证）：
- `handle.output`：AsyncIterable<Uint8Array>
- `handle.done`：Promise<{ exitCode, signal? }>
- `handle.write(data)` / `handle.resize(cols, rows)` / `handle.terminate()`（幂等，等进程树结束）
- `handle.inspectActivity()`（可选，不用）

会话职责：
- 单 writer：所有对 screen/状态/广播的修改串行（promise 队列）。
- UTF-8 `TextDecoder` 流式解码（`{ stream: true }`），EOF 时 flush；保留末尾 4KB 原样以避免跨块字符问题（参考 controller 的写完再广播顺序）。
- 每个 chunk 顺序：写入 headless xterm（`screen.write(data, cb)`）→ 追加 ring → 生成 `seq+1` 广播 `output` 帧。
- 状态：`running` → `exited`（exitCode）或 `failed`（error message）。进程结束后 flush 输出、广播 `state`，SSE 最终帧。
- `snapshot()`：`{ screen: serializer.serialize(), text: visibleText(), cursor: {x,y}, info }`。
  - `visibleText()`：`buffer.active` 从 `baseY`（viewport 顶部）起 `rows` 行 `translateToString(true)`，逐行右裁剪，去掉尾部全空行，行间 `\n`（滚动后仍是“可见屏”语义；alt buffer 时等价 0..rows-1）。
- 标题：`kind: 'command'|'interactive'`；命令会话标题 = 截断后的命令首行（≤80 字符）；交互会话默认 `PowerShell` / `终端`。
- 会话保留：命令会话退出后保留（最多 `retainExited` 个，超出关闭并移除）；交互会话不自动移除。
- 会话 origin 与隐藏上屏（v1.2）：命令会话带 `origin: 'intercept' | 'tool'`。被接管的命令（`intercept`）在 spawn 后先被 `#hidden` 隐藏，直到运行超过 `interceptMinVisibleMs` 才 reveal 并发 `sessions` 事件；在阈值内退出的命令**不产生 tab、不触发自动弹出、不发 `sessions` 事件**（隐藏会话被 `list()` / `resolveRecentForAgent()` 过滤），失败时补发一条 `notice`。
- 自动关闭与 notice（v1.2）：命令会话退出后按 origin/keepOpen/配置安排自动关闭定时器（`unref`，0 = 下一 tick，-1 = 不关）；定时器到点先按 `autoCloseNotice` 广播 `notice` 再 `close()`。用户终端、交互式终端、agent 默认交互终端永不自动关闭；手动 `close()` 会取消定时器且不发 notice。

### 4.3 会话注册表（`registry.js`）

- `createCommandSession({ command, cwd, cols, rows, timeoutMs, sessionId, agentId, origin, keepOpen })`：spawn `shell -NoLogo -NoProfile -NonInteractive -Command <command>`（命令字符串原样传入 argv，不经 shell 解释）。已与实现确认：命令会话不加载用户 profile（对齐内置执行器、避免 6s 启动与输出污染）。`live_terminal_run` 每次调用都创建一个这样的独立可见命令会话（不再复用交互 shell，也不再使用 wrapper 标记）。
  - `origin`（默认 `'tool'`）：`'intercept'` 表示内置 pwsh/bash 接管（参与快速命令隐藏 + 自动关闭）；`'tool'` 表示 `live_terminal_run`（自动关闭受 `autoCloseToolTerminals` 控制）。
  - `keepOpen`（默认 false）：为 true 时命令结束后不自动关闭该终端。
  - 自动关闭：命令退出后成功延迟 `autoCloseCommandDelayMs`、失败/超时/中止延迟 `autoCloseFailedDelayMs` 关闭；到点按 `autoCloseNotice` 先广播 `notice` 再 close。手动 `close()` 取消定时器且不广播 notice。
  - notice 契约（全局 SSE `/events` 原样转发）：`{ type: 'auto-close', reason: 'failed' | 'succeeded', terminalId, title, exitCode, signal, excerpt }`；`excerpt` = 输出尾部最后一个非空行（去 ANSI、≤160 字符）。
- `createInteractive({ cwd, cols, rows, sessionId, agentId, title })`：spawn 交互 shell（`-NoLogo`，加载用户 profile）；`live_terminal_open` / `live_terminal_send` 的缺省目标用它。交互式/用户/agent 默认终端永不参与自动关闭。
- `ensureAgentTerminal(agent)`：每个 agent 一个默认交互终端（用于 `live_terminal_send/read`，也可被 `live_terminal_screenshot` 的兜底选择使用）。
- `runInExisting(session, command, ...)`（wrapper 标记法）：保留为内部工具/单测能力；`live_terminal_run` 不再使用它（避免 wrapper 回显/标记污染可见屏幕与截图）。
  - 产生随机 nonce；wrapper 采用 `dsh-tool-pwsh-persistent` 的写法：
    `Write-Output '<START>'; $LASTEXITCODE=$null; $__s=1; try { Invoke-Expression "<escaped>"; $__ok=$? } catch { $__ok=$false }; if ($null -ne $LASTEXITCODE) { $__s=[int]$LASTEXITCODE } else { $__s = if ($__ok) {0} else {1} }; Write-Output ('<END>'+$__s)`
  - `quoteForPwsh`：反引号转义（\`、"、$），\r 删除，\n → \`n，ESC → \`e；单行写入并回车。
  - 解析：在会话的 **纯文本滚动缓冲**（ANSI 已剥离）中轮询（25ms）找 `END`+数字；取最后一个 `START` 到 `END` 之间文本，去掉 wrapper 回显；返回 `{ output, exitCode }`。
  - 超时：默认 `commandTimeoutMs`；超时后 `handle.terminate()` 并标记会话失效，返回已捕获部分输出 + `timedOut: true`（下次 `ensureAgentTerminal` 重新创建）。
  - 取消（exec.signal abort）：terminate 会话，返回 `aborted`。
- 事件订阅：`subscribe(id, listener)` 返回 disposer；SSE 使用。
- 关闭：`close(id)` → terminate + 移除 + 广播。

### 4.4 HTTP 路由（`routes.js`，都走 `ctx.connection.admit(req)` 鉴权）

所有路径前缀 `/dsh-terminal-panel`。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/sessions` | — | `{ sessions: SessionInfo[] }`（含已退出保留会话） |
| GET | `/snapshot?id=` | — | `{ info, screen /*ANSI*/, text /*可见屏文本*/, cursor }` |
| GET | `/events?id=` | — | SSE：`snapshot` / `output` / `state` / `exit` 事件；20s 心跳注释 |
| GET | `/events` | — | SSE：全局 `sessions` 事件（会话新增/状态变化时）+ `notice` 事件（v1.2 自动关闭通知，见 §4.3 notice 契约；隐藏会话不产生 `sessions` 事件） |
| POST | `/create` | `{ cols?, rows?, title?, sessionId? }` | `{ session }` |
| POST | `/input` | `{ id, data }` | `{ ok: true }`（data 为原始 UTF-8，含控制字符；大写上限 64KB） |
| POST | `/resize` | `{ id, cols, rows }` | `{ ok: true }` |
| POST | `/close` | `{ id }` | `{ ok: true }` |

- JSON 请求/响应；错误统一 `{ error: string }` + 4xx/5xx。
- `admit` 失败：401（未认证）/403（不信任），直接 `res.end`。
- SSE：`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`；每个事件 `event: <name>\ndata: <json>\n\n`；正常关闭/超时/`req.close` 时清理订阅。
- SSE 背压（v1.1）：每条连接待发帧上限 `MAX_STREAM_BUFFER_BYTES` = 4 MiB；`res.write()` 返回 false 时暂停并等待 `drain`；超限时直接 `close()` 该慢连接（客户端 EventSource 按 `retry: 1000` 重连并从新 snapshot 重同步），host 内存因此有界。
- 快照有界（v1.1）：`GET /snapshot` 与 per-session SSE 首帧的 ANSI 序列化固定只带最近 `SSE_SNAPSHOT_SCROLLBACK` = 500 行 scrollback，保证单帧远低于 4 MiB 上限。
- 请求体解析：手写有界读取（≤1MB），不要引入框架。

`SessionInfo` 形状（client/host 共用）：
```ts
type SessionInfo = {
  id: string
  title: string
  kind: 'command' | 'interactive'
  owner: 'agent' | 'user'
  sessionId?: string
  agentId?: string
  command?: string
  cwd: string
  cols: number
  rows: number
  state: 'running' | 'exited' | 'failed'
  exitCode: number | null
  error?: string
  createdAt: number
  updatedAt: number
}
```

### 4.5 工具（`tools.js`）

直接 `ctx.tools.register({ name, description, parameters: <JSON Schema>, output: { schema: <JSON Schema>, render(args, value) }, async execute(args, exec), presentCall? })`。
注意：`parameters` 必须是 **JSON Schema 对象**（`{ type: 'object', properties: {...}, required: [...], additionalProperties: false }`），不要再写 DSL。
`exec.agent` 是拥有者 Agent；`exec.signal` 是取消信号；`exec.agent.session?.id` 可作 sessionId。
返回工具的模型可见文本由 `output.render` 生成；`value` 必须严格符合 `output.schema`（运行时校验，失败会变成工具错误）。

工具清单（**统一加 `live_` 前缀**，避免与官方实验性“持久终端”bundle 的 `terminal_*` 工具重名导致注册失败）：

1. `live_terminal_run`
   - 参数：`command`（string，必填）、`description`（string，可写可不写，仅展示）、`wait`（boolean，默认 true）、`timeoutMs`（number，默认 `commandTimeoutMs`）、`keepOpen`（boolean，默认 false = 命令结束后自动关闭该终端；true = 保留）
   - 行为：**每次调用创建一个独立的可见命令会话**（`createCommandSession`，`-NoProfile -NonInteractive -Command`，cwd=agent 当前工作目录），输出实时进面板；`wait:true` 等待退出（受 timeoutMs 约束）；`wait:false` 立即返回、命令继续跑（后续用 `live_terminal_read`/`live_terminal_screenshot` 查看）。命令结束后终端按 `autoCloseToolTerminals`/`autoCloseCommandDelayMs`/`autoCloseFailedDelayMs` 自动关闭（默认成功 5s、失败 2s），`keepOpen:true` 可保留。
   - value：`{ terminalId, title, output, exitCode: number|null, timedOut: boolean, aborted: boolean, stillRunning: boolean }`
   - render：**首行必须输出 `[terminal <id>]`（模型靠它传 terminalId）**，其后为 `output`，非 0 时追加 `\n[exit code: N]`，等待/超时等状态标记；输出有界。
2. `live_terminal_screenshot`
   - 参数：`terminalId`（string，可选；缺省选择该 agent **最近一个可见会话**：优先最近的 command 会话，其次 interactive）、`withScrollback`（boolean，默认 false）
   - value：`{ terminalId, title, state, cols, rows, cursor: {x,y}, text: string, ansi?: string }`
   - render：`text` 前加一行 `[terminal <title> <cols>x<rows> cursor (x,y) state]`；这是模型看到的“截图”
3. `live_terminal_send`：`{ terminalId?, text (必填), submit? (默认 true) }` → `{ ok, terminalId }`（写入原始文本；submit 时追加 `\r`；缺省目标是该 agent 的默认交互终端，不存在时懒创建；对已退出会话给出清晰错误）
4. `live_terminal_read`：`{ terminalId?, maxBytes? }` → `{ terminalId, state, text }`（最近输出尾部；无 ANSI；缺省目标同 send）
5. `live_terminal_list`：`{}` → `{ terminals: SessionInfo[] }`
6. `live_terminal_open`：`{ title?, cwd? }` → `{ terminalId, info }`（创建新的可见交互会话，作为该 agent 的默认交互终端）
7. `live_terminal_close`：`{ terminalId }` → `{ ok: true }`

工具指南（`prompt.js`）：`ctx.systemPrompt.section({ name: 'tool:terminal-panel', order: <TOOL_PTY 附近>, text })`，说明：命令会自动显示在“终端面板”；需要看当前屏幕用 `live_terminal_screenshot`；需要交互/长任务用 `live_terminal_open/run/send`；`live_terminal_screenshot` 适合 TUI/全屏程序。

### 4.6 默认 shell 工具拦截（`intercept.js`）

```js
ctx.on('tools/execute', async (exec, next) => {
  if (!config.interceptShellTools) return next()
  if (exec.name !== 'pwsh' && exec.name !== 'bash') return next()
  const args = exec.arguments ?? {}
  // 有 sandbox 升权或后台运行参数时交给原实现，保持审批/沙箱/后台语义不变
  if (args.run_in_background === true || args.sandbox_permissions !== undefined) return next()
  const command = typeof args.command === 'string' ? args.command : undefined
  if (!command) return next()
  try {
    const value = await runVisibleCommand({ command, workdir: args.workdir, timeoutMs: args.timeoutMs, agent: exec.agent, signal: exec.signal })
    return { value }   // 成功路径返回 value，registry 会按内置工具的 output.schema 校验 + render
  } catch (error) {
    return next()      // 运行失败回退原实现（或返回 isError？优先回退，保证正确性）
  }
})
```

`runVisibleCommand` 构造与内置 pwsh 工具一致的 value（必要时按 `exec.name` 区分，Windows 只需要 pwsh）：
```js
{
  kind: 'foreground',
  cwd,                       // 解析后的工作目录
  exitCode,                  // number | null
  signal: null,              // 我们主动 terminate 时填信号名（如 'SIGTERM'）
  timedOut,                  // boolean
  aborted,                   // boolean
  timeoutMs,                 // 本次生效超时
  stdout: { text: mergedOutput, truncated: false },  // PTY 合并 stdout/stderr
  stderr: { text: '', truncated: false },
}
```
- 输出文本：ANSI 剥离、解码后合并；保留尾部 `maxOutputBytes`，超出时在头部加裁剪说明（参考内置工具）。
- 超时：默认用 `args.timeoutMs ?? 内置 shell 默认（60s）`？为贴近原行为，取 `args.timeoutMs ?? 120000`（可配置）。超时 terminate 并返回 `timedOut: true, exitCode: null`。
- 取消 `exec.signal`：terminate，返回 `aborted: true`。
- 每次拦截创建 `kind: 'command'` 会话，标题=命令首行；agent 命令应在面板中实时可见。
- 若 `exec.agent` 缺失或会话创建失败（例如 subprocess 服务不可用），回退 `next()`。

> 失败回退会让该条命令按原样在后台执行，但不会破坏 agent 行为；这是安全网。

## 5. 客户端半侧（`client-src/`）

### 5.1 注册（`index.tsx`）

已验证可用的模式（参考 `packages/dsh-terminal-panel/lib/client.js` 当前骨架、官方 `dsh-client-ui-sidebar-terminal`）：

```ts
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

export function apply(ctx) {
  // locale.register(namespace, { zh, en })
  // sidebarRightTabs.register({ id, kind: 'terminal-panel', multiple: true, priority: 'extension', title, guide: [{ id:'open', order, title, description, icon: <primitives.PluginArtworkTerminal> }] })
  // ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name:'sidebar.right.pane.tab', key:id, locale: namespace, inject: (sessionId) => ({ sessionId }) }, Panel)))
}
```
- 面板 body 组件收到 props：`useTabInfo`、`t`（locale）、自定义 `inject` 返回值、`sessionId`。
- `useTabInfo()` 返回 `{ sidebar, panel, tab }`；从 tab 拿不到 terminal id 时用内部状态（面板内自己管理会话选择，按 `sessionId`/全局列表）。
- 客户端可用的共享模块（platform 基座）：`react`、`react-dom`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-dockkit`、`zod`、`@tanstack/react-virtual`。其他 import 必须打包进 bundle（xterm 等）。

### 5.2 面板 UI（`Panel.tsx`）

- 获取会话：`GET /dsh-terminal-panel/sessions`；订阅 `GET /dsh-terminal-panel/events` 全局 SSE 更新列表。
- 顶部工具栏：`+ 新建终端`（POST /create）、刷新、关闭当前会话；当前会话标题/状态。
- 会话列表：左侧或顶部标签（命令会话显示命令首行、交互会话显示标题；running 状态小圆点；已退出显示退出码；可关闭）。
- 终端视图：`@xterm/xterm` + `@xterm/addon-fit`；挂载时打开 SSE `/events?id=`，先渲染 `snapshot.screen`（ANSI）再追加 `output.chunk`；按容器尺寸 `fit()` 并 POST resize；用户键盘输入 → POST `/input`（原始字符串，包含 `\r`）。
- 主题：跟随 DSH 主题变量（尽量读取 `getComputedStyle(document.documentElement)` 的 `--dsw-*` 背景/前景色；不要求完美）。
- 截图按钮：把 xterm 可见屏文本复制到剪贴板（navigator.clipboard）并提示；也给 agent 的截图工具提供同样内容（host 端计算）。
- 错误态：连接失败显示重试；空态显示“新建终端”按钮。
- 自动打开：面板 mount 时订阅全局 `GET /events`；当出现新的 `kind:'command' & owner:'agent' & state:'running'` 会话且当前右侧栏未打开面板时，自动 `ctx.sidebarRight.openTab('terminal-panel', { revealIfOpened: true })`（每个浏览器标签页最多自动打开一次，避免打扰）。这样用户不用手动点就能看到 agent 命令进度。
- 语言：中文为主，`locale` 注册 zh/en。

### 5.3 构建（`tools/build-client.mjs`）

- 输入 `packages/dsh-terminal-panel/client-src/index.tsx`；esbuild bundle（format=cjs，platform=browser，jsx=automatic，loader: {'.css':'text'}）。
- externals：`react`、`react-dom`、`react/jsx-runtime`、`react-dom/client`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-dockkit`、`zod`、`@tanstack/react-virtual`。
- 把 CSS 文本注入：在 `apply()` 里创建 `<style data-plugin="dsh-terminal-panel">`（幂等）。
- 产物包装：
  ```js
  window.__ModuleLoader__.load({
    id: "dsh-terminal-panel",
    factory: (require) => {
      var module = { exports: {} }; var exports = module.exports;
      /* esbuild CJS 代码 */
      return module.exports;
    },
  });
  ```
- 输出 `packages/dsh-terminal-panel/lib/client.js`；写完打印大小。
- 根 `package.json` scripts：`"build": "node tools/build-client.mjs"`。
- 构建后必须重启 dev host 才能在浏览器看到新 bundle。

## 6. 测试与验收

### 6.1 单元测试（host 纯逻辑，node:test）
- `ansi.js`：剥离 SGR/OSC/光标序列。
- `ring.js`：字节上限、UTF-8 边界裁剪。
- wrapper 生成/解析：给定模拟纯文本流（含回显、两段命令输出、结束标记），正确提取输出与退出码。
- value 映射：pwsh foreground value 形状与 schema 匹配（可用内置工具 schema 校验思路）。

### 6.2 e2e（`tools/verify-ui.mjs` / QA 扩展）
- 打开 dev GUI（token URL）→ 关闭预览弹窗 → 打开会话 → `Control+Shift+B` 打开右侧栏 → 点“终端面板”guide → 面板 body 出现。
- 面板内新建终端 → xterm 出现 → 输入 `Write-Output 'hello'` 回车 → 屏幕出现 hello。
- agent 工具验证（通过 HTTP 直接调用工具不可行；用真实会话让 agent 触发 `live_terminal_screenshot`，或在 dev host 里用测试 agent；至少验证：拦截 pwsh 调用后面板出现命令会话与输出）。
- 截图工具返回的 `text` 包含屏幕内容（TUI 场景可后续测）。

### 6.3 验收门槛
- dev host 启动无插件报错；`GET /dsh-terminal-panel/sessions` 带 cookie 返回 200；client bundle 加载无 console error。
- 面板可开、可输入、可 resize、可关；SSE 实时输出。
- 拦截生效：一次 `pwsh` 调用在面板出现实时输出，工具结果正常（agent 不报错）。
- `live_terminal_screenshot` 返回当前屏幕文本。
- 安装到 desktop profile 后同样工作（由 Lead 在确认后执行；不要在测试中重启用户的 Desktop DSH）。

## 7. 并行分工与写作用域（避免冲突）

| 角色 | 负责文件 | 不要动 |
|---|---|---|
| host-engine | `packages/dsh-terminal-panel/lib/index.js`、`lib/host/**`、`packages/dsh-terminal-panel/tests/**` | `client-src/**`、`lib/client.js`、`tools/build-client.mjs`、根 `package.json`、`research/**`、`docs/**` |
| client-ui | `packages/dsh-terminal-panel/client-src/**`、`tools/build-client.mjs`、`tools/verify-ui.mjs` | `lib/index.js`、`lib/host/**`、`lib/client.js`（只由构建脚本写）、根 `package.json`、`docs/**` |
| qa-verifier | `qa/**`、`tools/**`（新增测试脚本）、`docs/test-report.md` | 上述两者的源码；不改实现文件，只报告 bug |
| Lead | `package.json`、`package.json`/profile 安装、`docs/**`、集成修复、桌面安装与最终验收 | — |

开发期约定：
- 重启 dev host 前先 `job_kill` 旧的（Lead 管理 3101 端口；其他成员需要时使用 3103+ 端口自测并先说明）。
- 每次改动 client 需 `node tools/build-client.mjs` 后重启 dev host。
- 文本文件一律用 `write`/`edit` 工具写 UTF-8（不要用 PowerShell `Set-Content` 改中文文本）。

## 8. 修订记录（v1.1 / v1.2）

| 领域 | v1.1 / v1.2 契约调整 |
|---|---|
| 插件装配 | `apply()` 的 registry disposer 统一挂在插件 `ctx` 上：`subprocess`/`workingDirectory` 在 apply 时已就绪（direct 分支）不再因普通对象无 `.effect` 而抛 `TypeError`；deferred 分支保持 `ctx.inject` 行为。 |
| shell 拦截 | 按工具方言选择 shell（`bash` 方言不再落到 pwsh）；方言解析/启动失败时回退 `next()`，保持原生工具语义。 |
| 输出流 | PTY 输出流失败时 terminate 整个进程树，避免孤儿进程与悬挂会话。 |
| 容量 | `maxSessions` 的占位/回收原子化（并发 create 不突破上限）；agent 交互终端超容量时回收最旧者；`startingDefaults` 保护启动中的默认交互终端不被误回收。 |
| `wait:false` | `live_terminal_run(wait:false)` 立即返回、后台继续运行，不再受 `commandTimeoutMs` 默认超时自动终止；由用户手动关闭或等其自行结束。 |
| SSE 背压 | 每条 SSE 连接待发帧上限 4MiB；`res.write()` 返回 false 时暂停等待 `drain`；超限时断开该慢连接（EventSource 按 `retry: 1000` 重连并重新同步 snapshot），host 内存有界。 |
| 工具 ownership | 工具只能看到/操作本 agent 自己的终端：`owner==='user'` 的终端对 agent 只读可见（list/read/screenshot 允许，send/close 拒绝）；`owner==='agent'` 仅当 `session.agentId === agent.id` 时可见且可写；其它 agent 的终端对 list/read/screenshot/send/close 全部拒绝并给出明确错误。 |
| 快照与截图有界 | `/snapshot` 与 per-session SSE 首帧固定 `scrollback: 500`（`SSE_SNAPSHOT_SCROLLBACK`），单帧远低于 4MiB 队列上限；`live_terminal_screenshot(withScrollback)` 的 `text` 按 `maxOutputBytes` 保留 UTF-8 尾部并加截断说明，`ansi` 使用 `scrollback: 500` 而不是全量滚动缓冲。 |
| 终端自动清理（v1.2） | 被接管命令短于 `interceptMinVisibleMs` 完全不上屏（无 tab/无自动弹出/无 `sessions` 事件）；一次性命令结束后自动关闭（成功 `autoCloseCommandDelayMs`、失败/超时/中止 `autoCloseFailedDelayMs`，`-1` 关闭该行为），`live_terminal_run` 受 `autoCloseToolTerminals` 控制、工具参数 `keepOpen:true` 可保留；用户/交互式/agent 默认终端永不自动关闭；自动关闭失败命令时全局 SSE 发 `notice`（`autoCloseNotice` 控制范围）。 |
| client | 输入串行队列（单请求 ≤32KB 分片、失败上报）、HTTP 10s 超时、全局 sessions SSE 单例、主题/resize 去抖、tabs/overlay a11y 增强；client 版本号由构建期 `__PLUGIN_VERSION__` 注入。 |
| 版本 | `1.2.0`。 |

## 9. 修订记录（v1.2.1）

v1.2.1 的完整接口契约见 [`impl-1.2.1-contract.md`](./impl-1.2.1-contract.md)。覆盖要点：

| 领域 | v1.2.1 契约调整 |
|---|---|
| 配置 | 新增 `perSessionMaxSessions`、`historySize`、`historyPath`、`historyPersist`、`requireSandbox`、`allowUnconfined`、`portDetection`；`interceptMinVisibleMs` 默认 1500 且从 shell 首帧输出计时；`autoCloseCommandDelayMs` 8000、`autoCloseFailedDelayMs` 30000、`autoCloseNotice: 'all'`。 |
| SessionInfo | 新增 `signal`、`startedAt`、`endedAt`、`durationMs`、`shellKind`、`ports`、`sandbox`、`autoCloseAt`、`autoClosePaused`、`pinned`。 |
| 历史 | 新增 `CommandHistory`（LRU + 原子 JSON 落盘）；命令会话退出/关闭即记录；`read/screenshot/status/search/export` 可按原 terminalId 回退历史；`GET /history`、`live_terminal_history`。 |
| 自动关闭 | 倒计时字段 `autoCloseAt`；`POST /keep`、`POST /auto-close {pause|resume}`；失败延迟长于成功；`notice` 增加 `historyId`/`durationMs`/`command-finished`/`port`。 |
| 工具面 | 新增 `live_terminal_wait/status/signal/resize/read` 分页/`search`/`expect/exec/history/rename/export`；`run/open` 支持 `cwd/shell/cols/rows/env`；`screenshot` 支持 `text/ansi/png`；`send` 支持 `keys`/`paste`；只读工具声明 `isConcurrencySafe`。 |
| 路由 | 新增 `/config`、`/history`、`/replay`、`/export`、`/keep`、`/auto-close`、`/rename`、`/take-control`、`/signal`、`/capture`；per-session SSE 支持 `clientId`/`fromSeq` 与 `capture-request`；多客户端输入租约（非 writer 返回 409 `READ_ONLY`）。 |
| 客户端 | 紧凑会话条 + `⋯` 菜单 + 跟随/固定；自动关闭倒计时/保留；历史视图；重命名；选区复制/右键菜单/`Ctrl+F` 搜索；全局通知与首次引导；面板局部 keymap（不注入 DSH shortcuts 服务）；PNG capture 回传；错误 banner、连接态、焦点管理、对比度与窄栏适配。 |
| 版本 | `1.2.1`。 |

## 10. 修订记录（v1.2.2）

| 领域 | v1.2.2 调整 |
|---|---|
| 自动关闭暂停 | 修复单向暂停：鼠标在终端/页签上移动时临时暂停，移开自动 `resume`；点击/选中页签不再暂停；只有 `/keep` 永久保留；暂停中的页签显示“已暂停”徽标。 |
| 关闭一致性 | `/close` 非 404 失败时客户端重新同步会话列表；Host `close()` 的 `session.dispose()` 失败不再抛出 500，记录日志后完成关闭。 |
| 版本 | `1.2.2`。 |
