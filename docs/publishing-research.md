# Publishing a DSH plugin to npm and getting it into the DSH plugin market

Research date: **2026-10-19** (Asia/Shanghai). Target host: **DSH Desktop 0.2.1-rc.2**.
Market plugin inspected: **dshmarket 1.66.42** at
`C:\Users\LANCANG\.dsh\profiles\desktop\node_modules\dshmarket\` (full TypeScript source).
Catalog inspected: `https://awesome-dsh-plugin.com/plugins.json` (5,945 entries, updated 2026-10-18,
7.4 MB) and the catalog repo `awesome-dsh-plugin/awesome-dsh-plugin`.

> Workspace note: while this research ran, the plugin was restructured from
> `packages/dsh-terminal-panel` (or `packages/dsh-live-terminal`) to the **repository root**. Current root is
> `C:\Users\LANCANG\Desktop\Code\DSH plugin` with `package.json` name **`dsh-live-terminal`** version
> **1.0.0**, `cordis.patch.yml`, `README.md`, `screenshots.json`, `icon.svg`, `lib/index.js`,
> `lib/client.js`. The old `packages/...` paths are staged git renames. All commands below use the root.

---

## TL;DR checklist

1. **Pick the npm name.** `dsh-terminal-panel` is taken (`dsh-terminal-panel@1.3.0`, repo
   `BaiZhi967/dsh-plugin-terminal-panel`). `dsh-live-terminal` was **unclaimed** on npmjs on 2026-10-19
   (HTTP 404), and the current `package.json` already uses it. Publish soon — names are first-come.
2. **Create and push the public GitHub repo** `https://github.com/Lancang-hzau/dsh-live-terminal`.
   It **does not exist yet** (`git ls-remote` → “Repository not found”, 2026-10-19 19:27).
   The catalog gate requires the repo to exist, be public, and be **at least 1 day old** (`created_at`).
3. **Keep `dsh.bundle` at the repo root** and `cordis.patch.yml` with
   `name` exactly equal to `package.json.name`. (Already true: `dsh-live-terminal`.)
4. **Add the `dsh-plugin` GitHub topic** (plus `dsh`, `deepseek-harness`, `cordis`). This is checked by
   human review, not CI.
5. **Publish to npmjs** (not npmmirror — that mirror is read-only for publishing):
   `npm login --registry=https://registry.npmjs.org` then
   `npm publish --registry=https://registry.npmjs.org --access public` from the repo root.
   `publishConfig.registry` in `package.json` also points at npmjs and is respected by npm.
6. **Declare DSH compatibility correctly.** Use top-level `"engines": { "dsh": ">=0.2.1-rc.2 <0.3.0-0" }`.
   This is what the market reads for the compatibility badge and the install preflight. `dsh.engines.dsh`
   is only a discovery fallback; `dsh.compatibility.dshReleases` is **not read by dshmarket at all**.
7. **Submit one YAML file via PR** to `awesome-dsh-plugin/awesome-dsh-plugin`:
   `data/plugins/Lancang-hzau__dsh-live-terminal.yml`. That single file is the whole submission.
   **Do not put `npm:` in it — that key is rejected.** npm mapping is automatic.
8. **Do not edit the generated READMEs.** One PR may add **at most 3 entries**; ours is 1.
9. **Wait for the catalog PR to merge**, then the site rebuilds automatically. Global-region dshmarket
   users see the entry after the Pages deploy (minutes); China-region users may wait until the next
   nightly npm catalog publish (~02:23 UTC).
10. **npm is optional for listing but recommended** for prebuilt installs, download counts, and DSH 0.2.1's
    built-in **Plugins → Discover** index (which only lists npm-published entries).

Two independent tracks, both useful:

| Track | What it gets you | Required for market listing? |
|---|---|---|
| npm publish | `dsh plugin add dsh-live-terminal`, no `allowBuilds` approval, version/download metadata, Discover index | **No** |
| Catalog PR | A row in dshmarket's catalog (`plugins.json`) with install command and description | **Yes** |

---

## 1. How dshmarket discovers and lists plugins

### 1.1 One curated catalog, fetched fresh on every request

`src/registry.ts` (`loadRegistry`, line 230) fetches a catalog from the region routing table in
`src/regions.ts`. There is **no npm search, no npm registry crawl, no community-mirror aggregation** in
the market. The only catalog address is:

- `https://awesome-dsh-plugin.com/plugins.json` (`regions.ts` line 80, `CATALOG_OFFICIAL`).

The market **revalidates on every request** (ETag / Last-Modified; no one-hour cache, no bundled snapshot).
A network failure is surfaced as an error, never silently answered from a stale file (`registry.ts`
lines 210–229, 314–328). So “when does my plugin appear?” is “when the published `plugins.json`
contains it”.

Region behavior (`regions.ts` lines 130–158 and `catalogSourcesFor`, lines 179–186):

| Region | Catalog source order | Effect for a new entry |
|---|---|---|
| `global` (default) | official `awesome-dsh-plugin.com/plugins.json`, then the npm fallback package `dsh-plugin-catalog` on `registry.npmjs.org` | Visible immediately after the Pages deploy |
| `china` | **npm package `dsh-plugin-catalog` on `mirrors.cloud.tencent.com/npm`**, then the official URL | The npm copy is published **nightly only** (`build-site.yml`: schedule `23 2 * * *`), so China-region users can lag up to ~24 h |

The npm catalog package is `dsh-plugin-catalog` (`regions.ts` line 128; `src/catalog-npm.ts`
`catalogFromPackage`, line 91). It is a **transport** for the same `plugins.json`, not a second index.
The script `scripts/publish-catalog.mjs` in the catalog repo publishes it nightly/manually, with
date-based versions (`YYYY.MDD.RUN`) and only when the content hash changed.

**Environment overrides** (process env only, not UI): `DSHM_REGISTRY_URL` replaces the catalog URL,
`DSHM_NPM_MIRROR` moves the registry, `DSHM_GITHUB_PROXY` heads the GitHub proxy list
(`regions.ts` lines 276–307). These are for operators, not for submitting a plugin.

### 1.2 What makes a package appear in search/browse

`plugins.json` contains an array of entries. dshmarket renders that array and filters/searches it
locally (client-side `visiblePlugins` in `src/client/MarketSection.tsx`). An entry appears if and only if
it is in the catalog JSON. Its install target is computed by `src/sources.ts` `installTargetFor`
(lines 497–504):

1. `npm` field, if present and a valid npm name → install that npm package;
2. else `tarball`, if it is a GitHub Release `.tgz` belonging to the entry's own repo;
3. else `github:owner/repo` (with `#path:/sub` for monorepo subpackages).

The `install` string in the JSON (`"dsh plugin --profile web add ..."`) is generated from that choice.
The npm field is **not authored in YAML**; it is resolved by the catalog's nightly `probe-npm.mjs`:

- read the repo's `package.json` name from `raw.githubusercontent.com`;
- query `registry.npmjs.org` for that name;
- accept only if the registry package's `repository` URL includes the same GitHub repo
  (case-insensitive substring; protects against name squatting);
- record `{ npm, version: dist-tags.latest, publishedAt, enginesDsh }` in `data/npm-map.json`.

This means **the npm package name must equal the repo's `package.json` name**, and the npm
`repository` field must point back at the repo. If you publish under a different name than the repo
manifest declares, the catalog will not link it.

### 1.3 DSH 0.2.1's built-in Discover index (separate from dshmarket)

DSH 0.2.1 added **plugin market indexes** (“Plugins → Discover”, and the `plugin_market` agent tool).
The catalog repo publishes one at:

- `https://awesome-dsh-plugin.com/index.json` (format 1, currently ~2.39 MB, HTTP 200 verified)
- `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`

Format 1 is defined/validated by `@deepseek-ai/dsh-plugin-market-index`. The catalog's
`scripts/build-index.mjs` and `scripts/lib/market-index.mjs` build it, and **only entries with an
npm package, an exact version, and a publish timestamp are included** (`skipped.noNpm`,
`noVersion`, `noPublishTime`). GitHub-only entries are omitted. This index is rebuilt on every site
build (so a newly merged npm-backed entry can appear quickly at the official URL), while the npm package
copy refreshes nightly.

Shape (abridged):

```json
{
  "format": 1,
  "title": { "en": "Awesome DSH Plugin", "zh": "..." },
  "metadata": { "categories": { "ui": { "title": { "en": "UI Enhancements", "zh": "..." } } } },
  "plugins": [
    {
      "name": "@scope/pkg",
      "title": "owner/repo",
      "description": { "en": "... (truncated to 160 chars)", "zh": "..." },
      "homepage": "https://awesome-dsh-plugin.com/p/owner/repo/",
      "repository": { "url": "https://github.com/owner/repo" },
      "metadata": { "category": "ui" },
      "versions": [
        { "version": "1.0.0", "publishTimestamp": 1790000000,
          "source": { "type": "npm" }, "engines": { "dsh": ">=0.2.1-rc.2 <0.3.0-0" } }
      ]
    }
  ]
}
```

`probe-npm.mjs` writes `enginesDsh` from the **top-level `engines.dsh` only** (not `dsh.engines.dsh`),
which is another reason to keep the compatibility declaration top-level.

### 1.4 Community mirrors / awesome lists

There is no community-source aggregation inside dshmarket. `plugins.json` is the community-curated
catalog, and the catalog repo is the only editorial pipeline. A custom catalog can only be injected with
`DSHM_REGISTRY_URL`. I found no reference to `dshplugin.store` or any second marketplace in the
dshmarket source. If such sites exist, they are separate projects with their own submission rules; the
official flow is still the catalog PR + npm.

---

## 2. Catalog entry format (`plugins.json`)

### 2.1 Top level

```json
{
  "name": "awesome-dsh-plugin",
  "url": "https://awesome-dsh-plugin.com",
  "source": "https://github.com/awesome-dsh-plugin/awesome-dsh-plugin",
  "updated": "2026-10-18",
  "count": 5945,
  "categories": {
    "agi": { "en": "AGI Architecture Exploration", "zh": "AGI 架构探索" },
    "...": { "en": "...", "zh": "..." }
  },
  "plugins": [ ... ]
}
```

There are 23 category ids: `agi ui usage theme model identity session memory tools wsl browser vision
voice docs skill workflow git notify dev security remote market fun`.

### 2.2 Per-entry schema (observed across all 5,945 entries)

Every generated JSON entry has every key; absent data is `null` (not omitted).

| Field | Type | Source | Notes |
|---|---|---|---|
| `name` | string | YAML `name` | Display/link text; usually `owner/repo`, may be `owner/repo#sub` |
| `owner` | string | derived from `url` | GitHub owner |
| `url` | string | YAML `url` | Must be `https://github.com/owner/repo` (or `/tree/<branch>/<sub>`) |
| `page` | string | derived | `https://awesome-dsh-plugin.com/p/<slug>/` |
| `category` | string (type allows array) | YAML `category` | One of 23 ids |
| `description` | `{en, zh?}` | YAML `description` | `en` required, single line |
| `npm` | string \| null | **auto** from npm probe | Manual `npm:` in YAML is rejected |
| `tarball` | string \| null | YAML `tarball` (optional) | GitHub Release `.tgz` only |
| `version` | string \| null | `dist-tags.latest` at probe time | Not authored |
| `stars` | int \| null | GitHub probe | — |
| `downloads` | int \| null | npm last-30-days probe | `null` for non-npm |
| `downloadsStart`, `downloadsEnd` | date \| null | probe window | e.g. `2026-09-19` … `2026-10-18` |
| `downloadsCheckedAt` | date \| null | probe time | — |
| `capabilities` | string[] (absent if never scanned) | static artifact scan | `shell`, `network`, `fs-read`, `fs-write`, `env`, `llm`, `dynamic-code`, ... |
| `capabilityRedLines` | string[] | scan notes | e.g. plaintext HTTP usage |
| `capabilityCheckedAt` | ISO date \| null | scan time | — |
| `install` | string | derived | `dsh plugin --profile web add <target>` |
| `added` | date | derived from git history | Not authored |
| `screenshots` | string[] (optional) | repo `screenshots.json` or legacy `data/screenshots.json` | 1–8, GitHub-hosted |
| `deprecated` | boolean (optional) | catalog-side | Supported by dshmarket; **0 current entries** |
| `replacement` | string (optional) | catalog-side | Catalog name of replacement when deprecated |

Current coverage: 3,056/5,945 entries have `npm`; 614 have `tarball`; 1,296 have `screenshots`;
5,423 have capability data; 0 are deprecated.

### 2.3 Verbatim-ish examples (descriptions trimmed)

**npm-backed entry** — `dsh-meme` (actual catalog record):

```json
{
  "name": "dsh-meme",
  "owner": "yyh-001",
  "url": "https://github.com/yyh-001/dsh-meme",
  "page": "https://awesome-dsh-plugin.com/p/yyh-001/dsh-meme/",
  "category": "fun",
  "description": {
    "en": "Chat meme stickers: text-only send, mood auto-send, QQ/WeChat-style picker, auto-learn, custom packs.",
    "zh": "聊天表情包：纯文本斗图、情绪主动发图、像 QQ/微信 一样发图、AI 自动学图、自定义表情包。"
  },
  "npm": "dsh-meme",
  "version": "0.1.52",
  "stars": 201,
  "downloads": 11453,
  "downloadsStart": "2026-09-19",
  "downloadsEnd": "2026-10-18",
  "downloadsCheckedAt": "2026-10-19",
  "capabilities": ["fs-write", "fs-read", "network", "env"],
  "capabilityRedLines": [],
  "capabilityCheckedAt": "2026-10-19T03:48:14.097Z",
  "install": "dsh plugin --profile web add dsh-meme",
  "added": "2026-08-14",
  "screenshots": ["https://raw.githubusercontent.com/yyh-001/dsh-meme/HEAD/docs/hero-banner-v4.jpg", "..."]
}
```

**npm + tarball entry** — `dsh-prompt-polish`:

```json
{
  "name": "dsh-prompt-polish",
  "owner": "benrong2048-boop",
  "url": "https://github.com/benrong2048-boop/dsh-prompt-polish",
  "page": "https://awesome-dsh-plugin.com/p/benrong2048-boop/dsh-prompt-polish/",
  "category": "agi",
  "description": {
    "en": "Turns a one-line DSH draft into a complete task brief (role / goal / constraints / output format). ...",
    "zh": "把 DSH 输入框里的一句话补成完整任务书（角色/目标/约束/输出格式）。..."
  },
  "npm": "@benrong/dsh-prompt-polish",
  "tarball": "https://github.com/benrong2048-boop/dsh-prompt-polish/releases/download/v0.2.4/benrong-dsh-prompt-polish-0.2.4.tgz",
  "version": "0.2.4",
  "stars": 5,
  "downloads": 685,
  "downloadsStart": "2026-09-19",
  "downloadsEnd": "2026-10-18",
  "downloadsCheckedAt": "2026-10-19",
  "capabilities": ["network", "llm"],
  "capabilityRedLines": [],
  "capabilityCheckedAt": "2026-10-19T03:48:14.097Z",
  "install": "dsh plugin --profile web add @benrong/dsh-prompt-polish",
  "added": "2026-10-13"
}
```

**GitHub-only monorepo entry** — `whalepal` → `packages/dsh-bridge`:

```json
{
  "name": "whalepal#dsh-bridge",
  "owner": "Jessie-1939",
  "url": "https://github.com/Jessie-1939/whalepal/tree/main/packages/dsh-bridge",
  "page": "https://awesome-dsh-plugin.com/p/Jessie-1939/whalepal--packages-dsh-bridge/",
  "category": "fun",
  "description": { "en": "Bridges DeepSeek Harness agent state ... over loopback ...", "zh": "把 DSH 的 agent 状态 ... 推给桌面宠物应用。" },
  "npm": null,
  "version": null,
  "stars": 0,
  "downloads": null,
  "downloadsStart": null,
  "downloadsEnd": null,
  "downloadsCheckedAt": null,
  "capabilities": ["network"],
  "capabilityRedLines": [],
  "capabilityCheckedAt": "2026-10-19T03:48:14.097Z",
  "install": "dsh plugin --profile web add github:Jessie-1939/whalepal#path:/packages/dsh-bridge",
  "added": "2026-10-10",
  "screenshots": ["https://raw.githubusercontent.com/Jessie-1939/whalepal/main/docs/images/demo.gif", "..."]
}
```

---

## 3. Submission process (official)

### 3.1 Where

- Catalog repo: **https://github.com/awesome-dsh-plugin/awesome-dsh-plugin**
  (CC0-1.0; 19,464 stars; 5,945 entries as of 2026-10-18).
- Authoritative instructions: **https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md**
  (raw: `https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/contributing.md`).
- One file per plugin: **`data/plugins/<owner>__<repo>.yml`**. For us:
  **`data/plugins/Lancang-hzau__dsh-live-terminal.yml`**.
  Monorepo subpackage: `owner__repo--packages-my-plugin.yml` with a `/tree/<branch>/<sub>` URL.
- Preview: `npm ci && node scripts/generate-readme.mjs`, then
  `SKIP_PUBLISH_CHECKS=1 node scripts/build-site.mjs`.
- Do **not** edit `README.md` / `README.zh.md`; they are generated after merge.

### 3.2 Entry YAML — complete allowed schema

Only these keys are accepted (`scripts/lib/entries.mjs`, `ENTRY_KEYS`):
`url`, `name`, `category`, `description`, `tarball` (plus internal `file`). Anything else —
notably `npm:` — is rejected with “an entry may only declare url, name, category, description, tarball”.

```yaml
url: https://github.com/Lancang-hzau/dsh-live-terminal
name: Lancang-hzau/dsh-live-terminal
category: ui
description:
  en: Visible terminal panel for DeepSeek Harness that mirrors agent shell commands and output live in a sidebar PTY terminal and lets the agent capture the terminal screen as text, including full-screen TUI apps.
  zh: DSH 可见终端面板：在右侧栏真实 PTY 中实时镜像 agent 的 shell 命令与输出，并允许 agent 以文本截取终端屏幕（支持 vim/htop 等全屏 TUI）。
```

Field rules (enforced by `validateEntries`):

- `url`: `https://github.com/owner/repo` (optionally `/tree/<branch>/<sub>`); must exactly match the repo.
- `name`: required. If it contains `/`, the part before `#` must equal the URL's `owner/repo`
  (it is link text). A bare display name may be used instead.
- `category`: must be one of the 23 ids. A near miss is not a rejection; maintainers may change it.
  Themes/skins **must** use `theme` (that feeds dshmarket's Themes tab).
- `description.en`: required, single line. `zh` optional; maintainers will add it. Extra locales are rejected.
- **Quote the description if it contains `: ` (colon + space)**; otherwise YAML parses it as a nested key.
  Full-width Chinese colon `：` is fine.
- `tarball` (optional): `https` `.tgz`/`.tar.gz` on GitHub release hosting
  (`github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`).
  `releases/latest/download/name.tgz` takes the filename literally, so keep the asset name
  version-free, or pin the release tag.
- Filename must equal `slugFor(url)` (owner/repo with `__`, subpath with `--` and `-`).

### 3.3 Hard requirements / review criteria

From `contributing.md` and `scripts/check-submission.mjs`:

- **`dsh.bundle` in `package.json`** (root, or a `packages/`/`plugins/`/`apps/` subpackage). Declaring only
  `dsh.client` is the most common rejection; it is not installable.
- A `cordis.patch.yml` next to the manifest:
  ```yaml
  - insert:
      - id: your-plugin-id
        name: your-package-name   # must equal package.json name
  ```
- Real, working code — no placeholder, name-squat, or README-only repositories.
- Repository at least **1 day old** (`created_at`). No commit-count floor since 2026-09-03.
- Active maintenance; periodic decay scans remove gone/archived/dormant entries.
- **`dsh-plugin` GitHub topic** (human-reviewed).
- Description states what it does, no superlatives/marketing; **claims are checked against the code**.
- Category should match what it does.
- One PR may add **at most 3 entries**.
- Review also checks duplication, obfuscated/suspicious code, unrelated entry edits, pure meta-packages
  (a bundle that only depends on others is not listed), and dependencies pointing at the original author.
- **npm is not required for listing** (“listing is unaffected either way”). It is recommended.
- No README/license/version/keyword/icon check in CI. They are still expected by reviewers and are
  needed for a good npm/detail page.

Age-gate behavior (important): a new repo triggers `Submission gate: failure` with
“repository is X days old (needs 1) — nothing to do: this check re-runs by itself ... No need to resubmit,
push, or close and reopen.” `regate.yml` runs every 6 hours and re-runs age-failed gates after a 24-hour
cooldown. Do not close/reopen, push empty commits, or resubmit.

### 3.4 PR flow (PowerShell)

```powershell
# 0) Local repo: commit the current restructure and push (after creating the GitHub repo)
cd "C:\Users\LANCANG\Desktop\Code\DSH plugin"
git add -A
git commit -m "chore: restructure plugin to repository root for npm/catalog release"
git remote add origin https://github.com/Lancang-hzau/dsh-live-terminal.git
git push -u origin main

# 1) Fork awesome-dsh-plugin/awesome-dsh-plugin on GitHub, then:
git clone https://github.com/<your-gh-user>/awesome-dsh-plugin.git
cd awesome-dsh-plugin
git checkout -b add-dsh-live-terminal

# 2) Create data/plugins/Lancang-hzau__dsh-live-terminal.yml with the YAML above
# 3) Commit only that file
git add data/plugins/Lancang-hzau__dsh-live-terminal.yml
git commit -m "Add dsh-live-terminal"
git push -u origin add-dsh-live-terminal

# 4) Open a PR against main using .github/pull_request_template.md
```

Local validation with the upstream code (optional but recommended):

```powershell
npm ci
node scripts/generate-readme.mjs
$env:SKIP_PUBLISH_CHECKS = "1"
node scripts/build-site.mjs
```

Or validate just the entry with the schema source:

```js
import { readEntries, validateEntries } from './scripts/lib/entries.mjs'
const all = readEntries('data/plugins')
console.log(validateEntries(all.filter(e => e.url.includes('dsh-live-terminal')))) // [] = clean
```

---

## 4. DSH-side conventions for a publishable plugin

### 4.1 Official contract

The official DSH plugin-authoring skill ships inside the app (asar):
`dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/`.
Its `SKILL.md` says the asar is readable only by the Host's own file reads, not shell/ripgrep. The same
skill is published on npm as **`@deepseek-ai/dsh-agent-preset`**; I extracted and read
`SKILL.md`, `references/host-plugin.md`, and `references/ui-plugin.md` from its tarball
(`.../skills/cordis-plugin-development/`). Key points:

- A **bundle** is a package whose `package.json` declares `dsh.bundle.patch`; the YAML patch inserts rows.
- Give the package and rows unique names; the row `name` must equal the real package name.
- Host-only bundles need **no dependencies, install scripts, or build tool**.
- Display metadata/icon: put title/description in `locale/en.json` (and `locale/zh.json`), and a top-level
  `icon` path. `icon` is relative, SVG/PNG/JPEG/WebP, ≤256 KiB; absolute paths/URLs/outside paths/symlinks
  are rejected. Missing metadata falls back to `name`/`description`.
- Host plugin export: `export function apply(ctx, config) {}` with optional `export const inject`/`Config`,
  or a service class as default export. Do not mix forms.
- UI plugin: `dsh.client` (`platform: "web"`, optional `immediately`, `inject`, `external`), plus a
  `./client` export. The browser artifact registers a lazy factory whose id equals the package name;
  React comes from the host's module table. Register resources with `ctx.effect`/`ctx.on` and clean up.
- The official catalog's contributing guide adds the installability requirement
  (`dsh.bundle`) and the ecosystem conventions below.

Also useful: `NanmiCoder/dsh-agent-teams` → `skills/plugin-release/SKILL.md`
(https://github.com/NanmiCoder/dsh-agent-teams/blob/main/skills/plugin-release/SKILL.md) for pack
validation and the dual GitHub/npm release tracks, and `lishuo4096/dsh-plugin-authoring` →
`skills/dsh-plugin-publish/SKILL.md` + `references/market-listing.md` / `market-ci.md` / `entry-template.yml`
(https://github.com/lishuo4096/dsh-plugin-authoring) — the latter is a distilled, current guide to this
exact catalog process.

### 4.2 Checklist for `dsh-live-terminal`

| Item | Current state | Action |
|---|---|---|
| npm name | `dsh-live-terminal` (available) | Publish before someone claims it |
| `version` | `1.0.0` | Bump for each npm publish; npm forbids reusing a version |
| `dsh.bundle.patch` | `./cordis.patch.yml` | ✔ |
| Patch row `name` | `dsh-live-terminal` = package name | ✔ |
| `dsh.client` | `platform: "web"`, inject `@deepseek-ai/dsh-client-ui-sidebar-right` | ✔ |
| `engines.dsh` | `>=0.2.0-rc.2` | **Tighten** to `>=0.2.1-rc.2 <0.3.0-0` |
| `dsh.compatibility.dshReleases` | `{ "0.2.1-rc.2": "compatible" }` | Keep if desired, but dshmarket ignores it |
| `engines.node` | `^22.19.0 || >=24.0.0` | ✔ (DSH runtime has Node 24.21.0) |
| `repository` | `git+https://github.com/Lancang-hzau/dsh-live-terminal.git` | Repo must be created and match |
| `homepage` / `bugs` | same repo | ✔ |
| `keywords` | includes `dsh-plugin`, `deepseek-harness`, `dsh` | ✔ |
| `license` | MIT + LICENSE | ✔ |
| `main` / `exports` | `lib/index.js`, `./client` → `lib/client.js` | ✔ |
| `files` | lib, patch, README, LICENSE, icon, screenshots.json | ✔; docs images are repo-only |
| `prepack` | `node tools/build-client.mjs` | Runs on `npm publish`; `lib/client.js` rebuilt |
| `publishConfig` | `access: public`, `registry: https://registry.npmjs.org/` | ✔ |
| `icon` | `icon.svg` (680 B) | ✔ (≤256 KiB, relative) |
| `screenshots.json` | 4 paths under `docs/screenshots/` | ✔ (repo-relative, 1–8) |
| `README.md` | exists at root, 7.8 KB, already uses `dsh-live-terminal`; npm badges are live before the first publish | Verify install text/badges after publishing |
| `locale/en.json` / `locale/zh.json` | absent | Optional; only for custom plugin-card title/description |
| `@deepseek-ai/*` dependencies | none in `dependencies` | ✔; host half intentionally imports none |
| `lib/client.js` prebuilt | 393 KB, included in pack | ✔; GitHub-source installs would need a build/allowBuilds, npm installs are prebuilt |
| GitHub repo | **does not exist** | Create, push, add `dsh-plugin` topic, wait 1 day |
| npm auth | not logged in (`ENEEDAUTH`) | `npm login --registry=https://registry.npmjs.org` |

The current `npm pack --dry-run --ignore-scripts` (no publish, no prepack) reports **19 files, ~137 KB**:
`LICENSE`, `README.md`, `cordis.patch.yml`, `icon.svg`, `lib/client.js`, 12 `lib/host/*.js`,
`lib/index.js`, `package.json`, `screenshots.json`. All critical runtime files are present.
Do **not** publish with `--ignore-scripts`; the real `prepack` rebuilds `lib/client.js` first.

### 4.3 Recommended `package.json` shape

Based on real catalog entries (`dsh-meme`, `@linxin666/dsh-pet`, `dsh-livechat`) and the official
docs:

```jsonc
{
  "name": "dsh-live-terminal",
  "version": "1.0.0",
  "description": "Visible terminal panel for DeepSeek Harness: live agent shell output + text terminal screenshots.",
  "type": "module",
  "license": "MIT",
  "author": "LANCANG",
  "homepage": "https://github.com/Lancang-hzau/dsh-live-terminal#readme",
  "repository": { "type": "git", "url": "git+https://github.com/Lancang-hzau/dsh-live-terminal.git" },
  "bugs": { "url": "https://github.com/Lancang-hzau/dsh-live-terminal/issues" },
  "icon": "icon.svg",
  "keywords": ["deepseek-harness", "dsh", "dsh-plugin", "deepseek", "cordis", "terminal", "pty", "xterm", "agent-tools", "screenshot", "sidebar"],
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "README.md", "LICENSE", "icon.svg", "screenshots.json"],
  "dependencies": {
    "@xterm/addon-serialize": "^0.14.0",
    "@xterm/headless": "^6.0.0"
  },
  "engines": {
    "node": "^22.19.0 || >=24.0.0",
    "dsh": ">=0.2.1-rc.2 <0.3.0-0"
  },
  "scripts": {
    "build": "node tools/build-client.mjs",
    "test": "node --test \"tests/*.test.mjs\"",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "prepack": "node tools/build-client.mjs"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-sidebar-right"]
    },
    "engines": { "dsh": ">=0.2.1-rc.2 <0.3.0-0" },
    "compatibility": { "dshReleases": { "0.2.1-rc.2": "compatible" } }
  },
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org/"
  }
}
```

Notes:

- `dsh.engines.dsh` is duplicated for dshmarket's discovery fallback (`manifestFacts` reads top-level first,
  then `dsh.engines.dsh`). It is harmless and adds robustness; it is **not** read by the catalog's
  `probe-npm`/index path, which reads top-level `engines.dsh`.
- Do not add `@deepseek-ai/*` to `dependencies`. If you genuinely import a host package, declare it in
  `peerDependencies` with an explicit prerelease branch, e.g.
  `"@deepseek-ai/dsh-tools": ">=0.2.1-rc.2 <0.3.0-0"`. A range like `>=0.0.1-rc.1 <0.2.0` silently
  excludes prerelease hosts under default node-semver; the catalog contributing guide has the exact
  `||` example. Our host half imports none.
- `icon` is a top-level field for the DSH Plugin Manager card; the catalog does not consume it, but
  `screenshots.json` is consumed by the storefront.
- Versioning: plain semver, bump each publish; `dist-tags.latest` is what the market displays/indexes.

---

## 5. Compatibility metadata: how the market decides

### 5.1 The cache file

`src/routes.ts` lines 516–518 constructs:

```ts
new DiscoveryManifestIndex(
  join(activeProfileDir, '.dsh-market', 'discovery-compatibility-v1.json')
)
```

So on Windows the cache is:

```text
C:\Users\LANCANG\.dsh\profiles\<profile>\.dsh-market\discovery-compatibility-v1.json
```

Schema (`src/discovery-compatibility.ts` lines 42–58):

```json
{
  "schema": "dsh-market/discovery-compatibility-cache/v1",
  "entries": {
    "dsh-live-terminal": {
      "checkedAt": 1792400000000,
      "facts": {
        "version": "1.0.0",
        "enginesDsh": ">=0.2.1-rc.2 <0.3.0-0",
        "peerDependencies": {}
      }
    }
  }
}
```

- It caches **facts only**, never conclusions; conclusions depend on the running host version.
- `checkedAt` is milliseconds; success TTL is 24 h; failures cool down 5 min, registry outages 30 s.
- Max 5,000 entries; persisted with mode `0600`.
- `peerDependencies` keeps only keys starting with `@deepseek-ai/`.

### 5.2 What is read from the npm manifest

`manifestFacts` (lines 79–100):

- `version`
- `enginesDsh` = top-level `engines.dsh`, else `dsh.engines.dsh` (top-level wins)
- `peerDependencies` filtered to `@deepseek-ai/*`

There is **no** read of `dsh.compatibility.dshReleases` anywhere in dshmarket. I grepped the whole
market source and the profile; the only `dshReleases` hit is a third-party package declaring it
(`dsh-context`), not a consumer. Treat it as informational for dshmarket; it cannot make the market
show “compatible”. (It may be used by some DSH Desktop/CLI surface inside the asar, which is not
inspectable from here — treat that as unverified, not as support.)

### 5.3 The verdict algorithm

`deriveHostCompatibility` (lines 162–196):

1. No facts (manifest unavailable) → `unknown` / `unavailable`.
2. Build declarations:
   - `engines.dsh` if present, kind `engine`;
   - every `@deepseek-ai/*` peer **only if** its name is in the local host-package inventory
     (`corePackageNames`) **and** matches `/^@deepseek-ai\/dsh(?:-|$)/`.
3. No declarations → `unknown` / `undeclared` (the market shows “not declared”).
4. Host version unknown → `unknown`.
5. Otherwise every declaration is conjunctive:
   - any `false` → **`incompatible`**;
   - all `true` → **`compatible`**;
   - otherwise `unknown`.

`rangeResult` calls `satisfiesRange(hostVersion, range, { includePrerelease: true })`
(lines 118–120) — discovery deliberately opts into npm's `includePrerelease` because DSH releases are
prereleases. The market's install preflight (`refuseHostIncompatible`, routes.ts lines 2006–2059) uses the
same derivation and **refuses an incompatible install with HTTP 400** unless `force` is passed. So a
wrong `engines.dsh` blocks installs from the market, not just the badge.

The install-time host gate (`src/verify.ts` `peerGateAt`, lines 269–313) mirrors DSH's own
`unmetRequirements`:

- an own **`engines.dsh` decides alone**; `peerDependencies` are then ignored;
- with no `engines.dsh`, the **first failing `@deepseek-ai/dsh*` peer** blocks;
- it also uses `satisfiesRange(..., { includePrerelease: true })`;
- a `workspace:` range is unsatisfiable for `engines`.

### 5.4 What to declare for DSH 0.2.1-rc.2

**Recommended:**

```json
"engines": {
  "node": "^22.19.0 || >=24.0.0",
  "dsh": ">=0.2.1-rc.2 <0.3.0-0"
},
"dsh": {
  "engines": { "dsh": ">=0.2.1-rc.2 <0.3.0-0" }
}
```

Why it shows compatible:

- `0.2.1-rc.2` is a prerelease; the `>=0.2.1-rc.2` comparator shares the exact `0.2.1` tuple and carries a
  prerelease tag, so even default node-semver admits it; dshmarket's `includePrerelease: true` admits it
  regardless.
- `<0.3.0-0` is the standard exclusive ceiling for the 0.2 line and excludes 0.3.0 and its prereleases.
- Future 0.2.x prereleases are admitted by the host's `includePrerelease: true` path; if you want to be
  stricter, list explicit `||` branches, at the cost of maintenance.

Do **not** keep `>=0.2.0-rc.2` unless you actually tested 0.2.0: it claims compatibility with 0.2.0 and
shows a wider requirement. Do **not** rely on `dsh.compatibility.dshReleases`; it is invisible to
dshmarket. If you add host peers, use the explicit prerelease branch from the catalog guide and only for
packages you truly import; otherwise `engines.dsh` is enough.

---

## 6. npm publish specifics (Windows PowerShell)

### 6.1 Environment facts (checked 2026-10-19)

- npm CLI **11.6.2**, Node **24.13.0** (shell default).
- `npm config get registry` → **`https://registry.npmmirror.com`** (read-only mirror; cannot publish).
- `npm whoami --registry=https://registry.npmjs.org` → **`ENEEDAUTH`** (not logged in).
- `npm view dsh-live-terminal version --registry=https://registry.npmjs.org` → **E404** (name available).
- `dsh-terminal-panel` is taken (`1.3.0`, repository `BaiZhi967/dsh-plugin-terminal-panel`).
- `publishConfig` in the current package already has `registry: https://registry.npmjs.org/` and
  `access: public`. npm documents `publishConfig` as publish-time config values (tag, registry, access)
  so you do not accidentally publish to the wrong registry:
  https://docs.npmjs.com/cli/v11/configuring-npm/package-json#publishconfig.

### 6.2 Commands

```powershell
cd "C:\Users\LANCANG\Desktop\Code\DSH plugin"

# 0) Sanity: default registry is a mirror; the name must be free on npmjs
npm config get registry
npm view dsh-live-terminal version --registry=https://registry.npmjs.org
# E404 = available; a version means taken. Also check the package page in a browser.

# 1) Log in to the official registry (web auth in npm 9+; run in a visible terminal if prompted)
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org

# 2) Preflight locally
node --test "tests/*.test.mjs"
npm pack --dry-run --ignore-scripts     # inspect file list only; no build
# or: npm publish --dry-run --registry=https://registry.npmjs.org

# 3) Publish. publishConfig.registry is respected, but pass --registry explicitly
#    so the npmmirror default can never be used by accident.
npm publish --registry=https://registry.npmjs.org --access public

# If the account enforces 2FA and npm does not prompt/open a browser:
# npm publish --registry=https://registry.npmjs.org --access public --otp 123456

# 4) Verify
npm view dsh-live-terminal version repository dist.tarball --registry=https://registry.npmjs.org
```

Notes and pitfalls:

- **Never run bare `npm publish` relying on the shell default**: it would target npmmirror and fail (or, worse,
  confuse diagnostics). Keep `--registry=https://registry.npmjs.org`.
- `publishConfig.registry` is respected at publish time, so a correctly configured `package.json` plus
  explicit `--registry` is belt-and-braces. `publishConfig.access: "public"` is only strictly needed for
  scoped packages, but harmless for unscoped.
- **Scoped vs unscoped.** Unscoped `dsh-live-terminal` is available and gives the shortest install command
  (`dsh plugin add dsh-live-terminal`). Scoped (`@lancang/dsh-live-terminal`) also works and is supported by
  the catalog (`NPM_NAME_RE`), but needs `--access public` and a longer install string. Prefer unscoped
  unless you want the namespace.
- **2FA/OTP.** If the account has 2FA for writes, `npm publish` prompts for an OTP or opens browser auth;
  `--otp <code>` is the non-interactive path. Check with `npm profile get --registry=https://registry.npmjs.org`.
  npm 11.5+ also supports trusted publishing (OIDC) in CI; not needed for a local first publish.
- **PowerShell execution policy.** If `npm` resolves to `npm.ps1` and is blocked, use `npm.cmd` or
  `& "E:\nodejs\npm.cmd" publish ...`.
- **Publishing a tarball** (useful for a reproducible artifact or when `prepack` already ran):
  ```powershell
  npm pack                                                  # runs prepack, creates dsh-live-terminal-1.0.0.tgz
  npm publish .\dsh-live-terminal-1.0.0.tgz --registry=https://registry.npmjs.org --access public
  ```
  `npm pack` / `npm publish` both run `prepack` (`node tools/build-client.mjs`), so the tarball gets a fresh
  `lib/client.js`. Do not pass `--ignore-scripts` for the real publish.
- **The `npm` field in the catalog is automatic**; do not add it to the YAML. The catalog's probe reads the
  repo `package.json` name and the npm `repository` field. Verify before/after publish:
  `npm view dsh-live-terminal repository --registry=https://registry.npmjs.org` must include
  `github.com/Lancang-hzau/dsh-live-terminal`.
- **Name squatting / availability:** `npm view` 404 is a good signal, but only publishing reserves it.
  Do it when the package is ready; a rename later invalidates repo links, README badges, screenshots and the
  catalog entry.
- **Dry run:** `npm publish --dry-run --registry=https://registry.npmjs.org` runs lifecycle scripts unless
  `--ignore-scripts`; it prints the file list and does not upload. Use it for a final content check.

---

## 7. Post-publish: visibility, updates, deprecation

### 7.1 Are both an npm publish and a catalog PR required?

- **Market listing:** catalog PR only. npm alone does not put a package in dshmarket (no npm discovery).
- **Full experience:** both. npm gives prebuilt installs, `version`/`downloads` display, sorting by
  downloads, and inclusion in the DSH 0.2.1 Discover `index.json` (npm-only).
- **Install command without npm:** the market falls back to `github:owner/repo` (or the `tarball:` release
  asset), which works if the repo is installable from source. GitHub installs may require the user to approve
  build scripts (`allowBuilds`); npm prebuilt installs skip that.

### 7.2 Timelines (as implemented)

| Event | When it becomes visible |
|---|---|
| Catalog PR merged | `sync-readme` regenerates READMEs, then `build-site` deploys the site. `plugins.json` on the Pages domain updates on that deploy (minutes; Actions queue can add time). dshmarket revalidates on every open, so no extra cache delay. |
| China-region dshmarket | Reads `dsh-plugin-catalog` from the Tencent npm mirror. That package is published only on the nightly/manual build (`23 2 * * *` UTC) and only when the catalog changed; expect up to ~24 h, sometimes longer if the nightly is delayed. |
| npm mapping (`npm`, `version`, `install` from npm) | `probe-npm.mjs` runs on the **nightly** full probe (pushes skip probes when the probe cache exists). Until then the new entry may have `npm: null` and a `github:` install command. |
| `downloads` / `stars` | Nightly probes (`probe-downloads`, `probe-stars`). `downloads` is the last-30-day window and `version` is `dist-tags.latest`. |
| Discover `index.json` | Site build includes npm entries only; official `awesome-dsh-plugin.com/index.json` updates with the site deploy. The npm package copy (jsdelivr) updates nightly. |
| New npm version of an existing plugin | No catalog PR. The next nightly probe updates the catalog's version/downloads. Installed users' market update checks query the registry directly (`updates.ts`: `dist-tags.latest`, plus beta/dev tags) and can see it much sooner. |
| Built-in Discover entry for a new version | Next site build after the nightly probe records the new version/publish time; index entries carry one version (latest). |

The catalog repo's `build-site.yml` comments are explicit: push builds **deploy but do not probe**; the
nightly is the authoritative refresh and the only run that publishes `dsh-plugin-catalog` /
update notes to npm.

### 7.3 Updates

- Publish `1.0.1` to npm; no catalog PR needed. The catalog's `version` and `downloads` refresh on the next
  nightly probe; the market's installed-plugin update check reads the registry directly.
- The market exposes a versioned update API (`UPDATE-API-V1.md`): summary, single-package check, start,
  poll, rollback, restart. It verifies the version pnpm actually placed on disk and can report
  `DOWNGRADE_DETECTED` / `RESOLVED_VERSION_MISMATCH`. New versions published less than ~26 h ago can be held
  by pnpm's release-age policy; `force` is the documented escape.
- Catalog metadata changes (description/category/screenshots) require a PR editing only your entry; for
  screenshots, update your own repo's `screenshots.json` (no PR; next nightly build picks it up).

### 7.4 Deprecation / replacement / removal

- dshmarket's `RegistryPlugin` type supports optional `deprecated: boolean` and `replacement: string`
  (`registry.ts` lines 42–48). The UI consumes them if the catalog supplies them.
- The current catalog has **0 deprecated entries**; there is no documented author-facing deprecation or
  replacement workflow in `contributing.md`.
- Removal happens by PR (fix/remove dead entries) or maintainer decay scans (repo gone/archived/dormant).
  The contributing guide says entries that stop being maintained, behave badly, or carry obvious defects
  get removed. For npm, `npm deprecate <pkg> "<message>"` is independent and does **not** remove the
  catalog listing.
- Open question: whether maintainers will accept an explicit `deprecated`/`replacement` field in an entry
  YAML today. It is not in `ENTRY_KEYS`, so it would currently be rejected; the fields appear to be
  catalog-generated, not author-authored.

---

## 8. Open questions / risks

1. **GitHub repo does not exist.** `https://github.com/Lancang-hzau/dsh-live-terminal` returns 404 and
   `git ls-remote` says “Repository not found” (2026-10-19). Confirm the account/org name and create it
   before anything else. All package URLs, the npm mapping, and the catalog entry depend on it.
2. **Repository age is a hard 24 h wait.** Create the repo now; the PR can be opened immediately but the
   gate will stay red until `created_at` is 1 day old. Do not close/reopen or spam pushes.
3. **Editorial duplication risk.** The catalog already lists many terminal plugins (`dsh-terminal`,
   `dsh-plugin-terminal`, `dsh-cool-terminal`, `dsh-terminal-button`, `dsh-oh-my-terminal`, etc., mostly
   `ui`/`tools`). The differentiator here is unique: live interception/mirroring of the agent's own
   `pwsh`/`bash` calls plus **text** terminal screenshots. Make the description say exactly that; a
   generic “terminal panel” claim may be judged already covered.
4. **`dsh.compatibility.dshReleases` has no dshmarket consumer.** It may be a convention for a DSH Desktop
   surface inside the asar that I cannot inspect. Keep it, but do not rely on it for the market badge or
   install gate; top-level `engines.dsh` is the operative declaration.
5. **China-region visibility lag** (npm catalog nightly) is expected; do not diagnose it as a failed
   submission.
6. **npm metadata lag** until the next nightly probe; the entry can appear with a GitHub install command
   first. If that is unacceptable, wait for the nightly and re-check `plugins.json` (or force a manual
   catalog build, which only maintainers can do).
7. **Name reservation risk.** `dsh-live-terminal` was free on 2026-10-19 but is not reserved until publish.
8. **Workspace moved during research.** Confirm the final repo root and commit the restructure before
   pushing. If the package name changes again, update all of: `package.json.name`, `cordis.patch.yml`
   row `name`, README install commands/badges, npm `repository`, and the catalog YAML filename/URL.
9. **Wider DSH compatibility.** `>=0.2.1-rc.2 <0.3.0-0` is correct for the tested host, but once DSH 0.3
   ships you must bump the range and republish; otherwise the market will correctly mark it incompatible.
10. **Community markets** such as `dshplugin.store` are not referenced by dshmarket. If the user wants to be
    listed there too, that is a separate submission process not covered by the official catalog repo.

---

## Appendix A — ready-to-submit catalog entry

Path: `data/plugins/Lancang-hzau__dsh-live-terminal.yml`

```yaml
url: https://github.com/Lancang-hzau/dsh-live-terminal
name: Lancang-hzau/dsh-live-terminal
category: ui
description:
  en: Visible terminal panel for DeepSeek Harness that mirrors agent shell commands and output live in a sidebar PTY terminal and lets the agent capture the terminal screen as text, including full-screen TUI apps.
  zh: DSH 可见终端面板：在右侧栏真实 PTY 中实时镜像 agent 的 shell 命令与输出，并允许 agent 以文本截取终端屏幕（支持 vim/htop 等全屏 TUI）。
```

If the maintainers prefer the tools category, `category: tools` is also defensible (the plugin registers
`live_terminal_*` tools). Do not add `npm:`, `tarball:`, screenshots, or any other key.

## Appendix B — exact URLs and sources

- Official catalog repo: https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
- Submission rules: https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md
- Catalog JSON: https://awesome-dsh-plugin.com/plugins.json
- Discover index: https://awesome-dsh-plugin.com/index.json
- Entry validator: https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/scripts/lib/entries.mjs
- Repo gate: https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/scripts/check-submission.mjs
- npm mapping probe: https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/scripts/probe-npm.mjs
- Catalog npm package: https://www.npmjs.com/package/dsh-plugin-catalog
- Market index format lib: https://www.npmjs.com/package/@deepseek-ai/dsh-plugin-market-index
- Official DSH plugin-authoring skill (published in): https://www.npmjs.com/package/@deepseek-ai/dsh-agent-preset
  (inside: `skills/cordis-plugin-development/SKILL.md`, `references/host-plugin.md`, `references/ui-plugin.md`)
- Community publishing guide: https://github.com/lishuo4096/dsh-plugin-authoring
  (`skills/dsh-plugin-publish/SKILL.md`, `references/market-listing.md`, `references/market-ci.md`)
- Release/pack guide: https://github.com/NanmiCoder/dsh-agent-teams/blob/main/skills/plugin-release/SKILL.md
- npm `package.json` / `publishConfig`: https://docs.npmjs.com/cli/v11/configuring-npm/package-json#publishconfig
- npm publish docs: https://docs.npmjs.com/cli/v11/commands/npm-publish

Local dshmarket source (read-only; do not modify):

- `C:\Users\LANCANG\.dsh\profiles\desktop\node_modules\dshmarket\src\registry.ts`
- `...\src\regions.ts`
- `...\src\catalog-npm.ts`
- `...\src\sources.ts`
- `...\src\discovery-compatibility.ts`
- `...\src\compatibility.ts`
- `...\src\routes.ts` (cache path line ~516, discovery endpoint ~2539, install preflight ~2006)
- `...\src\verify.ts` (engines.dsh decides alone, lines ~287–305)
- `...\src\check.ts` (`satisfiesRange` line ~637; `corePackageNames` line ~354)
- `...\src\updates.ts` (dist-tags latest, line ~291)
- `...\UPDATE-API-V1.md`
