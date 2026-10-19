# 发布与上架指南（dsh-live-terminal）

本仓库已经是可以直接发布的插件包：根 `package.json` 声明了 `dsh.bundle`，浏览器半侧 `lib/client.js` 已预构建并随包发布。要让它「能用 npm 安装」并且「出现在 DSH 插件市场」，有**两条独立轨道**：

| 轨道 | 得到什么 | 是否市场可见必需 |
|---|---|---|
| **npm 发布** | `dsh plugin add dsh-live-terminal` 预构建安装、版本/下载量展示、DSH 0.2.1 内置 Discover 索引 | 否（但强烈推荐） |
| **catalog PR** | dsh-market / 插件市场里的条目（描述、安装命令、截图） | **是** |

> 维护者假设：GitHub 用户名 `Lancang-hzau`、仓库名 `dsh-live-terminal`（见 `package.json` 的 repository）。如实际不同，先把 `package.json`、`README.md`、本文件和 `docs/catalog-entry.yml` 里的链接替换掉。
>
> 详细调研与源码依据见 [`docs/publishing-research.md`](./docs/publishing-research.md)。

---

## 0. 当前状态（2026-10-19 更新）

- ✅ **`dsh-live-terminal@1.0.0` 已正式发布到 npmjs**（latest；`https://www.npmjs.com/package/dsh-live-terminal`）
- ✅ 用全新 DSH profile 从 npmjs 安装 `dsh-live-terminal@1.0.0` 并启动验证通过（host 路由 + client UI）
- ✅ 单测 116/116、独立 e2e 44 PASS、Desktop 实机验证通过
- ✅ `screenshots.json`、`icon.svg`、`README.md`、CI workflow、catalog 条目样例已就绪
- ⚠️ 早期为绕过 npm 审核卡住状态额外 staged 了 `1.0.1`（stage id `42e272a2-4d53-43ac-aded-151ace82a3bd`，状态 `staged`）——**不需要它**，建议在 npm 网页 Staged Packages 里点 **Reject**；仓库版本已回退为 `1.0.0`。
- ⚠️ npm 上保留着 `0.0.0-stage` 占位版本（staged publishing 机制产物），不影响安装；可稍后在网页删除。
- ⬜ **GitHub 仓库尚不存在**（`https://github.com/Lancang-hzau/dsh-live-terminal` 目前 404）
- ⬜ **catalog PR 未提交**（catalog 要求仓库存在且创建满 1 天）

> 注：npm 2026-10 起新包首版走 staged publishing——发布进入队列后需要维护者 2FA 批准。本项目 1.0.0 已通过该流程正式上线；下面的 §2.1 保留给以后新包的 staged 发布参考。

---

## 1. 准备账号与仓库

### npm

默认 registry 是 `https://registry.npmmirror.com`（只读镜像，不能发布），发布必须显式用官方源：

```powershell
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
```

不想交互登录：在 <https://www.npmjs.com/settings/~/tokens> 创建 Automation token，然后

```powershell
npm config set //registry.npmjs.org/:_authToken=<你的token>
```

### GitHub

1. 在 GitHub 创建**公开**空仓库 `dsh-live-terminal`（不要初始化 README）
2. 推送本仓库：

```powershell
cd "C:\Users\LANCANG\Desktop\Code\DSH plugin"
git remote add origin https://github.com/<owner>/dsh-live-terminal.git
git branch -M main
git push -u origin main
```

3. 仓库 **About → Topics** 添加：`dsh-plugin`（catalog 硬性要求）、`deepseek-harness`、`dsh`、`cordis`

> **catalog 硬性门槛：仓库创建满 1 天**（按 `created_at`，每 6 小时重新评估）。所以先建仓库、推代码，再去发布 npm / 准备 PR；不要为了过门槛关闭重开仓库或推空提交。

如果 GitHub 用户名不是 `Lancang-hzau`：

```powershell
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.homepage='https://github.com/<owner>/dsh-live-terminal#readme';p.repository={type:'git',url:'git+https://github.com/<owner>/dsh-live-terminal.git'};p.bugs={url:'https://github.com/<owner>/dsh-live-terminal/issues'};fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
# 同步修改 README.md 里的 raw.githubusercontent 图片链接、docs/catalog-entry.yml 的 owner/repo
```

---

## 2. 发布到 npm

```powershell
cd "C:\Users\LANCANG\Desktop\Code\DSH plugin"

npm install
npm run build        # 构建 client-src -> lib/client.js
npm test             # 116 个 host 单测

npm publish --registry=https://registry.npmjs.org --access public
```

说明：

- `package.json` 的 `publishConfig` 已指向 npmjs 且 `access: public`，但本机 `.npmrc` 是 npmmirror，**显式加 `--registry` 最稳妥**。
- 2FA 账号会提示 OTP，可加 `--otp 123456`。
- `prepack` 钩子会先跑 `node tools/build-client.mjs`，保证 npm tarball 里的 `lib/client.js` 来自最新源码。

### 2.1 首次发布：staged 版本与 2FA 批准（参考流程，1.0.0 已完成）

npm 2026-10 起，**新包首版**必须先进入 staged queue，再由维护者 2FA 批准后才会公开。1.0.0 已经通过该流程正式发布；下面是以后新包/新版本的参考步骤。

**Stage 新版本**（不需要 2FA）：

```powershell
npx --yes npm@11.21.1 stage publish --registry=https://registry.npmjs.org --tag latest
npx --yes npm@11.21.1 stage list dsh-live-terminal --registry=https://registry.npmjs.org
# 等 status 从 validating 变为 staged
```

**方式 A：CLI 批准（需要验证器 App 的 6 位 TOTP）**

```powershell
npx --yes npm@11.21.1 stage approve <stage-id> --registry=https://registry.npmjs.org
# 提示时输入验证器 App 的 6 位验证码
```

**方式 B：网页批准（支持安全密钥/Passkey 2FA，推荐）**

登录 <https://www.npmjs.com/> → 点右上角**头像** → **Staged Packages** → 找到版本 → **Approve** / **Reject**，按提示完成 2FA。

批准成功后验证：

```powershell
npm view dsh-live-terminal version --registry=https://registry.npmjs.org
# 或打开 https://www.npmjs.com/package/dsh-live-terminal
```

> 注意：全局 npm 11.6.2 没有 `stage` 子命令，所以上面用 `npx npm@11.21.1`。已发布的包更新版本也可以直接用 `npm publish --otp=<code>`。
> 如果 `stage approve` 报 404（带 granular token 的已知问题），改用上面的网页批准即可。

### 发布新版

```powershell
npm version patch -m "release %s"   # 或 minor / major
npm publish --registry=https://registry.npmjs.org
git push origin main --follow-tags
```

catalog 不需要为新版本重复提 PR（版本/下载量由 catalog 的 nightly probe 从 registry 自动更新；已安装用户直接走 npm dist-tags）。

### 可选：GitHub Release tarball

```powershell
npm pack --registry=https://registry.npmjs.org   # dsh-live-terminal-1.0.1.tgz
```

在 GitHub Releases 上传即可给不用 npm 的用户；本项目以 npm 为主，catalog 不必配置 `tarball` 字段。

---

## 3. 提交到插件市场（awesome-dsh-plugin）

dsh-market 只有一个数据源：`https://awesome-dsh-plugin.com/plugins.json`（每次请求实时校验；没有 npm 搜索/社区镜像发现）。收录 = 在 [`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提一个只加**一个 YAML 文件**的 PR。

### 3.1 添加条目文件

Fork 仓库后新建 `data/plugins/<owner>__<repo>.yml`（例如 `data/plugins/Lancang-hzau__dsh-live-terminal.yml`）：

```yaml
url: https://github.com/Lancang-hzau/dsh-live-terminal
name: Lancang-hzau/dsh-live-terminal
category: ui
description:
  en: Visible terminal panel that streams the agent's shell commands into an in-app terminal and lets the agent capture the terminal screen as text.
  zh: 可见终端面板：把 agent 的 shell 命令实时显示在应用内终端，并支持 agent 以文本方式截取终端屏幕。
```

> 本仓库已放好可复制的 [`docs/catalog-entry.yml`](./docs/catalog-entry.yml)。

规则与硬门槛：

- 允许的键只有 `url` / `name` / `category` / `description` / `tarball`。**不要写 `npm:`**（会被校验拒绝；npm 映射由 catalog 夜间 probe 自动从「仓库 package.json 的 name + npm 包的 repository 字段」匹配）。
- 仓库 `package.json` 必须声明 `dsh.bundle`（本仓库 ✅；只有 `dsh.client` 会被拒）。
- 仓库需有真实可运行代码、**创建满 1 天**、添加 `dsh-plugin` topic。
- 描述必须与代码一致、只陈述功能；分类选最接近的（本插件选 `ui`；`tools` 也说得通，维护者可能直接调整类目，不会打回）。
- 截图：本仓库根 `screenshots.json` 已声明 4 张 `docs/screenshots/*.png`，市场从你的仓库自动读取，不需要写进 catalog 条目。
- 一个 PR 最多 3 个条目；只改自己的条目，**不要手改生成的 README**。

### 3.2 提交 PR

```powershell
# 在 fork 的 awesome-dsh-plugin 仓库里
git checkout -b add-dsh-live-terminal
# 创建 data/plugins/Lancang-hzau__dsh-live-terminal.yml（内容见上）
git add data/plugins/Lancang-hzau__dsh-live-terminal.yml
git commit -m "Add Lancang-hzau/dsh-live-terminal"
git push origin add-dsh-live-terminal
```

在 GitHub 开 PR。CI 会检查：条目数量、`dsh.bundle`、仓库年龄、awesome-lint/站点构建；维护者再人工核对描述与代码。**被拒/要修改时在同一分支 push 修复即可，不要关掉重开 PR**（年龄门槛会自愈，每 6 小时重新评估）。

### 3.3 上线时间

- **global 区域**：PR 合并后官网自动重新生成，几分钟内可见；
- **China 区域**：dsh-market 读 npm 包 `dsh-plugin-catalog`，该包**每日 02:23 UTC 夜间发布**，所以最多滞后约 24 小时；
- DSH 0.2.1 内置的 **Plugins → Discover** 索引（`index.json`）**只收录有 npm 包/版本/发布时间的条目**——这就是要先发 npm 的另一个原因。

---

## 4. 发布后验证清单

```powershell
npm view dsh-live-terminal version --registry=https://registry.npmjs.org

# 全新环境从 npm 安装并启动（模拟用户）
dsh plugin --profile web add dsh-live-terminal
dsh --profile web --no-open --port 3100
# 右侧栏 -> 开始页 -> 终端面板
```

- 市场：<https://awesome-dsh-plugin.com/> 搜索 `dsh-live-terminal` / Live Terminal；DSH 内打开 dsh-market 搜索同一关键词。
- Desktop 安装后需要完全退出并重新打开 DSH 一次（Desktop Host 不热加载新插件）。

## 5. 常见问题

- **npm publish 报 ENEEDAUTH**：没登录官方源 → `npm login --registry=https://registry.npmjs.org`。
- **npm publish 报 E403 "Two-factor authentication or granular access token with bypass 2fa enabled is required"**：账号强制 2FA。新包首版不要用 `npm publish` 硬闯，走 staged 流程：
  ```powershell
  npx --yes npm@11.21.1 stage publish --registry=https://registry.npmjs.org --tag latest
  npx --yes npm@11.21.1 stage list dsh-live-terminal      # 等待 status 从 validating 变成 staged
  npx --yes npm@11.21.1 stage approve <stage-id>          # 输入 TOTP；或去 npmjs.com Staged Packages 网页批准
  ```
  已有包版本也可以用 `npm publish --otp=<6位验证码>` 直接发。不要用带 Bypass 2FA 的 granular token 直接发布（npm 正在限制）。
- **npm publish 后只看到 `0.0.0-stage` 占位版本**：说明版本进了 staged queue，尚未被维护者 2FA 批准。用 `stage list` 找到条目并 approve；占位版本在正式版发布后可忽略或在网页删除。
- **npm publish 报 402/403（非 2FA）**：包名被占用或权限不足。`dsh-live-terminal` 当前未占用；若之后被占，改用 `@scope/dsh-live-terminal`（需先在 npm 创建 scope/org），并同步改 `package.json.name`、`cordis.patch.yml` 的 row `name`、`tools/build-client.mjs` 的 `PLUGIN_ID`、README 与 catalog 文件名，然后重新构建。
- **market 里搜不到**：没有 catalog PR 就一定搜不到（npm 发布不等于上架）；或 PR 未合并/站点还在构建；China 区域最多滞后 ~24h。
- **市场安装被拒 / 兼容性红标**：catalog 读顶层 `engines.dsh`（本包为 `>=0.2.1-rc.2 <0.3.0-0`，对 0.2.1-rc.2 显示兼容）；市场安装 preflight 遇到不兼容包会直接 400。
- **装完没生效**：Desktop 需要完全退出并重开。
- **描述被要求修改**：catalog 会把描述当事实逐条核对代码；只写功能、不加营销词、不要写不存在的数字/API。
