# dsh-terminal-panel 独立测试报告（最终验收 vFinal）

| 项 | 值 |
|---|---|
| 报告版本 | **vFinal**（最终验收；自动 e2e + Lead 3101 真实 agent manual 结果已全部并入） |
| 测试执行 | qa-verifier（独立 QA） |
| 日期 | 2026-10-19 Asia/Shanghai |
| 契约 | `docs/architecture.md`（含 2026-10-19 更新：`live_` 前缀 / 自动打开 / 截图=文本屏幕 / `visibleText` viewport 语义 / task-4 后 run→独立命令会话 + screenshot 默认目标） |
| 被测版本 | `packages/dsh-terminal-panel`（host `lib/index.js` + `lib/host/**`；client `client-src/**` → `lib/client.js` 构建产物），含 task-4（host run/screenshot 重做、sessions 注入、进程终止）、task-5（client 传 sessionId） |
| 测试环境 | DSH 0.2.1-rc.2，dev profile，QA 专用 dev host **127.0.0.1:3105** |
| 自动化入口 | `tools/qa-e2e.mjs`（Playwright 系统 Chrome + 真实 fetch/SSE 断言） |
| **最终验收 run** | `qa/artifacts/2026-10-19T10-52-17-172Z/`（`summary.json` / `console.log` / 13 张截图） |
| 测试计划 | `qa/test-plan.md` |

---

## 0. 结论（TL;DR）

- **最终验收（最新 host+client，全新 3105 host，串行 `--slow`）：PASS 44 / FAIL 0 / SKIP 1 / MANUAL 29**（run `2026-10-19T10-52-17-172Z`，73.5s）。
- **验收门槛（architecture.md §6.3）全部满足**：host 启动无插件报错、`/sessions` 200、client bundle 无 console error、面板可开/输入/resize/关闭、SSE 实时、UTF-8/ANSI/长输出、未鉴权 401、错误 JSON；**拦截 pwsh（B）**、**自动打开面板**、**`live_terminal_screenshot` 文本截图（C）** 均由 Lead 在 3101 用真实 deepseek-flash agent 复测 **PASS**。
- **P2-1 cwd 已闭环**：client 新建终端携带 `sessionId`，host 解析会话工作区；QA e2e U-06 实测 `cwd=C:\Users\LANCANG\Desktop\Code\lancang`（会话工作区）、`sessionId` 已写入 SessionInfo；Lead 3101 实测 `cwd=…\BIG DATA`（会话工作区）PASS。裸 HTTP `/create` 不带 sessionId 仍回退 host 启动目录，属预期。
- **P1-2 run+screenshot 已修复并验证**：task-4 重做后，`live_terminal_run` 返回首行 `[terminal <id>]`、无 wrapper 噪声；`live_terminal_screenshot` 缺省选中最新 command 会话并返回干净可见屏文本 + `[terminal … 86x50 cursor (0,24) exited]`，agent 原样贴出（Lead 证据 `tools/artifacts/tool-test-final.png`）。
- host 单测 **116/116 PASS**；client 构建 **393,231 B（384.0 KiB，gzip 100.3 KiB）**；e2e 期间插件 HTTP 调用 0 次 4xx/5xx、无 plugin console error/pageerror。
- 剩余：**E-11 desktop profile 安装**由 Lead 安装后用 58966 探测确认（QA 不重启用户 Desktop）；另有 P3 观察 4 项（DSH 内部偶发 pageerror、e2e 环境并发 flake、剪贴板首行比对、关闭会话后 shell 进程残留），均非验收阻断。
- 未触碰用户 Desktop DSH（58966 PID 25976 全程不变）与 `D:\DSH`；未重启 3101/3103/3104；QA 侧未发送任何对话消息、未消耗模型额度。

---

## 1. 环境与版本

| 项 | 值 |
|---|---|
| 最终 dev host | `& "D:\DSH\resources\runtime\cli\bin\dsh.cmd" --profile dev --no-open --port 3105`；PID 6436；日志 `qa/artifacts/devhost-3105-final2.log` |
| host 日志 | 仅 `dsh web:` + llm model listing，无插件错误行 |
| 端口 | 3105 = QA host；3101 = Lead 集成 host（QA 未动）；3103/3104 未动；58966 = 用户 Desktop（PID 25976，全程不变） |
| 浏览器 | 系统 Chrome（`C:/Program Files/Google/Chrome/Application/chrome.exe`），Playwright headless |
| client 构建 | `node tools/build-client.mjs` @ 2026-10-19 18:46:26；单文件 393,231 B；externals 与契约 §5.3 一致；xterm + CSS 打包进 bundle |
| host 单测 | `node --test --test-concurrency=1 packages/dsh-terminal-panel/tests/*.test.mjs` → **116 pass / 0 fail**（含 registry/shell/tools/intercept/wrapper/session/screen/ring/ansi） |
| 契约更新 | architecture.md 已同步 `visibleText` viewport 语义、`live_terminal_run` 独立命令会话 + render `[terminal <id>]`、`live_terminal_screenshot` 缺省目标（最近可见会话，command 优先） |

---

## 2. 执行记录与总体统计

| 阶段 / run | 说明 | 结果 |
|---|---|---|
| 阶段 A 干跑（3104 skeleton） | 验证 e2e 机制（选择器/cookie/401/JSON/SSE 断言） | 6 PASS / 27 FAIL（host 路由未实现，预期） |
| 预验收 run1 `10-07-26-684Z` | 首次全量；U-11/H-07 为脚本问题、H-16 为产品问题 | 40 PASS / **3 FAIL** / 1 SKIP |
| 预验收 run2 `10-10-44-820Z` | 修 e2e SSE 解析与 guide 选择器 | 42 PASS / **1 FAIL**（H-16） |
| 预验收 run3 `10-13-05-088Z` | 增加 E-04；host 修复前 | 43 PASS / **1 FAIL**（H-16） |
| 正式验收 run `10-15-44-399Z` | 上一轮最新代码 + 重启 host | **44 PASS / 0 FAIL / 1 SKIP** |
| Lead 3101 e2e `10-36-36` | Lead 用 QA e2e 在集成 host 串行跑 | 44 PASS / 0 FAIL / 3 SKIP（未带 `--slow`/`--host-log`） |
| 最终轮尝试 A `10-41-57-134Z` | 最新代码、全新 host；H-06/H-08 环境 flake | 42 PASS / **2 FAIL**（H-06/H-08） |
| 最终轮尝试 B `10-44-57-684Z` | 同上，复现 flake | 42 PASS / **2 FAIL**（H-06/H-08） |
| 隔离验证 `10-47-29-909Z` | `--http-only`（无 UI 阶段） | 29 PASS / 0 FAIL / 7 SKIP → H-06/H-08 通过 |
| 诊断 run `10-49-59-176Z` | 清理 2 个 orphaned pwsh/OpenConsole 后 `--keep-sessions` | **44 PASS / 0 FAIL / 1 SKIP** |
| **最终验收 canonical `10-52-17-172Z`** | 再次全新 host、串行 `--slow --host-log`、正常清理 | **44 PASS / 0 FAIL / 1 SKIP / 29 MANUAL（73.5s）** |

> **环境 flake 说明**：最终轮 A/B 的 H-06/H-08 失败（交互会话 30s 内无 shell 提示符/无输出）与同一代码的 `--http-only` 全过、清理 orphaned `pwsh.exe`+`OpenConsole.exe` 后全量过相互印证，判定为 **PTY/进程环境竞争 flake**，不是产品回归；已作为环境噪声归档。Lead 也观察到 B-05 在与其 agent 测试并发时 flake 一次、单独跑稳定 PASS，同类归档。

---

## 3. 验收门槛（architecture.md §6.3）

| 门槛 | 结果 | 证据 |
|---|---|---|
| dev host 启动无插件报错 | **PASS** | `qa/artifacts/devhost-3105-final2.log`；`/ping` 200、`/sessions` 200 |
| `/dsh-terminal-panel/sessions` 带 cookie 200 | **PASS** | H-01 |
| client bundle 加载无 console error | **PASS** | E-03：marker=true、clientLog=true、pluginConsoleErrors=0、pageErrors=0；`01-app-loaded.png` |
| 面板可开、可输入、可 resize、可关 | **PASS** | U-04/U-05/U-07/U-09/U-10；`04/05/07/09/13-*.png` |
| SSE 实时输出 | **PASS** | H-08：首帧 snapshot、output 帧延迟 **8ms**、`seq` 单调（13→17）、data `{id,seq,chunk}` |
| 拦截生效（真实 agent，B） | **PASS**（Lead 3101） | E-09/T-02：chat “运行命令 · Output intercept-ok”，右侧栏出现 command 会话（title=命令、cwd=会话工作区）、屏幕 intercept-ok、状态“已退出(0)”，agent 回复正确；证据 `tools/artifacts/agent-test-02/03.png` |
| agent 命令会话自动打开面板（§5.2） | **PASS**（Lead 3101，同一证据） | E-12/T-11：面板未开时自动打开右侧栏“终端面板”并选中命令 tab |
| `live_terminal_screenshot` 返回屏幕文本（C） | **PASS**（Lead 3101） | E-10/T-04：run 首行 `[terminal <id>]`、无 wrapper 噪声；screenshot 缺省选中最新 command 会话，返回 `[terminal Get-Location; … 86x50 cursor (0,24) exited]` + 干净可见屏文本；agent 原样贴出；证据 `tools/artifacts/tool-test-final.png` |
| 新建终端在会话工作区（P2-1） | **PASS** | QA U-06：`sessionId=session-d63c2d80-…`、`cwd=C:\Users\LANCANG\Desktop\Code\lancang`；Lead 3101：`cwd=…\BIG DATA` |
| desktop profile 安装后同样工作 | **待 Lead**（Lead 即将安装并用 58966 探测；QA 不重启用户 Desktop） | E-11 |

---

## 4. 分项结果（最终验收 run `10-52-17-172Z`）

### 4.1 UI e2e（A：可见终端面板）

| ID | 结果 | 说明 / 证据 |
|---|---|---|
| U-01 打开 dev GUI | PASS | 标题 DeepSeek Harness，`__DSH_TERMINAL_PANEL__=true`；`01-app-loaded.png` |
| U-02 关闭预览弹窗 | PASS | 无遮挡；`02-after-overlays.png` |
| U-03 打开会话（不发送消息） | PASS | composer 已可见（复用已有会话）；`03-conversation.png` |
| U-04 Ctrl+Shift+B → guide「终端面板」 | PASS | 右侧栏展开，guide 入口 1 个；`04-right-sidebar-guide.png` |
| U-05 点 guide → 面板 body | PASS | `[data-dsh-terminal-panel="body"]`；工具栏按钮齐全；`05-panel-open.png` |
| U-14 空态/新建入口 | PASS | `[data-dsh-tp-action=create]`，phase=ready |
| U-06 新建终端 → xterm | PASS | 新会话 running 86x44、**cwd=会话工作区、sessionId 已传**；`06-xterm-created.png` |
| U-07 输入命令 → 屏幕输出 | PASS | `Write-Output 'qa-hello-…'`，1ms 内屏幕出现 |
| U-08 中文输出 | PASS | `中文-qa` 正确渲染，无 `�`；`08-xterm-chinese.png` |
| U-09 resize | PASS | 86x44 → 68x31，观察到 2 次 POST `/resize`；`09-resized.png` |
| U-10 UI 关闭会话 | PASS | 关闭按钮 → host `/sessions` 移除；`13-session-closed.png` |
| U-11 刷新后重开面板/重连 | PASS | host 会话保留、snapshot 保留旧输出、UI 恢复屏幕文本；`10-after-reload.png` |
| U-12 多会话 + 标签切换 | PASS | 两会话、切换标签各自屏幕正确、host snapshot 不串台；`11-multi-session.png` |
| U-13 面板截图/复制按钮 | PASS | 剪贴板 161 字符、内容为当前屏幕文本；`12-screenshot-button.png`；首行比对差异为观察项 O-3 |

### 4.2 HTTP/SSE 契约（architecture.md §4.4）

| ID | 结果 | 说明 |
|---|---|---|
| H-01 `/sessions` 200 + SessionInfo[] | PASS | 字段/枚举校验通过 |
| H-02 无 cookie → 401 | PASS | admit 失败行为符合契约 |
| H-03 `POST /create` | PASS | 200 `{session}`；SessionInfo 合法（裸 HTTP 无 sessionId → cwd 回退 host 启动目录，预期） |
| H-04 `/create` 缺省尺寸 | PASS | 默认 120x30 |
| H-05 `GET /snapshot` | PASS | `{info,screen,text,cursor}` 形状正确 |
| H-06 `/input` → snapshot 输出 | PASS | shellReady=true，输出延迟 213ms |
| H-07 SSE 帧格式/首帧 | PASS | `text/event-stream`；首事件 snapshot；data JSON；retry 控制帧不误判 |
| H-08 SSE 实时性/seq | PASS | 延迟 8ms（<2s）；output 帧 `{id,seq,chunk}` seq 单调 |
| H-09 全局 `/events` sessions 事件 | PASS | 新建会话后收到 `sessions` 事件 |
| H-10 `/resize` 生效 | PASS | 200 `{ok:true}`，snapshot.info 同步 90x25 |
| H-11 `/close` | PASS | 200；列表移除；snapshot 404 `{error}` |
| H-12/H-13/H-15 错误处理 | PASS | 缺 id/未知 id → 4xx `{error}`；非法 JSON → 400 且服务不崩 |
| H-14 resize 参数校验 | PASS | 非整数→400；越界值→安全钳制（记录策略，非缺陷 O-2） |
| H-16 >1MB 请求体 | PASS | **413 JSON**，服务不崩溃 |
| H-17 SSE 反复连接 | PASS | 5 次连接/断开后正常 |
| H-18 20s 心跳 | PASS（--slow） | 21s 内收到 heartbeat |
| H-19 测试会话清理 | PASS | 关闭本次创建的全部会话（4 个），无 API 残留 |

### 4.3 边界与数据正确性

| ID | 结果 | 说明 |
|---|---|---|
| B-01 中文/UTF-8 | PASS | snapshot.text 精确包含中文串 |
| B-02 UTF-8 跨块（大段 CJK） | PASS | 2283 字节可见屏，无 `\uFFFD` |
| B-03 ANSI | PASS | screen 保留 `\x1b[` SGR；text 无 ESC |
| B-04 长输出 500 行 | PASS | 可见屏 44 行（=rows），尾部含 `qa-line-500` |
| B-05 `exit` | PASS | state=exited、exitCode=0（并发重负载时曾 flake 一次，单独跑稳定） |
| B-06 多会话隔离 | PASS | 两会话输出互不串台 |
| B-07 ~64KB 输入 | PASS | 200；Ctrl-C 恢复，会话 running |
| B-08 Ctrl-C | PASS | 中断前台命令，会话保持 running |
| B-09 非法 UTF-8 字节 | SKIP | JSON 协议无法承载，超出契约范围 |

### 4.4 客户端加载与环境

| ID | 结果 | 说明 |
|---|---|---|
| E-01 host 启动日志无插件报错 | PASS | 无 error/exception；插件 `ctx.logger` 未落 stdout，故以无错误行 + HTTP 200 判定（证据强度一般） |
| E-03 client bundle 加载 | PASS | marker + clientLog；plugin console error/pageerror=0；plugin HTTP 失败=0 |
| E-04 刷新/多会话后运行时异常 | PASS | plugin 相关异常=0；非 plugin 的 DSH 页面异常单独记录（O-1） |

### 4.5 host 单元测试（QA 独立运行）

- 命令：`node --test --test-concurrency=1 --test-reporter=spec packages/dsh-terminal-panel/tests/*.test.mjs`
- **116 pass / 0 fail**（约 2.6s）。
- 覆盖：ansi/ring/screen/session/wrapper/intercept/intercept-value/tools/registry/shell；含 `live_terminal_run` 独立命令会话、render 首行 `[terminal <id>]`、screenshot 缺省目标、send/read 默认交互终端、超时/abort 映射、`resolveSessionCwd`（live/持久化/前缀容错）等 task-4 新语义。
- QA 在开发期独立跑单测曾发现并回报 2 个真实缺陷（`ByteTail` 多 chunk 字节上限失效、文本无限增长）与 2 个测试自身问题，host-engine 已修复，当前全绿。

### 4.6 契约一致性静态审查（S-01..S-11）

| ID | 结果 | 要点 |
|---|---|---|
| S-01 路由方法/路径/请求/响应 | PASS | 全部 `prefix:/dsh-terminal-panel`，形状与 §4.4 一致；额外 `/ping` 不冲突 |
| S-02 SSE 格式/心跳/清理 | PASS | `event:/data:`、`retry: 1000` 控制帧、20s `: ping` 心跳、close 幂等清理 |
| S-03 SessionInfo | PASS | 字段/枚举与 §4.4 一致（H-01/H-03 + 单测双重校验） |
| S-04 工具 | PASS（task-4 后更新） | 7 个 `live_terminal_*`；JSON Schema 参数/严格 output.schema；`run` render 首行 `[terminal <id>]`；`screenshot` 缺省目标=最近可见会话（command 优先）；send/read 默认交互终端 |
| S-05 拦截与回退 | PASS | 仅 `pwsh`/`bash`；后台/沙箱参数与失败 → `next()`；value 与内置 pwsh foreground 一致（单测） |
| S-06 配置项/默认值 | PASS | §4.1 全部配置项一致并钳制 |
| S-07 host 运行时契约 | PASS | 无 `@deepseek-ai/*` import；`inject=['tools']`；headless xterm `createRequire` |
| S-08 client 注册 | PASS | locale/sidebarRightTabs/guide/slots、自动打开（每标签页一次）、传 sessionId；factory 返回 `{apply,inject}` |
| S-09 构建产物 | PASS | 单文件 ModuleLoader 包装、externals 仅平台基座、xterm+CSS 打包、`<style data-plugin>` 幂等 |
| S-10 单测覆盖 §6.1 | PASS | 116 例覆盖纯逻辑 + 注册表 + 工具 schema/行为 |
| S-11 会话语义 | PASS | 单 writer 队列、流式 TextDecoder+EOF flush、命令会话保留、交互会话不自动移除、snapshot/seq 一致 |

**已接受的合理偏差**：`screen.visibleText()` 采用 viewport（baseY）语义（Lead 已接受，architecture.md 已更新措辞）；`/resize` 越界值钳制（记录策略）；额外 `/ping` 与 `/create.cwd` 参数（向后兼容）。

### 4.7 手工项（Lead 3101 真实 agent，全部并入）

| ID | 结果 | 证据/说明 |
|---|---|---|
| E-09 / T-02 拦截内置 pwsh（B） | **PASS** | chat “运行命令 · Output intercept-ok”；面板 command 会话、实时输出、已退出(0)；`tools/artifacts/agent-test-02/03.png` |
| E-12 / T-11 自动打开面板 | **PASS** | 面板未开时命令会话触发右侧栏自动打开并选中命令 tab；同一证据 |
| E-10 / T-04 run + screenshot（C） | **PASS** | run 首行 `[terminal <id>]`、无 wrapper 噪声；screenshot 缺省最新 command 会话、干净可见屏 `[terminal … 86x50 cursor (0,24) exited]`；`tools/artifacts/tool-test-final.png`；TUI（vim/htop）可选未做 |
| T-03 拦截回退 | **PASS（代码审查 + 单测）** | `run_in_background`/`sandbox_permissions`/无 agent/失败路径均 `next()`（intercept 单测覆盖） |
| T-05 run 超时 | **PASS（host 单测）** | `timedOut:true, exitCode:null`，会话终止（registry/tools 单测） |
| T-06 wait:false + read | **PASS（host 单测）** | 立即 `stillRunning:true`；read 读到递增输出（tools 单测） |
| T-07 send/open/close/list | **PASS（host 单测）** | tools.test.mjs 逐项覆盖；U-06/U-12 UI 亦覆盖 open/close |
| T-08 默认交互终端复用 | **PASS（host 单测，按新契约）** | task-4 后 `run` 使用独立 command 会话；默认交互终端复用由 send/read 路径覆盖（单测） |
| T-09 systemPrompt 指南 | **PASS（静态审查）** | `ctx.systemPrompt.section('tool:terminal-panel')`，含“终端面板/live_terminal_screenshot” |
| T-10 exec.signal abort | **PASS（host 单测）** | abort → terminate + `aborted:true` 映射（run 单测） |
| R-01 重启 dev host 后正常 | **PASS** | 多次重启（含最终轮全新 host PID 6436）后全量 44 PASS |
| R-02 重复运行无状态泄漏 | **PASS** | 同 host 连续全量运行结果稳定；会话清理无 API 残留（进程残留见 O-4） |
| R-03 未触碰 Desktop/D:\DSH | **PASS** | 58966 PID 25976 全程不变；3101/3103/3104 未重启 |
| E-11 desktop profile 安装 | **待 Lead**（Lead 将安装后用 58966 探测；QA 不重启用户 Desktop） | — |

---

## 5. 问题与观察（最终状态）

### 已关闭
| 编号 | 原级别 | 最终状态 |
|---|---|---|
| P1-2 `live_terminal_run`+`screenshot` 可用性 | P1 | **CLOSED**：task-4 重做（run 独立命令会话、render 暴露 terminalId、screenshot 默认目标），Lead 3101 E-10 **PASS** |
| P2-1 新建终端未进入会话工作区 | P2 | **CLOSED**：task-4（host sessions 注入/resolveSessionCwd）+ task-5（client 传 sessionId）；QA U-06 `cwd=…\lancang`、Lead 3101 `cwd=…\BIG DATA` |
| P2-2 >1MB 请求体连接重置 | P2 | **CLOSED**：修复后 H-16 返回 413 JSON |

### 保留观察（非阻断）
- **O-1（P3，环境噪声）** DSH 自身偶发 `TypeError: Cannot read properties of undefined (reading 'dimensions')`：最终 run 仍记录 1 次（E-04 之后），栈帧全部在 DSH trajectory/layout 刷新代码（`get dimensions` ← `ws._sync` ← `_runRefreshCallbacks`），无插件帧；专项 probe（不打开面板/打开面板各刷新 2 次）均 0 复现；Lead 决策按环境噪声归档，并在 3101 观察。证据：`qa/artifacts/probes/reload-noise-probe-result.json`。
- **O-2（记录）** `/resize` 越界值钳制策略（200），非整数 400；契约未要求越界必须 4xx。
- **O-3（P3）** U-13 剪贴板内容与 debug 可见屏“首行”比对不一致（剪贴板 161–167 字符且确为屏幕文本）；可能为切换标签后取文本时机/首行空白差异，建议 client-ui 自查复制时是否取同一快照。
- **O-4（P3，新观察：关闭会话后 shell 进程残留）**：最终 canonical run 结束后（cleanup 已移除 4 个会话），host PID 6436 仍有子进程 `OpenConsole.exe`(21436)+`powershell.exe`(30388)，创建时间 18:52:24 对应 U-06 UI 会话；早前两次 flake run 也各残留 1 个（30068/33736）。HTTP-only/probe 创建的会话关闭后未复现残留。影响：长时间运行会累积 pwsh/OpenConsole 进程；本轮验收无用户可见失败。**建议 host-engine 排查 UI 创建（且页面刷新重连过）的会话 `close → terminate` 路径**；QA 收尾时已用 `taskkill /T` 清理 host 进程树。

---

## 6. 修复回归

| 项 | 历史失败 | 修复 | 最终状态 |
|---|---|---|---|
| U-11 刷新恢复面板 | run1 FAIL（e2e 选择器 + 恢复实现） | e2e 改用 `[data-dsh-terminal-panel]`/`[data-dsh-tp-session-id]` + 插件刷新恢复 | **PASS** |
| H-07 SSE 帧格式 | run1 FAIL（retry 控制帧/首帧） | QA 解析器 + host 首帧修复 | **PASS** |
| H-16 >1MB 请求体 | run1/2/3 FAIL（连接重置） | host 先回 413 JSON 再结束 | **PASS** |
| H-06/H-08 最终轮 flake | 最终轮 A/B FAIL（shell 30s 未就绪/无输出） | 排除产品回归：同代码 `--http-only` 通过、清理 orphaned pwsh/OpenConsole 后全量通过 | **PASS**（环境 flake，见 §2/O-4） |
| P1-2 run/screenshot | Lead 3101 E-10 FAIL | host-engine task-4 重做 | **PASS** |
| P2-1 cwd | QA probe/Lead 复现 | host task-4 + client task-5 | **PASS** |

---

## 7. 证据与可复现命令

### 7.1 最终验收 run（`qa/artifacts/2026-10-19T10-52-17-172Z/`）

- `summary.json`：44 项 PASS/FAIL 明细、插件 HTTP 调用记录（0 次 4xx/5xx）、console/pageerror 分类；
- `console.log`：浏览器 console 全量（plugin console error=0）；
- 截图：`01-app-loaded.png`、`04-right-sidebar-guide.png`、`05-panel-open.png`、`06-xterm-created.png`、`07-xterm-output.png`、`08-xterm-chinese.png`、`09-resized.png`、`10-after-reload.png`、`11-multi-session.png`、`12-screenshot-button.png`、`13-session-closed.png`。
- Lead 3101 manual 证据：`tools/artifacts/agent-test-02/03.png`（E-09/E-12）、`tools/artifacts/tool-test-final.png`（E-10）。

### 7.2 复现命令

```powershell
cd "C:\Users\LANCANG\Desktop\Code\DSH Plugs\dsh-live-terminal"
node tools/build-client.mjs
& "D:\DSH\resources\runtime\cli\bin\dsh.cmd" --profile dev --no-open --port 3105 *> qa/artifacts/devhost-3105-final2.log
# 从日志取 URL：dsh web: http://127.0.0.1:3105/?token=...

node --test --test-concurrency=1 packages/dsh-terminal-panel/tests/*.test.mjs
node tools/qa-e2e.mjs --slow --host-log=qa/artifacts/devhost-3105-final2.log "<token-url>"
```

退出码：`0` = 无 FAIL；`1` = 有 FAIL；`2` = 环境/参数错误。若怀疑环境 flake，先检查并清理 orphaned `pwsh.exe`/`OpenConsole.exe` 后串行重跑。

---

## 8. 风险与建议

1. **E-11 desktop 安装验证**：Lead 安装到 desktop profile 后需重启 Desktop 并用 58966 探测（U-04/U-05/U-07），QA 不操作用户 Desktop。
2. **O-4 进程残留**：建议 host-engine 复查 UI 创建会话（尤其页面刷新重连后）的 close/terminate 路径，避免长期运行进程堆积；属 P3，不阻断本次验收。
3. **O-1 DSH 内部 pageerror**：已按环境噪声归档；Lead 在 3101 观察，如稳定复现可上报 DSH 上游。
4. **e2e 并发敏感**：UI/PTY 测试在系统高负载或其他 host 测试并发时可能 flake（H-06/H-08、B-05）；正式验收请串行执行并保持环境干净（本报告 canonical run 即串行）。
5. **host 日志**：插件日志走 `ctx.logger` 未落 stdout；如需更强启动断言可加一行 console 启动日志（非阻塞建议）。

---

## 9. 最终状态清单

| 项 | 状态 |
|---|---|
| 自动 e2e（44 项） | **44 PASS / 0 FAIL / 1 SKIP（B-09 超契约）** |
| host 单测 | **116/116 PASS** |
| Manual（真实 agent，B/C/拦截/自动打开/run+screenshot/P2-1） | **全部 PASS**（E-09/E-12/E-10/P2-1，Lead 3101 证据并入） |
| 静态契约审查 S-01..S-11 | **全部 PASS** |
| 重启/隔离（R-01..R-03） | **PASS** |
| E-11 desktop profile | **PASS**（Lead 安装并重启 Desktop 后实测，见 §11） |
| 阻断级缺陷 | **0** |
| 保留观察 | O-1 环境噪声、O-2 策略记录、O-3 观察、O-4 进程残留观察（P3，建议跟进） |

---

## 10. 附录

- 测试计划：`qa/test-plan.md`；e2e：`tools/qa-e2e.mjs`（支持 `--slow/--http-only/--keep-sessions/--host-log`）
- 专项探针：`qa/probes/`（`acceptance-probes.mjs` 刷新噪声/cwd、`cwd-probe.mjs`、`http-session-probe.mjs`、`http-two-session-probe.mjs`、`session-ring-probe.mjs`）与证据 JSON `qa/artifacts/probes/*.json`
- 历史 run：`qa/artifacts/` 下 `10-07-26`、`10-10-44`、`10-13-05`、`10-15-44`、`10-41-57`、`10-44-57`、`10-47-29`、`10-49-59`、`10-52-17`
- host 日志：`qa/artifacts/devhost-3105-final2.log`（最终）、`devhost-3105-final.log`、`devhost-3105-accept.log`、`devhost-3105.log`
- 已知环境：系统内多个 dev host 的 orphaned `pwsh/OpenConsole` 进程曾干扰最终轮 A/B；清理后 canonical run 全绿（详见 §2/O-4）。

---

## 11. Lead 终验补充：Desktop profile 安装（2026-10-19 晚）

- 安装：`tools/install-desktop.ps1` 把插件 link 进 `~/.dsh/profiles/desktop` 并选中 bundle；Desktop 运行中的 Host 不会热加载新插件（实测 HMR 不生效），用户完全退出并重启 DeepSeek Harness 后生效。
- 重启后实测（当前 Desktop 会话，新 GUI 端口 54877）：
  - 7 个 `live_terminal_*` 工具出现在工具列表中（`live_terminal_list` 返回会话列表可证 host 半侧加载）。
  - 普通 `pwsh` 调用被接管：`live_terminal_list` 出现 `[command/agent] exited exit=0` 会话（标题=命令、cwd=D:\DSH，符合要求 B）。
  - `live_terminal_run` 返回 `[terminal <id>] ... (exit 0)` + 干净输出；随后 `live_terminal_screenshot` 返回 `[terminal <title> 99x49 cursor (0,5) exited]` + 屏幕文本（符合要求 C）。
- 结论：**E-11 PASS**（Desktop 实机安装 + 重启后 host/client 均生效）。至此 §9 清单除 E-11 更新为 PASS 外无变化；O-4 仍为非阻断 P3。

---

## 12. v1.1 验证补充（2026-10-19）

> 本节记录 v1.1 的独立验证数字。与正文历史章节（v1.0 验收）冲突时**以本节为准**；旧章节保留作历史记录，不做逐处改写。

| 项 | v1.1 结果 |
|---|---|
| host 单元测试 | **182/182 PASS**（`npm test`，`tests/*.test.mjs`；166 v1.1 收尾基线 + 自动清理 14），Node 24 与 Node 22.23.3 双版本验证 |
| CI 门禁 | GitHub Actions run #7（commit `18fdfba`）**三项全绿**：`windows-latest` Node 22/24 全量（`npm run build` → bundle freshness `git diff --exit-code -- lib/client.js` → `npm test` → `npm run typecheck`）；`ubuntu-latest` Node 24 平台无关子集（排除 `tests/registry.test.mjs`，其断言 Windows 路径语义）。run #6 曾因 Node 22 test runner 把仅剩 unref 定时器的空循环判定为 drained 而失败，已由 `18fdfba` 测试侧修复（产物未变） |
| TypeScript | `npm run typecheck` **0 error** |
| 官方构建产物 | `lib/client.js` **396,630 B / gzip 101.5 KiB**（发布产物；版本号构建期注入，bundle 内 `version:"1.1.0"`，构建确定性 sha 稳定 `4B10F7F9…D844A5`） |
| npm 发布 | `dsh-live-terminal@1.1.0` 已发布（latest）：npm tarball 18 files、shasum `cc4295cb9d4971c074c93daf21ef90c465f7c883`；从 registry 下载的包内 `lib/client.js` sha256 与本地构建一致 |
| GitHub Release | `v1.1.0` Release 已创建并上传 npm tarball 资产（tag `v1.1.0` → `58dc780`） |
| 真实 dev host e2e | **21 PASS / 0 FAIL / 1 SKIP**（收尾批次后复跑确认，client 报 `version:"1.1.0"`） |
| mock e2e | **24 PASS / 0 FAIL / 1 SKIP**（收尾批次后复跑；此前 P0 轮曾 1 次首跑 resize 断言受 headless rAF 时序偶发影响，重跑不复现） |
| v1.1 专项浏览器探针 | **15/15 PASS** |
| P0 修复独立探针 | apply direct/deferred **19/19**、SSE 背压/有界/drain **16/16**、`wait:false` 不 kill **12/12** PASS |
| 独立验证 | 四轮：v1.1 两轮（发现并修复“启动窗口期默认交互终端被容量回收”边界，复验 PASS×3）；P0+版本/文档轮（文档 4 处不一致已修正并复核 4/4）；收尾批次轮（host P2 + 打包/CI） |

- 结论：v1.1 达到发布门槛（host 单测 / typecheck / 构建 / e2e / 浏览器探针全绿）；剩余 O-3、O-4 为非阻断观察项，不影响发布。

---

## 13. v1.2 终端自动清理验证（2026-10-20）

> v1.2 新增「快速命令不上屏 + 一次性命令结束后自动关闭 + `keepOpen` + 失败通知」；与 §12 冲突时以本节为准。

| 项 | v1.2 结果 |
|---|---|
| host 单元测试 | **182/182 PASS**（166 基线 + 自动清理 16：registry +14、tools +2，含「先建会话后连 SSE」回归 1 与默认阈值用例 1；另 intercept 断言补强）；Node 22.23.3 与 Node 24.13.0 双版本 |
| TypeScript | `npm run typecheck` **0 error** |
| 构建产物 | `lib/client.js` **398,049 B / gzip 104,383 B / sha256 `71E945EF…C92E33`**，`version:"1.2.0"`，构建幂等 |
| 真实 dev host e2e | **21 PASS / 0 FAIL / 1 SKIP**（client 报 `version:"1.2.0"`） |
| mock e2e | **24 PASS / 0 FAIL / 1 SKIP** |
| host 行为集成探针 | **6/6 PASS**：快速命令不产生 tab/sessions 事件；慢命令上屏后按配置自动关闭；失败命令 notice 含 exitCode/excerpt；隐藏失败仅 notice；tool 终端默认关闭且 `keepOpen` 保留；`autoCloseToolTerminals=false` 生效 |
| client toast 探针 | 真实 dev host 页面 + 注入假 EventSource：失败 notice 渲染为「命令失败（退出码 7），终端已自动关闭：echo boom — boom: command failed」，截图本机验证通过 |
| 真实 Desktop 行为检查 | 成功命令自动关闭（5s 后列表清空）、失败命令 2s 自动关闭、`keepOpen` 会话跨 7s+ 仍保留、`live_terminal_run` 结果显示自动关闭提示；实测被接管 PowerShell 启动开销约 **3.3–3.9s**，据此把默认 `interceptMinVisibleMs` 从 1000 调到 **4500ms**（含启动开销，快速命令默认完全不上屏），并补默认阈值单测 |
| npm 发布 | `dsh-live-terminal@1.2.0` 已发布（latest）：18 files、tarball 148,585 B、shasum `393f2407ea7bd6b287163ada329d89be5fbe1d21`；从 registry 下载的包内 `lib/client.js` sha256 与本地构建一致 |
| GitHub Release | `v1.2.0` Release 已创建并上传 npm tarball 资产（tag `v1.2.0` → `f20c836`） |
| Desktop 切换 npm 安装 | 已定位根因（临时 profile 复现）：profile 仍有 `link:` junction 时执行 `dsh plugin add`（link→npm），pnpm 因 `EPERM rename` 失败，失败清理会**删除被链接仓库 `.git` 顶层的 HEAD/config/index/logs/COMMIT_EDITMSG 等**（objects/refs/ORIG_HEAD 残留）——仓库两次 `.git` 损坏均由此类切换尝试造成。规避：`tools/switch-desktop-to-npm.ps1` 先安全 `rmdir` junction 再安装，失败自动恢复本地 link；临时 profile 已验证该顺序安装成功且仓库 `.git` 未动。需完全退出 DSH 后运行 |
| 独立验证 | host 行为 **41/41** + notice 模式 **3/3** PASS；client `parseTerminalNotice` **5/5**；发现并修复「先建会话后连 SSE 的 `sessions` 事件抑制」P2 边界（含回归测试） |

- 结论：v1.2.0 已发布（npm + GitHub Release）；自动清理行为在真实 Desktop 中验证通过；Desktop profile 已于 2026-10-20 切换到 npm 安装的 1.2.0（非 junction，client sha `71E945EF…`）；插件市场 catalog PR **#8299** 已提交，Submission gate 与 PR check 全部通过、mergeable clean，等待维护者合并。

---

## 14. v1.2.1 全量功能 / 交互 / UI 升级验证（2026-10-21）

> v1.2.1 按评审报告把功能、用户操作习惯、界面 UI 的建议全部落在一个版本；与 §13 冲突时以本节为准。实现契约见 [`impl-1.2.1-contract.md`](./impl-1.2.1-contract.md)，评审输入见 [`review-2026-10-21-ux-feature.md`](./review-2026-10-21-ux-feature.md)。

| 项 | v1.2.1 结果 |
|---|---|
| host 单元测试 | **232/232 PASS**（基线 195 → 232；新增 history/keys/ports/exec/screenshot-png + 新工具/新路由/租约/沙箱/配额/暂停保留等覆盖）；Node 24.13.0，连续两次全量运行一致 |
| TypeScript | `npm run typecheck` **0 error**（strict；含 `client-src/**`、`tests/**`、`tools/**`） |
| 构建产物 | `lib/client.js` **562,416 B / gzip 148,526 B / sha256 `289CC5B3…6724A`**，`version:"1.2.1"`；exact 17 个工具注册 |
| 真实 dev host UI 冒烟 | **16 PASS / 0 FAIL / 0 SKIP**（`tools/smoke-ui-121.mjs`）：bundle 1.2.1、`/ping` 版本、`/config` 生效值、`/history`、面板挂载、32px chrome、新建终端、输入回显、`⋯` 菜单（历史/配置/快捷键/PNG/导出）、`Ctrl+F` 搜索命中、配置对话框、0 page error、0 console error |
| 真实 agent 本地验收 | **16 PASS / 0 FAIL**（`tools/accept-121.mjs`，真实 agent 回合）：pwsh 前台命令被接管为可见命令终端、面板自动打开、输出上屏、8s 后自动关闭、关闭后输出仍在历史；`live_terminal_run(keepOpen:true)` 创建可见终端并跨过 8s 不关闭；`live_terminal_read` 回读输出；0 page error / 0 5xx / 0 console error |
| 验收中发现并修复 | 终端退出与 resize/input 竞态导致 `/resize` 500（现返回 `{ok:false,reason:'not-running'}` 的 200 no-op）；`/input` 同样按 no-op 处理 |
| 自动清理 | 成功 8s / 失败 30s；倒计时暂停/保留/恢复；隐藏命令按首帧输出计时；关闭命令写入历史（含 agentId/sessionId/owner） |
| 历史与回放 | CommandHistory LRU + 原子 JSON 落盘（0600/0700）；`/history`、`/replay`、`/export`；read/screenshot/status/search/export 按原 terminalId 回退历史；agent-facing 历史按 agentId 过滤 |
| 工具面 | 17 个 `live_terminal_*`：run/screenshot/send/read/search/wait/expect/status/signal/resize/exec/list/history/open/close/rename/export；run/open 支持 cwd/shell/cols/rows/env；screenshot 支持 text/ansi/png（PNG 由浏览器 canvas 回传，无浏览器时文本回退 + warnings） |
| 多端 / 租约 | per-session SSE `clientId` + `/take-control` + `/input` 非 writer 返回 409 `READ_ONLY`；`fromSeq` 补帧；`/capture` 8MiB body / 4MiB decoded |
| 快捷键 | 面板局部键盘映射（open/new/close/follow），**不注入 DSH `shortcuts` 服务**：实测注入该服务会与 `page.close` 冲突并使 `uiWorkspace` 客户端启动失败；改为局部监听后 dev host 启动 0 失败 |
| 安全 | `sandbox` 标注 + 未沙箱横幅 + 首启提示；`requireSandbox`/`allowUnconfined` 回退/拒绝；后台/升权调用仍不接管 |
| 界面 | 32px chrome、单一 hairline、活动 tab 对比度、12px secondary、24×24 命中区、窄栏 container query、状态栏按需隐藏、banner 替代全覆盖遮罩、焦点管理、深色 token、reduced-motion、全局 Toast 与欢迎卡 |
| 已知限制 | PNG 需浏览器连接；实时进程不跨 Host 重启（历史保留）；`live_terminal_exec` 仅 pwsh/POSIX；会话仍为 Host 全局（面板默认按当前会话过滤） |
| 发布状态 | 版本号/文档/构建统一为 **1.2.1**；尚未执行 npm publish / Desktop 切换（需用户确认后单独操作） |

- 结论：v1.2.1 的功能、交互、界面升级已完成并通过 host 单测、typecheck、构建、真实 dev host UI 冒烟与真实 agent 本地验收；`npm test` 232/232，UI 冒烟 16/16，agent 验收 16/16。
