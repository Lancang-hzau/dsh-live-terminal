# DSH 终端面板插件（dsh-terminal-panel）

给 [DeepSeek Harness](https://deepseek.com)（DSH）Desktop / Web GUI 加一个**可见的终端窗口**：

- 在右侧栏打开真实 PTY 终端，可交互（PowerShell / cmd / bash）。
- **DSH agent 执行的 `pwsh` / `bash` 命令自动跑在这个终端里**，输出实时滚动，可直接看到进度，而不是等工具结果。
- agent 可以用 `live_terminal_screenshot` 工具**截图当前终端屏幕内容（文本）**，适合 vim / htop / 安装器等全屏 TUI 程序。
- 另有一组 `live_terminal_*` 工具用于交互式会话、后台运行、读取输出、关闭终端等。

> 代码位置：`C:\Users\LANCANG\Desktop\Code\DSH plugin`。不改动 DSH 安装目录 `D:\DSH`；插件按 DSH 官方插件机制安装进 `~/.dsh/profiles/desktop`。

---

## 功能

| 能力 | 说明 |
| --- | --- |
| 可见终端窗口 | 右侧栏 → 开始页 → **终端面板**；面板内含多个会话标签，每个都是真实 PTY |
| 命令实时可见 | agent 的前台 `pwsh`/`bash` 调用自动进入面板（标题为命令首行），输出逐字滚动 |
| 自动弹出 | agent 开始跑命令时，右侧栏自动打开终端面板（每个页面标签最多一次，避免打扰） |
| 屏幕截图 | `live_terminal_screenshot` 返回当前可见屏幕文本 + 光标位置 + 尺寸；TUI 程序同样有效 |
| 交互 | 面板里可直接键盘输入；“新建终端”开一个自己的 shell；支持窗口大小自适应（resize） |
| 会话工具 | `live_terminal_open/run/send/read/list/close`，支持长任务 `wait:false` 后台继续 + 随时截图/读取 |
| 降级安全 | 带 `run_in_background` 或 `sandbox_permissions` 的 shell 调用仍走 DSH 原生实现，不改变原有审批/沙箱/后台语义 |

## 安装（Desktop）

本机已由开发流程安装到 `~/.dsh/profiles/desktop`。若需在新机器安装：

```powershell
# 1) 把插件包链接进 desktop profile
& "D:\DSH\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "<本仓库>\packages\dsh-terminal-panel"

# 2) 在 ~/.dsh/profiles/desktop/package.json 的 dsh.profile.bundles 数组末尾加入：
#    "dsh-terminal-panel"
# 3) 刷新 DSH 页面（或重启 DSH 应用）即可在右侧栏看到“终端面板”
```

卸载：从 `dsh.profile.bundles` 中移除 `dsh-terminal-panel`，并执行
`dsh plugin --profile desktop remove dsh-terminal-panel`，然后重启 DSH。

## 使用

1. 在对话里让 DSH 执行命令（例如“运行 npm test”）。命令会自动出现在右侧栏的**终端面板**中，实时输出。
2. 想自己敲命令：右侧栏 → **终端面板** → **新建终端**，或直接点 guide 入口。
3. 想看 agent 当前终端屏幕：让 agent 调用 `live_terminal_screenshot`（或你在面板里点“截图”复制屏幕文本）。
4. 需要交互式程序（Python REPL、vim、ssh 等）：agent 用 `live_terminal_open` 建会话，再用 `live_terminal_send` 发送按键/文本。

## 配置（可选）

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里可以覆盖插件配置：

```yaml
- id: dsh-terminal-panel
  name: dsh-terminal-panel
  config:
    interceptShellTools: true   # 是否接管内置 pwsh/bash 前台命令（默认 true）
    shellPath: null             # 指定交互 shell；null = 自动探测 pwsh → powershell → cmd
    scrollback: 2000            # 每个终端的回滚行数
    maxOutputBytes: 262144      # 单次工具结果输出上限
    maxSessions: 16             # 同时保留的终端会话上限
    commandTimeoutMs: 180000    # 被接管命令的默认超时
    retainExited: 10            # 保留多少个已退出命令会话用于回看
```

> `interceptShellTools` 关闭后，内置 `pwsh` 行为完全恢复原生（沙箱/审批不变），只有 agent 主动使用 `live_terminal_*` 工具时才有可见终端。

## 安全说明（重要）

- 可见终端里的命令以**当前 Windows 用户权限**运行，等价于你自己打开的 PowerShell；**不套 DSH 的 agent 文件沙箱**。
- 带 `sandbox_permissions`（升权）或 `run_in_background` 的 shell 调用不会被接管，仍由 DSH 原生工具执行。
- 插件 HTTP/SSE 接口复用 DSH 的浏览器签名 cookie 鉴权（`ctx.connection.admit`），非授权请求返回 401/403。
- 插件是进程内代码（DSH 插件机制如此），只从本仓库安装可信版本；不要安装来源不明的插件。

## 研究结论：现成插件对比

调研了 DSH 插件市场（2975 个条目）中的终端/截图类插件，结论摘要：

- **DSH 自带右侧栏终端**（官方 `ui-sidebar-terminal`）已有“终端窗口”，但官方明确**不把终端输出交给 agent**，也不支持 agent 截图。
- **官方实验性“持久终端”bundle** 给 agent 6 个 `terminal_*` 工具，但没有可见窗口。
- **`@hyzyn/dsh-tty`** 是最接近的现成插件：`tty_*` 工具 + 可见面板 + 文本屏幕读取；但它不接管默认 `pwsh` 工具，且通过 DOM 注入/内部 node-pty 句柄实现，跟随版本的风险较高。
- 其余插件多为“只能开终端/不能给 agent 用/不支持 0.2.1-rc.2/无截图”。

因此本项目自研：官方插件机制 + 官方 `ctx.subprocess.spawnTerminal` PTY 原语 + headless xterm 屏幕镜像，实现“默认命令可见 + agent 截图”，并保留原生工具的回退路径。详细调研见 `research/existing-plugins.md`。

## 目录结构

```
packages/dsh-terminal-panel/   插件包（host 半侧 lib/，浏览器半侧 client-src/ → lib/client.js）
tools/                         构建与 e2e 脚本
docs/architecture.md           接口契约与设计
docs/plugin-dev-notes.md       DSH 插件 SDK 调研笔记
research/                      现成插件调研与对比
qa/                            独立验收测试计划/脚本
```

## 开发

```powershell
# 构建浏览器半侧（生成 packages/dsh-terminal-panel/lib/client.js）
node tools/build-client.mjs

# 单元测试（host 纯逻辑）
node --test packages/dsh-terminal-panel/tests/

# 独立 dev host（不影响正在运行的 Desktop DSH）
& "D:\DSH\resources\runtime\cli\bin\dsh.cmd" --profile dev --no-open --port 3101
# 用日志里的带 token URL 打开页面；右侧栏快捷键：Ctrl+Shift+B
```

## 已知限制

- 终端会话只存在于 Host 进程内，DSH 重启后不恢复；重启会清空面板会话。
- 被接管命令的 stdout/stderr 在 PTY 中合并，与内置工具的分流输出形状不同（结果仍符合内置工具 schema）。
- 当前截图是文本屏幕快照，不是 PNG 图片；模型不需要看图即可理解终端界面。
- 依赖 DSH 0.2.1-rc.2 的插件 API；DSH 升级后可能需要适配（尤其是 `tools/execute` 拦截与 client 模块基座）。
