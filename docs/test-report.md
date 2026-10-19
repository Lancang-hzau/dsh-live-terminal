# dsh-terminal-panel 独立测试报告（正式验收）

| 项 | 值 |
|---|---|
| 报告版本 | v1.1（正式验收；Lead 3101 manual 结果部分并入，E-10 重做项待最终结果后更新） |
| 测试执行 | qa-verifier（独立 QA） |
| 日期 | 2026-10-19 Asia/Shanghai |
| 契约 | `docs/architecture.md`（含 2026-10-19 Lead 契约更新：`live_` 前缀 / 自动打开 / 截图=文本屏幕） |
| 被测版本 | `packages/dsh-terminal-panel`（host `lib/index.js` + `lib/host/**`；client `client-src/**` → `lib/client.js` 构建产物） |
| 测试环境 | DSH 0.2.1-rc.2，dev profile，QA 专用 dev host **127.0.0.1:3105** |
| 自动化入口 | `tools/qa-e2e.mjs`（Playwright 系统 Chrome + 真实 fetch/SSE 断言） |
| 正式验收 run | `qa/artifacts/2026-10-19T10-15-44-399Z/`（`summary.json` / `console.log` / 13 张截图） |
| 测试计划 | `qa/test-plan.md` |

---

## 0. 结论（TL;DR）

- **正式验收 run：PASS 44 / FAIL 0 / SKIP 1 / MANUAL 29**（MANUAL 中的静态审查与重启项已由 QA 完成并判 PASS；Lead 3101 真实 agent 补测已确认 E-09/T-02 拦截、E-12/T-11 自动打开 **PASS**，E-10/T-04 发现 **P1** 由 host-engine task-4 重做中，其余 manual 待并入）。
- 验收门槛（architecture.md §6.3）自动可测部分 **全部通过**：host 启动无插件报错、`/sessions` 带 cookie 200、client bundle 无 console error、面板可开/可输入/可 resize/可关、SSE 实时输出、UTF-8/ANSI/长输出正确、未鉴权 401、错误返回 JSON。
- 本轮重点回归的 3 个历史 FAIL 均已转 PASS：**U-11 刷新恢复面板**、**H-07 SSE 帧格式**、**H-16 >1MB 请求体 413 JSON**。
- host 单测独立运行 **105/105 PASS**；client 构建 **392,975 B（383.8 KiB，gzip 100.2 KiB）**，ModuleLoader factory 模拟返回 `{apply, inject}` 正常。
- 剩余非阻断问题 2 项 + 观察 2 项（见 §5），其中 **P2-1「新建终端进入会话工作区」未完全闭环**（host 支持 `sessionId` 但解析未生效、client 也未传 `sessionId`），已拆分给 host-engine（task-4，sessions 注入时序）与 client-ui（task-5，传 sessionId）；不影响验收门槛。
- **Lead 3101 真实 agent manual 结果（部分并入，最终结果待并入）**：E-09 拦截 pwsh **PASS**、E-12 自动打开面板 **PASS**（同一证据：chat 显示“运行命令 · Output intercept-ok”，右侧栏自动打开并出现 command 会话与输出、状态“已退出(0)”）；E-10 `live_terminal_run`+`screenshot` 发现 **P1 可用性问题**，host-engine 在 **task-4** 重做（run 改独立命令会话 + render 暴露 terminalId + screenshot 默认目标）；其余 manual 项待 Lead 最终结果。本报告保持“待并入”状态，最终 manual 结果到达后更新 §3/§4.7/§5/§9。
- 未触碰用户 Desktop DSH（58966 PID 25976 全程不变）与 `D:\DSH`；未重启 3101/3103/3104；测试期间未发送任何对话消息、未消耗模型额度。

---

## 1. 环境与版本

| 项 | 值 |
|---|---|
| dev host 命令 | `& "D:\DSH\resources\runtime\cli\bin\dsh.cmd" --profile dev --no-open --port 3105` |
| dev host 日志 | `qa/artifacts/devhost-3105-accept.log`（启动后仅 `dsh web:` + llm model listing，无插件错误行） |
| 端口 | 3105 = QA host（PID 32024）；3101 = Lead 集成 host（PID 31432，未动）；3103/3104 = 队友 host（未动）；58966 = 用户 Desktop（PID 25976，未动） |
| 浏览器 | 系统 Chrome（`C:/Program Files/Google/Chrome/Application/chrome.exe`），Playwright headless |
| client 构建 | `node tools/build-client.mjs` @ 2026-10-19 18:15:04；externals 与契约 §5.3 一致；xterm + CSS 已打包进单文件 |
| host 单测 | `node --test --test-concurrency=1 packages/dsh-terminal-panel/tests/*.test.mjs` → **105 pass / 0 fail**（3.2s） |

---

## 2. 执行记录与总体统计

| 阶段 / run | 说明 | 结果 |
|---|---|---|
| 阶段 A 干跑（3104 skeleton） | 验证 e2e 机制（UI 选择器、cookie、401、JSON/SSE 断言） | 6 PASS / 27 FAIL（host 路由尚未实现，预期） |
| 预验收 run 1 `2026-10-19T10-07-26-684Z` | 首次全量（U-11/H-07 为测试脚本问题，H-16 为产品问题） | 40 PASS / **3 FAIL** / 1 SKIP |
| 预验收 run 2 `2026-10-19T10-10-44-820Z` | 修 e2e SSE 解析与 guide 选择器 | 42 PASS / **1 FAIL**（H-16） |
| 预验收 run 3 `2026-10-19T10-13-05-088Z` | 增加 E-04（刷新后无 plugin 异常）；host 修复前 | 43 PASS / **1 FAIL**（H-16） |
| **正式验收 run `2026-10-19T10-15-44-399Z`** | 重建 client + 重启 3105 host 加载最新 host 代码；`--slow`（含 20s SSE 心跳）+ `--host-log` | **44 PASS / 0 FAIL / 1 SKIP / 29 MANUAL**（84.7s） |

> SKIP = `B-09 非法 UTF-8 字节输入`：JSON 协议无法承载非法 UTF-8，超出契约范围（见 §4.3）。
> MANUAL 29 = 静态审查 11（S-01..S-11，QA 已完成并判 PASS）+ 重启/隔离 3（R-01..R-03，QA 已完成）+ QA 静态可判 3（T-01/T-09/T-10）+ 需 Lead 真 agent 补测项（E-09/T-02、E-12/T-11 已 PASS；E-10/T-04 P1 重做中；T-03/T-05/T-06/T-07/T-08/E-11 待最终结果）。

---

## 3. 验收门槛（architecture.md §6.3）

| 门槛 | 结果 | 证据 |
|---|---|---|
| dev host 启动无插件报错 | **PASS** | `qa/artifacts/devhost-3105-accept.log`；`/ping` 200、`/sessions` 200 |
| `GET /dsh-terminal-panel/sessions` 带 cookie 200 | **PASS** | H-01（`summary.json`） |
| client bundle 加载无 console error | **PASS** | E-03：marker=true、clientLog=true、pluginConsoleErrors=0、pageErrors=0；`01-app-loaded.png` |
| 面板可开、可输入、可 resize、可关 | **PASS** | U-04/U-05/U-07/U-09/U-10；`04/05/07/09/13-*.png` |
| SSE 实时输出 | **PASS** | H-08：首帧 snapshot、output 帧延迟 116ms、`seq` 单调递增（84→88）、data keys `{id,seq,chunk}` |
| 拦截生效（需真实 agent） | **PASS**（Lead 3101 manual，待并入最终记录） | E-09/T-02：chat 显示“运行命令 · Output intercept-ok”，面板出现 command 会话与实时输出、状态“已退出(0)”，工具结果正常 |
| agent 命令会话自动打开面板（§5.2） | **PASS**（Lead 3101 manual，同一证据） | E-12/T-11：右侧栏自动打开终端面板并显示新的 command 会话 |
| `live_terminal_screenshot` 返回当前屏幕文本 | **待 Lead 最终结果（P1 重做中）** | E-10 在 3101 暴露 P1 可用性问题；host-engine task-4 重做（run 独立命令会话 + render 暴露 terminalId + screenshot 默认目标），QA 待复测 |
| desktop profile 安装后同样工作 | **待 Lead**（不在 QA 自动化范围，不重启 58966） | §9 E-11 |

---

## 4. 分项结果

### 4.1 UI e2e（A：可见终端面板）

| ID | 结果 | 说明 / 证据 |
|---|---|---|
| U-01 打开 dev GUI | PASS | 标题 DeepSeek Harness，`__DSH_TERMINAL_PANEL__=true`；`01-app-loaded.png` |
| U-02 关闭预览弹窗 | PASS | 无遮挡；`02-after-overlays.png` |
| U-03 打开会话（不发送消息） | PASS | 复用已有会话「大数据实验手册操作指导」；`03-conversation.png` |
| U-04 Ctrl+Shift+B → guide「终端面板」 | PASS | 右侧栏展开，guide 入口 1 个；`04-right-sidebar-guide.png` |
| U-05 点 guide → 面板 body | PASS | `[data-dsh-terminal-panel="body"]` 渲染；工具栏按钮：新建终端/刷新/重新连接/复制屏幕/关闭终端；`05-panel-open.png` |
| U-14 空态/新建入口 | PASS | `[data-dsh-tp-action=create]` 存在，phase=ready |
| U-06 新建终端 → xterm | PASS | 新会话 running，cols/rows=100x30（新建时尺寸），xterm 挂载；`06-xterm-created.png` |
| U-07 输入命令 → 屏幕输出 | PASS | `Write-Output 'qa-hello-…'`，6ms 内屏幕出现（xterm 可见屏） |
| U-08 中文输出 | PASS | `中文-qa` 正确渲染，无 `�`；`08-xterm-chinese.png` |
| U-09 resize | PASS | 视口 1440x900→1200x680：host 尺寸 100x30→68x31，观察到 POST `/resize`；`09-resized.png` |
| U-10 UI 关闭会话 | PASS | 关闭按钮 → host `/sessions` 移除该 id；`13-session-closed.png` |
| U-11 刷新后重开面板/重连 | PASS | host 会话保留、snapshot 保留旧输出、UI 重新挂载并恢复屏幕文本（`restoredInUi=true`）；`10-after-reload.png` |
| U-12 多会话 + 标签切换 | PASS | 两个终端、切换标签后各自屏幕正确、host snapshot 内容互不串台；`11-multi-session.png` |
| U-13 面板截图/复制按钮 | PASS | 剪贴板 167 字符、内容为当前屏幕文本（含 prompt 与命令输出）；`12-screenshot-button.png`；观察项见 §5-O-3 |

### 4.2 HTTP/SSE 契约（architecture.md §4.4）

| ID | 结果 | 说明 |
|---|---|---|
| H-01 `/sessions` 200 + SessionInfo[] | PASS | 字段/枚举校验通过；含已退出保留会话语义由 B-05 覆盖 |
| H-02 无 cookie → 401 | PASS | `401`；契约 §4.4 admit 失败行为 |
| H-03 `POST /create` | PASS | 200 `{session}`；SessionInfo 合法（interactive/running/cwd/cols/rows） |
| H-04 `/create` 缺省尺寸 | PASS | 默认 120x30 |
| H-05 `GET /snapshot` | PASS | `{info,screen,text,cursor}` 形状正确 |
| H-06 `/input` → snapshot 输出 | PASS | 命令输出出现在 snapshot.text |
| H-07 SSE 帧格式/首帧 | PASS | `Content-Type: text/event-stream`；首事件 `snapshot`；data 为 JSON（含 info/screen/text/cursor/seq）；`retry:` 控制帧不再误判 |
| H-08 SSE 实时性/seq | PASS | 延迟 116ms（<2s 目标）；output 帧 `{id,seq,chunk}` 且 seq 单调 |
| H-09 全局 `/events` sessions 事件 | PASS | 新建会话后收到 `sessions` 事件（data=`{sessions}`） |
| H-10 `/resize` 生效 | PASS | 200 `{ok:true}`，snapshot.info 同步 90x25 |
| H-11 `/close` | PASS | 200；`/sessions` 移除；snapshot 404 `{error}` |
| H-12 snapshot 缺 id/未知 id | PASS | 400/404 + `{error:string}` |
| H-13 input 未知 id | PASS | 404 + `{error}` |
| H-14 resize 参数校验 | PASS | 非整数→400；0/负数→安全钳制（120x24/120x30 等，记录策略，契约未强制 4xx） |
| H-15 非法 JSON body | PASS | 400 + 错误 JSON；后续请求正常 |
| H-16 >1MB 请求体 | PASS（本轮修复） | 返回 **413** JSON；服务未崩溃（`/sessions` 仍 200） |
| H-17 SSE 反复连接/断开 | PASS | 5 次连接/断开后服务正常，新 SSE 首帧正常 |
| H-18 20s 心跳注释 | PASS（--slow） | 21s 内收到 1 个 heartbeat 注释帧 |
| H-19 测试会话清理 | PASS | 运行结束关闭本次创建的全部会话（4 个），无泄漏 |

### 4.3 边界与数据正确性

| ID | 结果 | 说明 |
|---|---|---|
| B-01 中文/UTF-8 | PASS | snapshot.text 精确包含 `中文测试-终端面板-…` |
| B-02 UTF-8 跨块（大段 CJK） | PASS | 2283 字节可见屏，无 `\uFFFD` |
| B-03 ANSI | PASS | snapshot.screen 保留 `\x1b[` SGR；snapshot.text 无 ESC 且含彩色输出文本 |
| B-04 长输出 500 行 | PASS | 可见屏 30 行（=rows），尾部含 `qa-line-500`，无崩溃 |
| B-05 交互会话 `exit` | PASS | state=exited、exitCode=0，快照仍可读 |
| B-06 多会话隔离 | PASS | 两会话 snapshot 互不含对方输出 |
| B-07 ~64KB 输入 | PASS | 200；随后 Ctrl-C 恢复，会话仍 running |
| B-08 Ctrl-C（`\u0003`） | PASS | 中断 Start-Sleep，会话保持 running |
| B-09 非法 UTF-8 字节 | SKIP | JSON 协议无法承载，超出契约范围 |

### 4.4 客户端加载与环境

| ID | 结果 | 说明 |
|---|---|---|
| E-01 host 启动日志无插件报错 | PASS（证据较弱） | 日志无 error/exception 行；注意插件 `ctx.logger` 输出未进 stdout，仅见 `dsh web:` 与 LLM model listing，故以“无错误行 + HTTP 200 证据”判定 |
| E-03 client bundle 加载 | PASS | marker=true、`[dsh-terminal-panel] client half loaded`；plugin console error=0、pageerror=0、plugin HTTP 失败=0 |
| E-04 刷新/多会话后 plugin 运行时异常 | PASS | plugin 相关 pageerror/console error=0；非 plugin 的 DSH 页面异常单独记录（见 §5-O-1） |

### 4.5 host 单元测试（QA 独立运行）

- 命令：`node --test --test-concurrency=1 --test-reporter=spec packages/dsh-terminal-panel/tests/*.test.mjs`
- 结果：**105 pass / 0 fail**（8 个测试文件：ansi/ring/screen/session/wrapper/intercept/intercept-value/tools）。
- QA 在开发期独立运行曾发现并回报 2 个真实缺陷（`ByteTail` 多 chunk 下字节上限失效、文本无限增长）与 2 个测试自身问题（Readable 分块合并导致的时序断言、wrapper 回显测试数据顺序），host-engine 均已修复/调整，当前全绿。

### 4.6 契约一致性静态审查（S-01..S-11）

| ID | 结果 | 要点 |
|---|---|---|
| S-01 路由方法/路径/请求/响应 | PASS | 全部 `prefix:/dsh-terminal-panel`；路径/方法/响应形状与 §4.4 一致；额外 `/ping`（不冲突，调试用途） |
| S-02 SSE 格式/心跳/清理 | PASS | `event:/data:` 帧、`retry: 1000` 控制帧、20s `: ping` 心跳；`req/res close/error` 幂等清理订阅 |
| S-03 SessionInfo | PASS | 字段/枚举与 §4.4 一致（运行时 H-01/H-03 + 单测双重校验） |
| S-04 工具 | PASS | 7 个工具均为 `live_terminal_*`；parameters 为 JSON Schema 对象、`additionalProperties:false`；output.schema 严格；render 返回 text blocks |
| S-05 拦截与回退 | PASS | 仅 `pwsh`/`bash`；`run_in_background`/`sandbox_permissions` → `next()`；无 agent/失败 → `next()`；value 形状与内置 pwsh foreground 一致（`intercept-value.test.mjs`） |
| S-06 配置项/默认值 | PASS | `interceptShellTools/shellPath/scrollback/maxOutputBytes/maxSessions/commandTimeoutMs/retainExited` 与 §4.1 一致并做上下界钳制 |
| S-07 host 运行时契约 | PASS | 无 `@deepseek-ai/*` import；`inject=['tools']`；headless xterm 经 `createRequire` 懒加载 |
| S-08 client 注册 | PASS | locale zh/en、`sidebarRightTabs.register`(multiple/priority/guide)、`slots.inject('sidebar.right.pane.tab')`、guide 文案「终端面板」、自动打开（每标签页一次）；构建产物 factory 返回 `{apply,inject:["slots","locale","sidebarRight","sidebarRightTabs"]}` |
| S-09 构建产物 | PASS | 单文件 `lib/client.js`、`window.__ModuleLoader__.load({id,factory})` 包装、externals 仅平台基座、xterm+CSS 打包、`<style data-plugin>` 幂等注入 |
| S-10 单测覆盖 §6.1 | PASS | ansi/ring/wrapper 解析/value 映射/工具 schema/会话行为均有测试（105 例） |
| S-11 会话语义 | PASS | 单 writer promise 队列、流式 TextDecoder + EOF flush、命令会话保留 `retainExited`、交互会话不自动移除、snapshot 与 seq 一致 |

**静态审查中确认的合理偏差（Lead 已接受/记录，不改实现）**：
1. `screen.visibleText()` 使用 xterm viewport（`baseY`）语义，而非 §4.2 字面「buffer.active 0..rows-1 行」；这更符合“当前可见屏”的语义（B-04 证明只有 viewport 语义才能读到尾部输出），Lead 已同意稍后更新契约措辞。
2. `/resize` 越界数值被钳制为合法尺寸（200），仅类型错误返回 400；契约未规定越界必须 4xx，记录实现策略。
3. 路由额外提供 `/ping` 与根路由（调试/健康检查），不影响契约路径。
4. `/create` 新增可选 `cwd` 参数（契约未列，向后兼容），用于 P2 cwd 修复路径。

### 4.7 手工项（QA + Lead 3101）

| ID | 结果 | 证据/说明 |
|---|---|---|
| R-01 重启 dev host 后插件仍正常 | **PASS** | 旧 3105 进程停止 → 新 host（PID 32024）启动 → 正式全量 e2e 44 PASS |
| R-02 重复运行无状态泄漏 | **PASS** | 同一 host 连续 3 次全量 run（run1/2/3）结果稳定，无端口/会话泄漏；每次自动清理 |
| R-03 未触碰 Desktop DSH / D:\DSH | **PASS** | 58966 PID 25976 全程不变；3101/3103/3104 未重启；QA 仅写仓库 `qa/**`、`docs/test-report.md`、构建产物（Lead 指示） |
| E-09 / T-02 拦截内置 pwsh | **PASS**（Lead 3101 实测，待并入最终记录） | chat 显示“运行命令 · Output intercept-ok”；面板出现 command 会话与实时输出，状态“已退出(0)”；工具结果正常 |
| E-12 / T-11 自动打开面板 | **PASS**（Lead 3101 实测，同一证据） | 右侧栏自动打开并显示新 command 会话；每标签页一次行为待 Lead 最终记录补充 |
| E-10 / T-04 run + screenshot | **P1，重做中** | Lead 3101 实测发现可用性问题；host-engine task-4 重做，之后 QA 按 Lead 指令复测 |
| 其余 T-03/T-05/T-06/T-07/T-08/E-11 | **待 Lead 最终结果** | 判定标准见 §9 |

---

## 5. 问题与观察列表

### P1-2（Lead 3101 实测发现，host-engine task-4 重做中）`live_terminal_run` + `live_terminal_screenshot` 可用性
- **级别**：P1（工具层可用性；面板 A/B/C-text 主链路不受影响，但模型自检/截图目标不可控）
- **发现方**：Lead 在 3101 用真实 agent 会话执行 E-10（`live_terminal_run` 运行命令 + `live_terminal_screenshot`）。
- **期望**：`live_terminal_run` 返回的 `terminalId` 指向稳定、可被 `live_terminal_screenshot` 直接截取的可见终端；截图默认目标可预测（能截到刚运行命令的屏幕）。
- **实际**：E-10 暴露 run 的运行载体与 screenshot 默认目标不匹配/不可控（具体现象以 Lead 记录为准）。
- **处置**：host-engine **task-4** 重做（`run` 改为独立命令会话、render 暴露 `terminalId`、明确 screenshot 默认目标）；重做完成后 QA 视 Lead 指令复测 E-10/T-04/T-05/T-06 并更新本报告。
- **证据**：Lead 3101 手工记录（待并入）；相关实现 `lib/host/tools.js`/`lib/host/registry.js`。

### P2-1（未完全闭环）新建终端未进入会话工作区
- **级别**：P2（UX，不阻断验收）
- **期望**：在某个会话中打开终端面板并点“新建终端”，shell 的 cwd 应为该会话的工作目录（如 `C:\Users\LANCANG\Desktop\Code\BIG DATA`）。
- **实际**：cwd = host 启动目录 `C:\Users\LANCANG\Desktop\Code\DSH plugin`。host 侧 `/create` 已支持 `sessionId` 并调用 `registry.resolveSessionCwd(sessionId)`，但实测未生效；client 侧 `Panel.tsx` 调 `createSession(cols, rows)` 未传 `sessionId`。
- **复现步骤**：
  1. 启动 dev host（3105）+ 打开 GUI，进入「大数据实验手册操作指导」会话；
  2. 打开右侧栏 → 终端面板 → 新建终端；
  3. `GET /dsh-terminal-panel/sessions` 查看该会话 `cwd`（或面板内执行 `Get-Location`）→ 得到 host 启动目录。
  4. 直接 `POST /dsh-terminal-panel/create {"sessionId":"session-fbb8fd5d-…"}` → 同样得到启动目录；而 `POST /create {"cwd":"C:\\…\\BIG DATA"}` → 正确返回 BIG DATA。
- **证据**：`qa/artifacts/probes/cwd-probe-result.json`；`qa/probes/cwd-probe.mjs`；会话期望 cwd 来自 `~/.dsh/storages/session_projcache/sessions/session-fbb8fd5d-….json`（workingDirectory=BIG DATA）。
- **建议 owner**：host-engine（确认 `ctx.get('sessions')` 是否在 registry 初始化时可用；建议 `ctx.inject(['subprocess','workingDirectory','sessions'])` 延迟初始化 + 断言 `sessions.get(id)` 非空）；client-ui（`createSession` 增加 `sessionId` 并在 Panel 传入，再 rebuild）。彼此独立，一处修复即可让 API 侧生效，两处都改才能让 UI 生效。
- **契约依据**：§4.4 `/create` 含 `sessionId`；§5.2 “+ 新建终端（POST /create）”。

### P2-2（已修复并回归）>1MB 请求体返回连接重置而非 413
- 预验收 run1/2/3 记录 FAIL：`POST /input` 2MB body 时客户端 `fetch failed`（连接被重置），拿不到 `{error}` 响应。
- host-engine 修复后正式 run H-16 **PASS：状态 413**，服务未崩溃。
- **证据**：run1 `2026-10-19T10-07-26-684Z` vs 正式 run `2026-10-19T10-15-44-399Z` 的 H-16 detail。

### O-1（环境噪声，P3）DSH 自身偶发 `TypeError: Cannot read properties of undefined (reading 'dimensions')`
- 出现在 4 次全量 run 中的 3 次，均在 E-03/E-04 检查之后；栈帧完全位于 DSH 内部：`get dimensions` ← `ws._sync` ← `mh._runRefreshCallbacks` ← `mh._innerRefresh`（trajectory/layout 刷新），无 `dsh-terminal-panel` 栈帧。
- 控制实验（`qa/probes/acceptance-probes.mjs`）：不打开面板刷新 2 次、打开面板刷新 2 次，均 0 pageerror，说明与“刷新+面板”无稳定关联，无法归因插件。
- **建议**：Lead 决策为按“环境噪声”归档（Lead 在 3101 也会用同一 e2e 观察，若复现则记录）；不作为插件缺陷。证据：`qa/artifacts/probes/reload-noise-probe-result.json`、正式 run 的 `summary.json > pageErrors`。

### O-2（记录，非缺陷）`/resize` 越界值钳制策略
- 非整数 → 400；`cols:0/-1/rows:0` → 200 并钳制为默认值（120x30 等）。契约未要求越界值必须 4xx，记为策略，不改实现。

### O-3（观察，P3）U-13 剪贴板内容与 debug 可见屏首行比对不一致
- 剪贴板 167 字符、内容确为屏幕文本（含 prompt/命令/输出），但首行比较 `matchesVisibleScreen=false`（可能因切换标签后取文本时机/首行空白差异）。不判缺陷，建议 client-ui 自查复制时是否严格取 `controller.getVisibleText()` 同一快照。

---

## 6. 修复回归（历史 FAIL → 正式验收）

| 项 | 历史失败（run1/2/3） | 原因 | 正式验收 |
|---|---|---|---|
| U-11 刷新恢复面板 | run1 FAIL（e2e 选择器点到被遮挡的 tab 标题） | QA e2e 脚本选择器 + 面板恢复已实现 | **PASS**（`restoredInUi=true`） |
| H-07 SSE 帧格式 | run1 FAIL（`retry:` 控制帧被 QA 解析成空 message 帧） | QA 解析器 + host 首帧修复 | **PASS**（首帧 snapshot，data JSON） |
| H-16 >1MB 请求体 | run1/2/3 FAIL（连接重置） | host `readJsonBody` 先回 413 再销毁连接 | **PASS**（413 JSON） |

---

## 7. 证据与可复现命令

### 7.1 正式验收 run 证据（`qa/artifacts/2026-10-19T10-15-44-399Z/`）

- `summary.json`：44 项 PASS/FAIL 明细、HTTP 调用记录（184 次插件调用，0 次 4xx/5xx）、console/pageerror 分类。
- `console.log`：浏览器 console 全量。
- 截图：
  - `01-app-loaded.png`（GUI 加载 / client 插件 marker）
  - `04-right-sidebar-guide.png`（右侧栏 guide「终端面板」）
  - `05-panel-open.png`（面板 body + 工具栏）
  - `06-xterm-created.png`（新建终端 xterm）
  - `07-xterm-output.png`（`Write-Output 'qa-hello-…'` 屏幕输出）
  - `08-xterm-chinese.png`（中文输出）
  - `09-resized.png`（resize 后）
  - `10-after-reload.png`（刷新后面板恢复）
  - `11-multi-session.png`（多会话标签）
  - `12-screenshot-button.png`（复制屏幕按钮）
  - `13-session-closed.png`（关闭会话后）

### 7.2 复现命令

```powershell
# 1) 构建 + 启动 QA dev host（3105）
cd "C:\Users\LANCANG\Desktop\Code\DSH plugin"
node tools/build-client.mjs
& "D:\DSH\resources\runtime\cli\bin\dsh.cmd" --profile dev --no-open --port 3105 *> qa/artifacts/devhost-3105-accept.log
# 从日志取 URL：dsh web: http://127.0.0.1:3105/?token=...

# 2) host 单测
node --test --test-concurrency=1 packages/dsh-terminal-panel/tests/*.test.mjs

# 3) 全量 e2e（含 20s 心跳 + host 日志检查）
node tools/qa-e2e.mjs --slow --host-log=qa/artifacts/devhost-3105-accept.log "<token-url>"

# 4) 专项 probe
node qa/probes/acceptance-probes.mjs "<token-url>"   # 刷新噪声归因 + cwd
node qa/probes/cwd-probe.mjs "<token-url>"           # cwd 解析细节
```

退出码约定：`0` = 无 FAIL；`1` = 有 FAIL；`2` = 环境/参数错误。

---

## 8. 风险与建议

1. **P2-1 cwd 未闭环（已分工）**：host-engine task-4 处理 sessions 注入时序；client-ui task-5 传 `sessionId`。修复后 `node tools/build-client.mjs`、重启 host，重跑 `H-03`/U-06 并观察 `cwd` 字段即可回归。
2. **P1-2 工具可用性（task-4 重做中）**：`live_terminal_run` 改为独立命令会话、render 暴露 `terminalId`、明确 screenshot 默认目标；重做后需在 3101 用真实 agent 复测 E-10/T-04/T-05/T-06，并视改动更新本报告 §4.5 工具静态审查（工具 schema/render 变化）。
3. **工具/拦截类（B）只能用真实 agent 验证**：剩余 T-03/T-05/T-06/T-07/T-08 与 E-11 待 Lead 补测；若发现工具报错，优先查看 agent 是否收到 `output.schema` 校验错误（工具 value 不合法会变成 tool error）。
4. **桌面安装（E-11）**：由 Lead 在确认后执行；安装后需重启 Desktop 才能加载新 host 代码与 client bundle。
5. **O-1 DSH 内部 pageerror**：已按 Lead 决策归档为环境噪声；Lead 在 3101 用同一 e2e 观察，若复现再单独记录。
6. **host 日志**：插件使用 `ctx.logger`，未落到 dev host stdout；若希望 E-01 更强，可让 host 在启动时用 `console.log` 打印一行（与骨架一致），便于验收脚本断言。

---

## 9. 待 Lead 在 3101（真实 agent 会话）补测清单

> 以下为浏览器/HTTP 无法直接触发的项；QA 已给出判定标准，Lead 测完可把结果并入本报告 §3/§4。

| ID | 项 | 判定标准 | 当前状态（2026-10-19） |
|---|---|---|---|
| E-09 / T-02 | 拦截内置 pwsh（B） | agent 用内置 `pwsh` 跑 `Write-Output intercept-ok`：面板出现 `kind=command` 会话（标题=命令首行）并实时输出；工具结果正常、agent 不报错 | **PASS**（Lead 3101：chat 显示“运行命令 · Output intercept-ok”，command 会话实时输出、状态“已退出(0)”，待并入最终记录） |
| T-03 | 拦截回退 | 带 `run_in_background:true` / `sandbox_permissions` 的 pwsh 调用不进入面板，走原实现且无报错 | 待 Lead 最终结果 |
| E-10 / T-04 | `live_terminal_screenshot`（C） | 返回 `text`=当前可见屏（TUI 可读）；value 严格符合 schema；render 首行 `[terminal <title> <cols>x<rows> cursor (x,y) state]`；返回文本而非图片 | **P1 可用性问题，host-engine task-4 重做中**（run 独立命令会话 + render 暴露 terminalId + screenshot 默认目标）；QA 待复测 |
| T-05 | `live_terminal_run` 超时 | `timedOut:true, exitCode:null`，会话终止，后续调用自动重建 | 待 Lead 最终结果（task-4 重做后与新 run 语义一并复测） |
| T-06 | `wait:false` + `live_terminal_read` | 立即返回 `stillRunning:true`；read 可读到递增输出 | 待 Lead 最终结果（task-4 重做后复测） |
| T-07 | `send/open/close/list` | 基本行为正确、list 返回 SessionInfo[] | 待 Lead 最终结果 |
| T-08 | agent 默认终端复用 | 连续两次 `live_terminal_run` 的 `terminalId` 相同 | 待 Lead 最终结果（注意：task-4 将 run 改为独立命令会话，复用语义需按新契约确认） |
| E-12 / T-11 | 自动打开面板（§5.2） | 右侧栏未开时 agent 新命令会话出现 → 自动打开“终端面板”并可看到实时输出；每标签页最多一次；面板已开时不重复开 tab | **PASS**（Lead 3101，与 E-09 同一证据；每标签页一次行为待最终记录补充） |
| E-11 | desktop profile 安装 | 安装后重启 Desktop，重复 U-04/U-05/U-07 通过 | 待 Lead |

---

## 10. 附录

- 测试计划：`qa/test-plan.md`
- e2e 脚本：`tools/qa-e2e.mjs`
- 专项探针：`qa/probes/acceptance-probes.mjs`、`qa/probes/cwd-probe.mjs`、`qa/probes/session-ring-probe.mjs`
- 历史 run：`qa/artifacts/2026-10-19T10-07-26-684Z/`、`...10-10-44-820Z/`、`...10-13-05-088Z/`
- host 日志：`qa/artifacts/devhost-3105.log`（首轮）、`qa/artifacts/devhost-3105-accept.log`（正式验收）
- 契约状态：Lead 已接受 `visibleText` viewport 语义并经确认将更新 architecture.md §4.2 措辞。
