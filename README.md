# dsh-live-terminal

[DeepSeek Harness](https://deepseek.com)（DSH）的**可见终端面板**插件：把 agent 执行的 shell 命令放进应用内终端窗口里实时显示，并允许 agent 对终端屏幕“截图”（文本屏幕快照，适合 vim/htop 等全屏 TUI）。

Visible terminal panel for DeepSeek Harness: stream agent shell commands into an in-app terminal **live**, and let the agent take **text screenshots** of the terminal screen (works for full-screen TUI apps too).

[![npm](https://img.shields.io/npm/v/dsh-live-terminal)](https://www.npmjs.com/package/dsh-live-terminal)
[![license](https://img.shields.io/npm/l/dsh-live-terminal)](./LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.2-blue)](https://github.com/deepseek-ai/deepseek-harness)

![agent command panel](https://raw.githubusercontent.com/Lancang-hzau/dsh-live-terminal/HEAD/docs/screenshots/01-agent-command-panel.png)

![agent screenshot](https://raw.githubusercontent.com/Lancang-hzau/dsh-live-terminal/HEAD/docs/screenshots/02-screenshot.png)

## 功能

- **在 DSH 右侧栏拉起真实终端**（xterm.js + PTY，支持 PowerShell / cmd / bash），可直接键盘输入、多标签、resize、刷新重连。
- **接管默认 shell 命令**：DSH agent 的前台 `pwsh` / `bash` 调用自动在面板里执行，输出实时滚动；agent 开始执行时右侧栏自动弹出（每页面最多一次）。
- **终端截图**：agent 可用 `live_terminal_screenshot` 拿到当前可见屏幕文本 + 光标/尺寸；`live_terminal_run/send/read/list/open/close` 提供长任务、交互输入、会话管理能力。
- **安全回退**：带 `run_in_background` 或 `sandbox_permissions`（升权）的 shell 调用不会被接管，仍走 DSH 原生实现，保持原有审批/沙箱/后台语义。
- 中英文界面，跟随 DSH 主题与终端字体字号设置。

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

## 使用

1. 正常和 DSH 对话，让它执行命令（例如“运行 npm test”）。命令会自动出现在右侧栏的**终端面板**中，实时输出。
2. 自己敲命令：右侧栏 → **终端面板** → **新建终端**。
3. 需要 agent 看当前终端画面：让它调用 `live_terminal_screenshot`（TUI 程序同样有效）。
4. 交互式程序（Python REPL、vim、ssh 等）：agent 用 `live_terminal_open` 建会话，再用 `live_terminal_send` 发送按键/文本。

### agent 工具

| 工具 | 作用 |
|---|---|
| `live_terminal_run` | 在可见终端里跑一条命令（独立可见会话），可选择等待完成或立即返回 |
| `live_terminal_screenshot` | 截取当前/指定终端可见屏幕文本（可含滚动历史） |
| `live_terminal_open` | 新建交互式可见终端 |
| `live_terminal_send` | 向交互终端写入文本/按键（Ctrl-C = `\u0003`） |
| `live_terminal_read` | 读取最近输出 |
| `live_terminal_list` | 列出终端会话 |
| `live_terminal_close` | 关闭终端 |

## 配置

在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 覆盖：

```yaml
- id: dsh-live-terminal
  name: dsh-live-terminal
  config:
    interceptShellTools: true   # 是否接管内置 pwsh/bash 前台命令（默认 true）
    shellPath: null             # 交互 shell 路径；null = 自动探测 pwsh → powershell → cmd
    scrollback: 2000            # 每个终端的回滚行数
    maxOutputBytes: 262144      # 单次工具结果输出上限
    maxSessions: 16             # 同时保留的终端会话上限
    commandTimeoutMs: 180000    # live_terminal_run(wait:true) 的默认等待超时（live_terminal_open 仅做启动等待）；被接管的 pwsh 前台调用固定 120s 上限
    retainExited: 10            # 保留多少个已退出命令会话用于回看
```

把 `interceptShellTools` 设为 `false` 可完全恢复原生 shell 行为，只保留 agent 主动使用的 `live_terminal_*`。

## 兼容性

- DSH **0.2.1-rc.2**（`engines.dsh: >=0.2.1-rc.2 <0.3.0-0`；`dsh.compatibility.dshReleases` 声明 0.2.1-rc.2 兼容）。
- Windows 10/11（PowerShell / cmd / Git Bash）与 POSIX（bash）。
- 运行时依赖：`@xterm/headless`、`@xterm/addon-serialize`（安装时自动安装，纯 JS）。

## 安全说明

- 面板里的命令以**当前系统用户权限**运行，等价于你自己打开的终端，**不套 DSH 的 agent 文件沙箱**；带升权/后台参数的调用不会被接管。
- 插件 HTTP/SSE 接口复用 DSH 浏览器签名 cookie 鉴权（`ctx.connection.admit`），未授权请求返回 401/403。
- 截图只读取终端屏幕缓冲，不上传外部服务。
- DSH 插件以进程内代码运行；只从本仓库/npm 官方源安装可信版本。

## 已知限制

- 终端会话只存在于 Host 进程内，DSH 重启不会恢复。
- 被接管命令的 stdout/stderr 在 PTY 中合并（结果仍符合内置工具 schema）。
- `wait:false` 的后台命令不再被默认超时自动终止，需要用户手动关闭或等其自行结束。
- 截图是文本屏幕快照，不是 PNG 图片。
- DSH 升级到新 minor 版本后可能需要适配插件 API（`tools/execute` 拦截、client 模块基座）。
- 极端情况下（UI 新建终端 → 页面刷新重连 → 关闭），Windows 上可能短暂残留一个 PowerShell/OpenConsole 子进程；重启 DSH 会清理，后续版本跟进。

## v1.1 变更

- **shell 拦截按工具方言选择 shell**：`bash` 方言不再落到 pwsh；方言解析/启动失败时回退 `next()`，保持原生工具行为。
- **输出流失败终止进程树**：PTY 输出流异常时 terminate 整个进程树，避免孤儿进程与悬挂会话。
- **`maxSessions` 并发原子化**：容量占位/回收在并发创建下仍严格不超上限。
- **agent 交互终端容量回收**：超出容量时回收最旧的 agent 交互终端；`startingDefaults` 保护启动中的默认终端不被误回收。
- **`wait:false` 语义**：`live_terminal_run(wait:false)` 的后台命令不再受默认超时自动终止。
- **SSE 背压上限**：每条 SSE 连接缓冲上限 4MiB，超出时断开该慢客户端连接（EventSource 按 `retry: 1000` 重连并重新同步 snapshot），保护 host 内存。
- **插件激活修复**：`apply()` 在 `subprocess`/`workingDirectory` 已就绪（direct 分支）时不再抛出 `TypeError`。
- **客户端增强**：输入串行队列（32KB 分片 + 失败提示）、HTTP 10s 超时、全局 sessions SSE 单例、主题/resize 去抖、tabs/overlay a11y（键盘导航/aria）。
- 版本 **1.1.0**（client 版本号由构建期注入，与 package.json 一致）。

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
lib/                 host 半侧（PTY 会话、SSE、工具、shell 拦截）
client-src/          浏览器半侧源码（xterm 面板，esbuild 打包成 lib/client.js）
tests/               host 纯逻辑单元测试（node:test）
tools/               构建、安装、e2e 脚本
docs/                architecture.md（接口契约）、test-report.md（验收报告）
qa/                  独立 QA 测试计划与脚本
screenshots.json     市场截图清单
```

```powershell
npm install                          # 安装构建/测试依赖
npm run build                        # 构建 client-src → lib/client.js
npm test                             # host 单元测试（166 cases）
npm run typecheck

# 独立 dev host（不影响正在运行的 Desktop DSH）
& "D:\DSH\resources\runtime\cli\bin\dsh.cmd" --profile dev --no-open --port 3101
# 用日志里的带 token URL 打开页面；右侧栏快捷键：Ctrl+Shift+B
```

CI（GitHub Actions）：`windows-latest` 用 Node 22/24 跑全量（`npm ci` → `npm run build` → bundle freshness（`git diff --exit-code -- lib/client.js`，产物未同步即失败）→ `npm test` → `npm run typecheck`）；`ubuntu-latest`（Node 24）跑平台无关测试子集（排除断言 Windows 路径语义的 `tests/registry.test.mjs`）。配置见 `.github/workflows/ci.yml`。

本机验收（2026-10-19）：host 单测 166/166 PASS；独立 e2e（真实 Chrome）44 PASS / 0 FAIL / 1 SKIP（v1.0 验收数字）；真实 agent 手动项（命令拦截可见、自动弹出、`live_terminal_run` + `live_terminal_screenshot`、cwd）全部 PASS；Desktop 实机安装并重启后验证通过。v1.1 复核数字（host 单测 166/166、e2e、浏览器探针）见 [`docs/test-report.md`](./docs/test-report.md) 的「v1.1 验证补充」。

### 发布

发布到 npm 与提交插件市场的完整步骤见 [`PUBLISHING.md`](./PUBLISHING.md)。

## License

MIT
