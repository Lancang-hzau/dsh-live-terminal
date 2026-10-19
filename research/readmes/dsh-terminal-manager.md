# DSH 终端管理插件（dsh-terminal-manager）

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 装的终端管理插件：人与 AI **共用同一批远程终端**（SSH / Telnet），AI 能在对话里直接操作设备终端。

> 本版本基于 **DeepSeek Harness 0.1.2-rc.1** 开发。

**仓库地址**：https://gitcode.com/pengpengR/dsh-terminal-manager
**npm 包**：https://www.npmjs.com/package/dsh-terminal-manager

一行安装（详见下方「安装」）：

```sh
dsh plugin --profile web add dsh-terminal-manager@latest
```

## 能力

### 连接与终端

- **SSH / Telnet** 连接（密码 + 密钥；Telnet 完整协议协商，支持真实网络设备登录）；
- 多会话同屏终端（xterm.js），窗口自然填充，支持 1/2/3 列布局和最大化；
- **AI 工具** `tm_connect` / `tm_list` / `tm_send` / `tm_send_all` / `tm_read` / `tm_disconnect` / `tm_upload` / `tm_download`——AI 在对话里调，自主连设备、发命令、拿回结果、在工作区与 SSH 设备间传文件；
- **命令守卫**：AI 发的危险命令（`rm -rf /` 等）自动拦截；
- 广播：一条命令发多台，逐台独立出结果；
- 连接管理：收藏、最近连接、重连、多窗口布局；

> 📸 *截图位：多会话同屏终端*

### 文件管理

- **本地文件面板**（工作区底部）：浏览、换根目录、双击用内置编辑器打开；
- **远端文件面板**（本地面板上方）：切换在线 SSH 会话浏览设备文件，单文件上传 / 下载（另存为或下载到工作区），同名冲突可选覆盖 / 跳过 / 重命名，传输有行内进度条；本地面板 ↔ 远端面板联动（选中即传），OS 拖拽文件直传，编辑器当前文件一键上传；

> 📸 *截图位：本地 + 远端文件面板联动*

### 编辑器

- **浮动编辑器**（CodeMirror 6）：多标签、语法高亮（sh / py / json / md）、Ctrl+S 保存、可拖可缩可最小化；
- **CSV / TSV 表格渲染**：打开 `.csv` / `.tsv` 文件时自动以表格形式展示（首行作表头、固定不滚动），支持引号包裹字段、引号内换行、BOM 头自动去除；工具栏可一键切换「表格」和「文本」视图；超过 5000 行时只渲染前 5000 行并提示切到文本查看完整内容；

> 📸 *截图位：CSV 表格渲染 + 视图切换*

- **TC 脚本执行**：`.txt` 脚本里 `##>0` / `##>12` 指定目标终端编号（TC0、TC1… = 活跃会话顺序，拖动列表即切换），一键按映射逐条打到对应终端，执行前确认映射，执行后汇总条逐项 ✓/✗；
- **发送选中**：`.md` / `.txt` 里选几行，勾选终端后逐条发送；

> 📸 *截图位：TC 脚本执行 + 汇总条*

### 端口映射

- **TCP / UDP 端口映射**：配置持久化、独立启停、随插件启动、CSV 导入/导出、列表排序和实时流量统计；

> 📸 *截图位：端口映射列表 + 流量统计*

### 会话共享

- **会话共享**：把已打开的 SSH/Telnet 会话通过 TCP 共享给其他客户端，实时收发终端数据；支持设置最大客户端数，超限自动拒绝新连接；

> 📸 *截图位：会话共享*

### 日志

- **运行日志**：插件运行日志按 5 MiB、最多 5 个文件轮转；
- **会话日志**：设备输出日志可按会话启停，按连接名 + 时间戳自动命名；

> 📸 *截图位：会话日志面板*

- 纯本地运行，不依赖 MCP。

## 文件访问范围

本地文件面板与编辑器只能读写**当前根目录及其子目录**：默认根 = 启动 DSH 时的当前目录（可在 `cordis.yml` 里给本插件配 `workspaceRoot`），面板里「换目录」可临时切换（记在浏览器本地）。越界路径（含符号链接指向根外）一律拒绝。切换根目录即视为授权该目录。

**远端文件**（仅 SSH 会话，走 SFTP）：远端无树根概念，面板浏览到的整个设备文件系统与 SSH 终端同等权限；Telnet 会话不支持文件传输（面板会提示）。上传到设备先写远端临时文件（`.tm-partial-*`）成功后改名，下载到工作区同样有半成品保护——中断不留半个文件。

## 前提条件

- **DeepSeek Harness 0.1.2-rc.1**（`dsh web` 能正常跑起来）
- **Node.js** 22+（[下载](https://nodejs.org/)）
- **pnpm** 11+（`npm install -g pnpm`）——DSH 用它装插件

## 支持的 DSH 版本

本插件适配 **DSH 0.1.2-rc.1**：开发、测试、npm 产物都按这条线构建与验证。

> 🧪 **版本线说明**：`package.json` 里的 `@deepseek-ai/*` 依赖钉在 `0.1.2-rc.1`。DSH 换线（例如升到 `0.1.5-*`）之后，插件需要跟着升级依赖并重新验证，否则可能加载失败——上游确实会增删包（`0.1.2-rc.1` 就删掉了 `dsh-host-apiproxy` 与 `dsh-client-runtime`）。升级与验证流程见 [RELEASE.zh.md](RELEASE.zh.md) 的「版本兼容性声明」。

## 安装

### 方式一：命令行安装（推荐）

```sh
dsh plugin --profile web add dsh-terminal-manager@latest   # 首次会因 pnpm 拦截 ssh2 构建脚本而失败（依赖已写入，属正常）
dsh plugin --profile web approve-builds                    # 放行构建脚本（交互勾选 ssh2、cpu-features 并确认）
dsh plugin --profile web add dsh-terminal-manager@latest   # 重跑即成功
```

装完**必须重启 DSH**（Ctrl+C 停掉当前 `dsh web`，再重新 `dsh web`），然后浏览器**硬刷新**（Ctrl/Cmd + Shift + R），侧边栏底部就会出现「🖥️ 终端」按钮。

> **为什么只刷新浏览器不够**：插件分两半。**host 半**由 DSH 进程在**启动时**按 profile 的 `dsh.profile.bundles` 组装；装完插件后，正在运行的进程并不知道多了一个 bundle——它既不会把插件的浏览器半写进首页的 `__DSH_BOOT__`（浏览器连「有这个插件」都不知道，刷新自然没用），也不会注册 `/term-manager`、`/term-io` 路由。所以**安装、更新、卸载之后都要重启 DSH**。
> 唯一可以只硬刷新的情况：host 半没动、只有浏览器半产物变了（源码开发时的快速循环）。

> **首次为什么必然失败**：`ssh2` 带一个可选的原生加速模块，pnpm 默认拦截依赖的构建脚本，报 `ERR_PNPM_IGNORED_BUILDS: cpu-features, ssh2`。这不是装错了，按第 2、3 步继续即可。
> 第 2 步也可在 profile 目录一次放行全部：`cd ~/.dsh/profiles/web && pnpm approve-builds --all`。
> 放行时若看到 `cpu-features: Running install script, failed (skipped as optional)`，同样属正常——它只是可选加速模块，纯 JS 回退完全够用。

### 方式二：让 DSH 自己装

把下面这段提示词粘给任意一个 DSH 会话：

```text
帮我安装 dsh-terminal-manager 插件（DSH 终端管理），步骤：
1. 执行 dsh plugin --profile web add dsh-terminal-manager@latest
   （首次会被 pnpm 拦截 ssh2 构建脚本而失败，属正常现象）
2. 在 ~/.dsh/profiles/web 下执行 pnpm approve-builds --all 放行构建脚本
   （会自动重跑安装；cpu-features 编译失败也无所谓，它只是可选加速模块）
3. 再次执行 dsh plugin --profile web add dsh-terminal-manager@latest
4. 完成后提醒我重启 DSH（Ctrl+C 停掉再重新 dsh web），并硬刷新浏览器（Ctrl/Cmd + Shift + R）
   —— 只刷新浏览器是不够的：插件的 host 半要 DSH 重启才会加载
遇到报错先查 https://gitcode.com/pengpengR/dsh-terminal-manager 的 README「常见问题」表。
```

<details>
<summary><b>装到其他 profile · dsh 命令不可用 · 更新 · 卸载</b></summary>

```sh
# 装到其他 profile（该 profile 需已存在：先 dsh web --profile <名字> 跑一次）
dsh plugin --profile <你的profile> add dsh-terminal-manager@latest

# dsh 不在 PATH 里时用 npx 兜底
npx -y --package @deepseek-ai/dsh dsh plugin --profile web add dsh-terminal-manager@latest

# 更新（也可把 ~/.dsh/profiles/web/package.json 里的版本号改高后 pnpm install）
dsh plugin --profile web add dsh-terminal-manager@latest

# 卸载
dsh plugin --profile web remove dsh-terminal-manager
```

更新完**重启 DSH**（Ctrl+C 再 `dsh web`），然后硬刷新浏览器（Ctrl/Cmd + Shift + R）。

</details>

<details>
<summary><b>常见问题</b></summary>

| 现象 | 原因与解决 |
|---|---|
| 报 `ERR_PNPM_IGNORED_BUILDS` / `Ignored build scripts: cpu-features, ssh2` | pnpm 拦截依赖构建脚本，**首次安装的正常现象**（依赖已写入 profile）。跑 `dsh plugin --profile web approve-builds`（或 `cd ~/.dsh/profiles/web && pnpm approve-builds --all`）放行，然后重跑安装命令 |
| 放行时 `cpu-features` 编译失败 | 正常。它是 ssh2 的**可选**原生加速模块，失败会标成 `skipped as optional`，纯 JS 回退照常工作 |
| 启动报 `plugin tree failed to load`，并显示 `dsh-terminal-manager: pending (waiting for service: webServer)` | 装插件之前没跑过 `dsh web`，新建 profile 的 `dsh.profile.bundles` 里只有 `@deepseek-ai/dsh-base` + 本插件，缺 `@deepseek-ai/dsh-web-app`（`webServer` 由它提供）。解决：在该 profile 的 `package.json` 的 `dsh.profile.bundles` 里补上 `"@deepseek-ai/dsh-web-app"`；或删掉 profile 目录、先跑一次 `dsh web` 再装 |
| 报 `minimum release age` / 版本发布不足 24h | 装的版本发布不到 24 小时。等 24h，或直接重跑一次（pnpm 会自动补 `minimumReleaseAgeExclude`，日志里能看到 `Added 1 entry to minimumReleaseAgeExclude`） |
| 报「找不到 profile 目录」/ `profile "xxx" does not exist` | 先跑一次 `dsh web`（可加 `--profile`）让它初始化 profile |
| 装完看不到「🖥️ 终端」按钮 | **先确认是否重启了 DSH**——安装后只刷新浏览器是不够的（原因见「安装」里的说明）。重启后仍没有就 F12 看控制台报错，并确认 `~/.dsh/profiles/web/node_modules/` 下有 `dsh-terminal-manager` |
| 页面出现两个终端入口 | 同一 profile 装了两份（例如既有 npm 版、又手动挂了 `@link:` 版）：`dsh plugin --profile web remove dsh-terminal-manager` 后只保留一种装法 |
| 提示 `dsh: command not found` | 先安装 DSH；或用上面的 npx 兜底命令 |
| 连接失败提示 `Session not found` | 网络问题：先 `ping <host>`、确认端口开放（`nc -zv <host> <port>`）、再查防火墙 |
| 上传 / 下载失败 | Telnet 会话不支持文件传输（面板会提示）；远端路径要写绝对路径 |

</details>

<details>
<summary><b>从源码安装 / 开发（可选，替代 npm 方式）</b></summary>

调试本地改动、或跟着开发分支走时用。DSH 那侧的依赖（`@deepseek-ai/*`）**照样从 npm 取**，不需要本地准备 DSH 源码树。

```bash
git clone https://gitcode.com/pengpengR/dsh-terminal-manager.git
cd dsh-terminal-manager
pnpm install
pnpm build

# 挂到 DSH profile（link = 指向本地克隆目录，改完 pnpm build 即生效）
dsh plugin --profile web add "dsh-terminal-manager@link:$(pwd)"    # Linux / macOS
dsh plugin --profile web add "dsh-terminal-manager@link:$PWD"      # Windows PowerShell
```

**更新**：

```bash
cd <插件安装目录>
git pull
pnpm install      # 依赖有变动时才需要
pnpm build        # 必须重新构建：profile 用的是 lib/ 里的产物
# 然后重启 DSH（Ctrl+C 再 dsh web）并硬刷新浏览器（只改浏览器半时，硬刷新有时就够）
```

**仓库自带三道验证**（发版前都会跑）：

```bash
pnpm test                      # vitest：54 个文件 / 621 项
node scripts/run-e2e.mjs       # 24 个 E2E 场景（自动拉起 mock 设备 + DSH 服务）
node scripts/mount-check.mjs   # npm 通道真机挂载：隔离 DSH_HOME 装包 + 起真实 dsh web + 断言产物 200

# 想验证「从 npm 装」而不是本地 tarball：
#   MOUNT_FROM_NPM=latest node scripts/mount-check.mjs      # bash
#   $env:MOUNT_FROM_NPM="latest"; node scripts/mount-check.mjs   # Windows PowerShell
```

</details>

## 许可证

[MIT](LICENSE)。

编辑器窗口的拖动 / 缩放、CodeMirror 主题、路径安全校验与目录列表改编自 [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（MIT），对应文件头已注明来源。

