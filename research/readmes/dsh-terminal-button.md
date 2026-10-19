# dsh-terminal-button

DeepSeek Harness 插件：**官方终端（`@deepseek-ai/dsh-client-ui-sidebar-terminal`）的底部面板扩展**。

DSH 0.2.1 起官方已内置右侧栏终端（PTY、传输、会话清单、主题、xterm 全部由官方实现）。从 **0.4.0** 起本插件不再重复实现终端，也不再注册自己的侧栏 Tab，而是把官方终端渲染到会话列底部，并补上官方没提供的桌面入口与命令 shim：

- **底部面板**：在 `conversation.composer.dock` 渲染官方 `TerminalBody`（从官方包的懒加载 chunk `lib/client.terminal.js` 取用），数据来自官方客户端服务 `webTerminals`。没有插件自己的 PTY、WebSocket、xterm 或会话恢复逻辑。面板外层布局与 0.3.x 一致：composer 底部行整行换行、独占一行、与主界面同宽，顶部可拖拽调高度，头部显示会话 cwd，**底部保留状态行**（连接中 / 运行中 / 已退出 / 错误 + 路径 + 「重开终端」）。旧终端被 Host 回收/销毁后（重启、会话卸载、空闲回收），打开面板时会**自动新建**一个终端并在状态行提示，不需要手动点「新建终端」。
- **桌面「打开终端」入口拦截**：托盘 / 设置页 / 标题栏的「打开终端」经 Host 端 patch `desktopRuntime.openTerminal` 重定向到底部面板（SSE `/dsh-terminal/events` 通知前端）；**系统弹窗**模式下放行原生行为，直接弹系统终端窗口。
- **`dsh` 命令 shim**：桌面版没有独立的 `dsh` 可执行文件，官方终端启动子进程时只透传 `DSH_SESSION_ID`。插件 patch `ctx.subprocess.spawnTerminal`，把临时目录里的 `dsh.cmd` / `dsh` 前插到 PATH——**官方右侧栏终端与底部面板都生效**，且不会把任何 `DSH_*` 变量重新注入 shell。
- **位置设置**：插件 → 插件列表 → 本插件详情里的「终端显示位置」，可选 **底部面板**（默认）或 **系统弹窗**；右侧栏终端由官方提供，旧配置里的 `sidebar` 会自动归一为底部面板。
- **官方终端自带能力**：主题跟随、OSC 调色板、光标对比度、复制/选择、字体与字号设置、Shell 选择（官方默认 shell 与 `preferredShell`）、终端数量上限、跨刷新恢复等，全部由官方实现。
- **新会话界面一致性**：进入「新会话」/空白会话界面（hero）时底部面板会收起，且**不会**在发出第一条消息后自己弹回来；只有明确点终端图标才重新挂出（监听会话主体的 `data-content-phase="hero"`）。

## 兼容性

- 需要 **DSH Desktop 0.2.1-rc.2 及以上**，且官方终端插件
  `@deepseek-ai/dsh-client-ui-sidebar-terminal` 在 profile bundle 中启用（`dsh-web-app` 默认无条件注入）。
- 客户端通过官方 client module system 的 `modules.importChunk()` 载入官方渲染组件，通过 `webTerminals` 服务复用官方终端视图。DSH 若改动这两个契约，需要跟随适配。
- Host 端需要 `webServer` 与 `subprocess` 服务；判定 `view()` 等写法随 DSH 官方终端 API 变化时同步更新。

## 安装

```sh
dsh plugin --profile desktop add dsh-terminal-button
```

本地开发版：

```sh
dsh plugin --profile desktop add /绝对路径/dsh-terminal-button
```

> [!IMPORTANT]
> **启动顺序决定是否需要重启。** DSH 的插件 bundle 组合发生在进程**启动时**，安装命令只改磁盘上的 profile 文件：
>
> - **先安装 → 再启动**：直接生效；
> - **先启动 → 再安装**：装完后**必须完全退出并重新启动** DSH Desktop。
>
> 只改 `client.js`（客户端半部）时，DSH 的 client-hmr 会自动热更新，也可以刷新窗口；改了 `index.js`（Host 半部）则必须重启 DSH Desktop。
>
> 安装后可用 `curl http://127.0.0.1:<port>/dsh-terminal/health` 确认 Host 半部已生效。

## 架构

```
dsh-terminal-button/
├── index.js          # Host 半部：desktopRuntime.openTerminal 拦截 + SSE、/dsh-terminal/open-native、
│                     #   /dsh-terminal/health、dsh CLI shim（patch subprocess.spawnTerminal 注入 PATH）
├── client.js         # Client 半部（构建产物，勿手改）
├── src/client.jsx    # Client 源码：底部 dock 注册、位置设置、桌面入口事件、hero 收起策略
├── src/terminal-panel.jsx    # 官方 TerminalBody 的底部面板接线（懒加载、view 生命周期、重启）
├── src/official-terminal.js  # 从官方包 chunk 加载 TerminalBody
├── src/terminal-retention.js # 无侧栏 Tab 的终端窗口 hold 桥接（包装 webTerminals.retainTabs）
├── src/position.js           # 位置取值归一（sidebar → bottom）
├── src/dock-visibility.js    # 新会话（hero）界面收起策略
├── build.mjs         # esbuild 构建：npm run build
├── cordis.patch.yml  # bundle 组合补丁（插入 terminal-plugin 条目）
├── test/host-apply.test.js        # Host 路由、spawn PATH patch、入口拦截单测
├── test/terminal-path.test.js     # PATH 合并且不泄露 DSH_* 单测
├── test/terminal-retention.test.js # 窗口 hold 桥接单测
├── test/position.test.js          # 位置归一单测
├── test/dock-visibility.test.js   # hero 收起策略单测
└── test/config.test.js            # Config.position volatile 声明单测
```

### 底部终端的生命周期

- 每个会话在官方 `webTerminals` 服务里对应一个底部面板视图（`view(sessionId, 'dsh-terminal-bottom', 'dsh-terminal-bottom')`）；服务自带按会话恢复与传输。
- 关闭面板只做 detach：官方视图与 Host 进程保留，Host 按官方「未附着终端」超时（默认 2 小时）自行回收；重新打开会重新 attach 并收到全屏快照。
- 面板存在期间，插件的窗口 hold 桥接会让官方 hold 机制把这些「没有侧栏 Tab 的终端」视为打开状态，避免任何侧栏开关把它们的 hold 释放掉。
- 「重开终端」走官方 `webTerminals.close()` + 新视图创建，和官方侧栏终端行为一致。
- 进入新会话界面时收起面板（见上）；这不会结束 Host 进程。

## 开发

```sh
npm install     # 仅 esbuild 构建依赖
npm run build   # src/client.jsx -> client.js
npm test        # node --test
```

改完 `src/**` 必须重新 `npm run build`；刷新 DSH 窗口即可加载新的 `client.js`。改 `index.js` 需重启 DSH Desktop。

## 调试

- DSH 标题栏扳手图标 → Developer Tools（或 `Ctrl+Shift+I`）。Console 可查：
  - `window.__DSH_TRANSPORT__`（桌面版 Host 基址）；
  - `window.__DSH_BOOT__`（客户端模块清单）；
  - `window.__ModuleLoader__`。
- `curl http://127.0.0.1:<port>/dsh-terminal/health` → `{"ok":true}` 表示 Host 半部已加载。
- 底部面板加载失败时面板内会显示原因（官方 chunk 不可用 / `webTerminals` 服务缺失）。

## 更新说明

版本变更（功能、修复、不兼容调整）见 [CHANGELOG.md](./CHANGELOG.md)。

> 0.4.x 为「官方终端扩展」重构（复用官方 PTY/传输/xterm）；0.3.x 为插件自带终端实现的旧架构。

## License

MIT
