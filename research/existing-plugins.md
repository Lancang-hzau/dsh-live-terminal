# DSH terminal / agent-terminal / terminal-screenshot plugins — evaluation

Date: 2026-10-19 (Asia/Shanghai)
Target: DeepSeek Harness Desktop 0.2.1-rc.2, Windows 10/11, profile `desktop`
Scope: existing community plugins vs. the official built-in terminal, judged against requirements **A / B / C**:

- **A** — bring up a real, interactive terminal window/panel inside the DSH Web GUI (real PTY).
- **B** — the DSH agent's terminal commands are shown in that terminal **live**, ideally running in the same visible terminal.
- **C** — the agent can capture / screenshot the current terminal content (text and/or image) with a tool.

Read-only constraint respected: nothing under `D:\DSH` or `C:\Users\LANCANG\.dsh` was modified.
All downloaded packages / extracted sources are under `C:\Users\LANCANG\Desktop\Code\DSH Plugs\dsh-live-terminal\research\sources\`.

---

## 0. TL;DR

1. **Requirement A is already satisfied out of the box.** DSH 0.2.1-rc.2 mounts the official right-sidebar terminal (`@deepseek-ai/dsh-client-ui-sidebar-terminal` 0.2.1-rc.2, row `ui-sidebar-terminal` in `dsh-web-app`'s `cordis.patch.yml`). Open the right sidebar → **New terminal**. No plugin is needed for A.
2. **The only maintained existing plugin that satisfies A + B + C(text) is `@hyzyn/dsh-tty` 0.32.3** (Apache-2.0, npm, Windows-capable). It gives an xterm/PTY sidebar panel, agent-opened terminal tabs that are visible and take-over-able by the user, and `tty_screen` (current visible screen as plain text) plus `tty_capture` (tail / last command + exit code).
3. **No existing plugin satisfies C as an image** for the terminal buffer itself. Two screenshot plugins can capture the *screen/window* (so the terminal must be visible), not a terminal by ID:
   - `dsh-screenshot-feedback-hook-mcp` 0.2.1 — returns a real image block, but captures a whole monitor and needs a Python CLI (`uvx`).
   - `@paicat1/dsh-screenshot` 1.2.0 — can `PrintWindow`-snap the DSH window (even occluded), but its agent tool only registers when `@liustack/modlens` is installed and it returns OCR/evidence + path rather than an image block.
4. **No plugin routes the default `bash` / `pwsh` tool into the visible terminal.** B is satisfied only when the agent uses the plugin's own terminal tools (`tty_run` / `tty_open` in dsh-tty). This is the main semantic gap if "every agent shell command must appear in the window" is a hard requirement.
5. **Do not install** `dsh-terminal` 0.1.1, `dsh-web-shell` 0.1.1, or `@easytz/dsh-terminal-panel` 0.2.7 on 0.2.1-rc.2: all three inject `@deepseek-ai/dsh-client-runtime`, which no longer exists in 0.2.1-rc.2 (renamed to `dsh-client-store`). Static scan of `app.asar`: `dsh-client-runtime` = 0 hits, `dsh-client-store` = 105 hits.
6. Recommendation: **install `@hyzyn/dsh-tty`, verify it on rc.2, and add a screenshot tool only if image output is mandatory**; or use the built-in terminal for A and the official *Persistent terminals* bundle for agent-side text, and build a thin custom bridge later if B must cover the default shell tool.

---

## 1. Method and evidence base

- Scanned the market snapshot `C:\Users\LANCANG\.dsh\profiles\desktop\.dsh-market\discovery-compatibility-v1.json` (2 975 entries) for `terminal|pty|shell|screenshot|xterm|console|tui|screen`; then widened with npm and web search (`dsh-shells`, `@easytz/dsh-terminal-panel`, `dsh-terminal-manager`).
- `npm view <pkg> --json` + `npm view <pkg> readme` for 17 candidates; READMEs saved in `...\research\readmes\`.
- `npm pack` + extraction of 15 tarballs into `...\research\sources\extracted\`; one GitHub repo cloned into `...\research\sources\git-repos\dsh-shells\`.
- Parsed `D:\DSH\resources\app.asar` read-only (header JSON + raw string scan; extractor scripts in `...\research\sources\asar-*.js`) and extracted the official terminal packages into `...\research\sources\official\@deepseek-ai\`.
- Read official package READMEs and source maps for the exact integration seams (`ctx.terminals`, `TerminalController`, `ctx.subprocess.spawnTerminal`, sidebar slot, tool catalogs).
- Public DSH repo confirmed: <https://github.com/deepseek-ai/deepseek-harness> (HTTP 200). Relevant docs: [`docs/subsystems/terminal.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/terminal.md), [`docs/capability-seams.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/capability-seams.md), [`docs/tool-catalog.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-catalog.md), [`docs/architecture.md`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md).
- All ratings below are based on shipped code/README evidence, not on visual testing (no plugin was installed, per the task).

### 1.1 The compatibility discriminator: `dsh-client-runtime` was removed

DSH 0.2.1-rc.2 ships `@deepseek-ai/dsh-client-store`; there is **no** `dsh-client-runtime` package or module id in `app.asar`.
Any plugin whose `dsh.client.inject` lists `@deepseek-ai/dsh-client-runtime` fails to compose its browser half on this host (the classic symptom is `Failed to load plugins` / "missed the module table").
This single fact eliminates three otherwise plausible terminal plugins.

---

## 2. Official baseline (no install required)

### 2.1 A — built-in right-sidebar terminal (`@deepseek-ai/dsh-client-ui-sidebar-terminal` 0.2.1-rc.2)

- **A: YES.** Interactive xterm.js tabs in the right sidebar, real PTY through `@deepseek-ai/dsh-api-terminal-controller` (which uses `ctx.subprocess.spawnTerminal`). Shell picker, rename, reconnect after reload, tab completion from the shell, theme/font settings, bounded scrollback. Windows shell discovery includes `pwsh`, `powershell`, `cmd` (default `cmd.exe` only when the provider omits a default). Source: `sources/official/@deepseek-ai/dsh-client-ui-sidebar-terminal/README.md` lines 12–38.
- **B: NO.** It is a *user* terminal: "Terminal history is bounded. The feature does not send terminal output to the Agent..." (`README.md` line 77). It uses a different service (`remote.terminal` / `TerminalController`) from the agent-side `ctx.terminals` registry.
- **C: NO** for the UI terminal. No model-facing tool is registered by this package. The Host *does* keep a serialized screen baseline (`BrowserTerminal` + `@xterm/addon-serialize` in `sources/official/@deepseek-ai/dsh-api-terminal-controller/lib/index.js` lines 315–349, 390–393), but it is not exposed to the agent.
- **Integration:** client plugin row `ui-sidebar-terminal` in `sources/official/@deepseek-ai/dsh-web-app/cordis.patch.yml`; host row `terminal-controller` (`@deepseek-ai/dsh-api-terminal-controller`) and `subprocess` in the same file. The row is unconditional, so it is already mounted in this profile.
- **Install:** none. Right sidebar → **New terminal** (select shell).
- **Risk:** official, MIT, exact version match; the only caveat is that it is explicitly excluded from the Agent transcript.

### 2.2 B/C — official *Persistent terminals* bundle (`@deepseek-ai/dsh-experimental-terminal-bundle`)

- **A: NO.** It has no UI; it is a host-only bundle that mounts a terminal registry and six agent tools.
- **B: PARTIAL.** The agent gets persistent PTY sessions: `terminal_open`, `terminal_send`, `terminal_read`, `terminal_signal`, `terminal_close`, `terminal_list` (`sources/official/@deepseek-ai/dsh-tool-terminal/lib/index.js` lines 265, 320, 467, 532, 586, 629). Output streams into tool results / background jobs (`run_in_background` + `job_output`), but there is **no terminal window showing it live**. Terminals are Agent-owned and isolated: "Terminals belong to the Agent that created them... the bundle does not share another terminal registry" (`.../dsh-experimental-terminal-bundle/README.md` line 66).
- **C: PARTIAL (text).** `terminal_read` returns a bounded page of retained terminal text (tool-terminal `README.md` lines 34–41); no image, and not the sidebar terminal's screen.
- **Integration:** bundle patch inserts `@deepseek-ai/dsh-terminal` + `@deepseek-ai/dsh-terminal-bash` (with `shellDialect: pwsh` on Windows) + `@deepseek-ai/dsh-tool-terminal` (`sources/official/@deepseek-ai/dsh-experimental-terminal-bundle/cordis.patch.yml`). Shipped switched off: "In Web or Desktop, open Plugins and enable **Persistent terminals** in Official" (`README.md` line 12).
- **Install:** none — enable **Plugins → Official → Persistent terminals** in the GUI. (Installed version is 0.2.1-rc.2; npm's public latest is 0.2.1-alpha.2, a different publishing line.)
- **Windows:** supported — the bundle enables a `pwsh` dialect on win32 (`cordis.patch.yml`).
- **Risk:** official, MIT, exact version; the limitation is exactly B/C scope, not stability.

### 2.3 Baseline verdict

| Requirement | Official baseline |
|---|---|
| A | **YES**, built-in right sidebar terminal |
| B | **NO** for the visible terminal; **PARTIAL** via *Persistent terminals* (agent-owned PTY tools, no live window) |
| C | **NO** for the visible terminal; **PARTIAL text** via `terminal_read` (agent-owned terminals only) |

---

## 3. Feature matrix — community candidates

Legend: **Y** = satisfies, **P** = partial/qualified, **N** = no. Evidence is linked to the extracted source tree.

| # | Package | Ver | Updated | License | A | B | C | How it integrates | Install command |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **`@hyzyn/dsh-tty`** | 0.32.3 | 2026-10-17 | Apache-2.0 | **Y** | **Y** | **P (text)** | Own host PTY registry + `ctx.subprocess.spawnTerminal`; WebSocket `/api/dsh-tty/ws`; client injects a sidebar entry and a modal/dock xterm panel; 19 agent tools (`tty_*`, `sftp_*`, `tunnel_*`) | `dsh plugin --profile desktop add @hyzyn/dsh-tty` (or market `@hyzyn/dsh-tty`); restart DSH |
| 2 | `dsh-shells` | 0.1.3 | 2026-10-18 (GitHub) | MIT | **P** (read-only) | **Y** | **P (text)** | Registers extra backends into official `ctx.terminals`; `dshShellsPanel` Remote `list`/`attach` streams `session.read()` text into a right-sidebar `<pre>`; agent tools are the official `terminal_*` six | `dsh plugin --profile desktop add github:liu-zhengdong/dsh-shells` (GitHub only; not on npm) |
| 3 | `dsh-terminal-button` | 0.4.3 | 2026-10-19 | MIT | **Y** | **N** | **N** | Reuses official `webTerminals` + official `TerminalBody` (`modules.importChunk('@deepseek-ai/dsh-client-ui-sidebar-terminal','client.terminal')`), renders it in `conversation.composer.dock`; host patches desktop `openTerminal` + `subprocess.spawnTerminal` PATH shim | `dsh plugin --profile desktop add dsh-terminal-button` |
| 4 | `dsh-bash-terminal-ts` | 0.8.2 | 2026-10-18 | MIT | **P** | **N** | **P (own tool)** | Host `shell` + `terminal` tools on `ctx.subprocess` / node-pty; bottom-dock tab only when `dsh-better-sidebar` is present; own WS routes | `dsh plugin --profile desktop add dsh-bash-terminal-ts` (+ `dsh-better-sidebar` for the tab; `pnpm approve-builds` for node-pty) |
| 5 | `dsh-cool-terminal` | 0.4.2 | 2026-10-16 | MIT | **Y** | **N** | **N** | Host registry over `ctx.subprocess.spawnTerminal`; SSE routes; client registers `conversation.view` slot with its own xterm consoles | `dsh plugin --profile desktop add dsh-cool-terminal` |
| 6 | `dsh-plugin-terminal` | 0.2.0 | 2026-08-19 | MIT | **Y** | **N** | **N** | Direct `node-pty` + `ws`; bottom panel; client injects `@deepseek-ai/dsh-client-ui-conversation` | `dsh plugin --profile desktop add dsh-plugin-terminal` |
| 7 | `dsh-zterm` | 0.1.13 | 2026-10-15 | MIT | **Y** | **Y** | **P (text)** | SSH/local PTY terminal in right workbench; 14 `zterm_*` tools execute in the human-bound visible terminal, read mode default / human enables write | `dsh plugin --profile desktop add dsh-zterm` (SSH-centric) |
| 8 | `dsh-terminal` | 0.1.1 | 2026-08-15 | MIT | **N** | **N** | **N** | Custom `term` Typert Remote + node-pty; client panel — **but** `dsh.client.inject` includes `@deepseek-ai/dsh-client-runtime` (absent on 0.2.1) | not recommended; would fail to compose |
| 9 | `dsh-web-shell` | 0.1.1 | 2026-08-15 | MIT | **N** | **N** | **N** | Right-docked xterm over `/api/shell` WS; **injects `dsh-client-runtime`** and depends on `@deepseek-ai/dsh-settings >=0.1.0-rc.5 <0.2.0` | not recommended |
| 10 | `@easytz/dsh-terminal-panel` | 0.2.7 | 2026-09-06 | MIT | **N** | **N** | **N** | Terminal panel on `@deepseek-ai/dsh-shell`; **injects `dsh-client-runtime`** | not recommended |
| 11 | `dsh-terminal-manager` | 0.1.1 | 2026-09-13 | MIT | **P** | **Y** | **P (text)** | SSH/Telnet multi-session xterm; `tm_*` tools share the same terminals with the human; built for DSH **0.1.2-rc.1** | not recommended on 0.2.1 (old baseline) |
| 12 | `@paicat1/dsh-screenshot` | 1.2.0 | 2026-09-08 | MIT | **N** | **N** | **P (image path/OCR)** | Browser hotkey route + `modlens_screenshot` tool (only if `@liustack/modlens` CLI found); PowerShell `CopyFromScreen` / `PrintWindow` full/region/window snap | `dsh plugin --profile desktop add @paicat1/dsh-screenshot` |
| 13 | `dsh-screenshot-feedback-hook-mcp` | 0.2.1 | 2026-08-28 | MIT | **N** | **N** | **P (image block)** | `take_screenshot` tool spawns Python CLI (`screenshot-feedback-hook-mcp capture --json`, mss+Pillow), stores image in `ctx.attachments`, renders an image block; monitor-level only | `dsh plugin --profile desktop add dsh-screenshot-feedback-hook-mcp` + `uvx`/pipx CLI |
| 14 | `dsh-screenshot-capture` | 0.2.4 | 2026-10-02 | MIT | **N** | **N** | **N** | Clipboard watcher + WinForms floating window + Obsidian/OCR; tools are only `screenshot_status`, `screenshot_inbox_list`, `screenshot_inbox_organize` — no capture tool | `dsh plugin --profile desktop add dsh-screenshot-capture` (not an agent terminal capture) |

Rows 8–14 are included for completeness; rows 8–10 are **incompatible** with 0.2.1-rc.2, row 11 is an old-baseline SSH product (its A/B/C "yes/partial" ratings describe its own design, not whether it loads on 0.2.1 — it was built and pinned for 0.1.2-rc.1), rows 12–14 are screen-capture tools rather than terminal plugins.

### 3.1 Secondary candidates (shell tools, not terminal windows)

| Package | Ver / updated | License | Why not a fit |
|---|---|---|---|
| `dsh-gitbash-shell` | 0.42.1 / 2026-10-18 | MIT | Replaces the Windows `bash` tool and registers Git Bash presets; no terminal panel, no screen capture. |
| `dsh-tweaks-git-bash-terminal-tool` | 0.5.1 / 2026-10-17 | MIT | Switches the model's `pwsh` tool to Git Bash; setting row only. |
| `dsh-task-console` | 0.24.0 / 2026-09-18 | MIT | Glass task board (jobs/subagents/canvas); not a terminal. |
| `dsh-ssh-tui` | 0.8.3 / 2026-10-17 | MIT | TUI profile only; declared compatible up to `<0.2.1`, not the Web GUI. |
| `seektty` | 1.3.0 | MIT | A separate full-screen terminal workspace for the DSH TUI, not a Web GUI panel. |
| `dsh-tmux-cc` | — | MIT | tmux control-mode cockpit; requires tmux, **Linux/macOS only**. |
| `dsh-remote-shell` | 0.1.0 | MIT | SSH/SFTP skill, no UI. |
| `dsh-remote-gui` | 0.1.3 | MIT | Embeds a remote DSH GUI over SSH, not a terminal. |
| `dsh-plugin-console` | 0.3.2 | MIT | Plugin catalog/profile manager. |

---

## 4. Deep dive on the strongest candidates

### 4.1 `@hyzyn/dsh-tty` 0.32.3 — best existing A+B+C(text)

**Package facts**

- npm: `@hyzyn/dsh-tty`, latest `0.32.3`, published **2026-10-17T16:27Z**, Apache-2.0, ~2.8 MB unpacked.
- Repo: <https://github.com/hyzyn/dsh-plugin-kit> (`packages/tty`), homepage <https://github.com/hyzyn/dsh-plugin-kit/tree/main/packages/tty>.
- deps: `ws`, `ssh2`, `@hyzyn/dsh-kit@0.5.3`, `@xterm/headless`, `@deepseek-ai/schemastery`. **No direct `node-pty` npm dependency** — local PTYs are obtained from `ctx.subprocess.spawnTerminal` (`lib/index.js` line 2786), so no native rebuild is required. It does, however, reach into the DSH node-pty-backed handle's internals for Windows kill safety (`handle._agent`, `terminal.kill`; see comments in `lib/index.js` lines 315–423), which couples it to DSH's node-pty version.
- Peer: `@deepseek-ai/dsh` / `dsh-tools` `^0.1.7-rc.2 || ^0.2.0-rc.1 || ... || ^0.2.1-rc.1`; `dsh.engines.dsh >=0.1.7-rc.2`. `^0.2.1-rc.1` includes `0.2.1-rc.2` under npm semver prerelease rules, but rc.2 is **not explicitly listed** — verify after install.
- `dsh.bundle.patch` inserts one row `tty`; `dsh.client.platform = web` with no external client-module injections (the 858 KB `client.js` is self-contained and uses `window.__ModuleLoader__`).

**A — interactive panel: YES**

- Sidebar entry "终端" opens a dock/modal with xterm.js tabs (WebGL renderer with DOM fallback), multi-tab, search, clear, rename, local and SSH sessions; panel can be minimized to a dock chip (README lines 16–60, 1143–1149).
- Real PTY: local path calls `ctx.get('subprocess').spawnTerminal({ argv, cwd })` (`lib/index.js` line 2786); SSH path is `ssh2` channels wrapped in the same `TermHandle` shape (README lines 1186–1194).
- Windows: explicitly supported in the description and validated by `scripts/windows-smoke.mjs`; PowerShell shell integration via a `-File` stub; bare LF is normalized to CRLF for Windows local sessions (README lines 129–136, 177). `cmd` is supported but has no command start/end markers (status "unknown").

**B — agent commands visible live: YES (for the plugin's own tools)**

- 19 agent tools are registered; the README states "操作实时显示在用户终端里" ("operations are displayed live in the user terminal", line 165).
- `tty_open` opens a **normal tab in the user's panel** ("开出来的会话出现在用户的终端面板里（普通标签、用户可见可接管），不做隐形会话", line 170; see also lines 211–215: "agent 开的标签... 用户看得见、点得开、接管得了、关得掉").
- `tty_run` is explicitly the "user must see this command" path: "何时用它而不是 bash 工具：需要用户**看得见**这条命令、或要跑在终端会话里时用它" (line 172). It opens a visible tab, runs the command, waits, and returns tail + exit code.
- `tty_send` writes into the live PTY (line 177), so the user can watch an interactive session and take over.
- **Gap:** the default DSH `bash`/`pwsh` tools still run outside this panel. B holds only for commands run via `tty_open` / `tty_run` / `tty_send`. There is no hook that redirects the standard shell tool into this panel.

**C — capture terminal content: PARTIAL (text only)**

- `tty_screen` reads the **current visible screen** through `@xterm/headless` and returns plain text (tool definition at `lib/index.js` line 5542; description: "读取某个终端面板会话当前可见屏幕的渲染结果（纯文本，等价于用户此刻看到的画面）... 能真正读懂 vim / htop / 菜单等 TUI 界面"). This is the closest thing to a terminal screenshot as text in the ecosystem.
- `tty_capture` (line 5448) reads a bounded tail (default 60 lines, max 500, ANSI stripped) and `last:true` returns only the last completed command's output + exit code via OSC 133 shell integration.
- `tty_expect` waits for a regex readiness marker; `tty_list` reports cwd, owner, `running` tri-state, and `lastExitCode`.
- **No image / PNG tool.** There is no `toDataURL`, canvas, or attachment code in the host or client bundle (grep found no `screenshot`/`png`/`attachment` implementation beyond an unrelated HTTP `Content-Disposition` string). C is satisfied for "text", not for "image".

**Risks / maintenance**

- Apache-2.0: forking is allowed; preserve `LICENSE`/`NOTICE` and state changes.
- The sidebar entry is injected by DOM mutation (`data-dsh-tty-entry`, `Sg()` in `client.js`), not a first-class slot. This is robust across slot renames but can break if the sidebar DOM changes.
- Large surface: 19 tools include SSH, SFTP, port forwarding, and `tty_send`/`tty_open` (arbitrary command execution). It has a per-call permission tier gate (`TTY_TIER_CLASS`, `lib/index.js` lines 181–198) but is still a high-trust plugin.
- Version skew risk: published same day as rc.2, tested against rc.1; `dsh.client` uses the internal `window.__ModuleLoader__`/`slots` API, and the host reaches into DSH's node-pty handle internals on Windows. Both are private-API dependencies that a future DSH release can break.

**Install**

```powershell
dsh plugin --profile desktop add @hyzyn/dsh-tty
# or use the DSH market entry @hyzyn/dsh-tty
# restart DSH Desktop, then open the sidebar "终端" entry
```

### 4.2 `dsh-shells` 0.1.3 — best reference for B, not a product

- GitHub only (<https://github.com/liu-zhengdong/dsh-shells>), MIT, created 2026-10-10, pushed 2026-10-18, **0 stars**, ~300 LOC. package.json version 0.1.3, deps pinned to **`@deepseek-ai/dsh-tool-terminal@0.2.1-rc.2`**, `dsh-terminal@0.2.1-rc.2`, `dsh-terminal-bash@0.2.1-rc.2`.
- **What it does:** registers `zsh`, `cmd`, `gitbash`, `pwsh` backends into the official `ctx.terminals` registry (using `BashTerminalBackend`), then exposes a `dshShellsPanel` Remote namespace with `list(sessionId)` and `attach(sessionId, terminalSessionId)` (`src/panel-remote.js` lines 49–120). `attach` polls `session.read()` every 300 ms and streams text lines.
- **Client:** a right-sidebar panel that renders the text in a `<pre>` and lets the user pick a session (`client/client.js` lines 105–180+). **Read-only** — there is no `write`/`send` path; the human cannot type into it. So A is only partial (a viewer, not an interactive terminal).
- **B: YES** — the sessions it lists are exactly the official `terminal_open` sessions owned by the current agent session (`owner.session.id`); the panel follows the same PTY stream live.
- **C: PARTIAL text** — the panel shows `read()` text; the agent has official `terminal_read`; no image.
- **Why not install:** 0-star, single-author, unverified on Windows (author note in README), read-only panel, and it declares `@deepseek-ai/dsh-*` packages as ordinary dependencies — installing it into a profile can create duplicate host package copies, the exact failure mode documented by `dsh-screenshot-feedback-hook-mcp` (its README warns that a second `@deepseek-ai/dsh-tools` in the profile breaks every tool call). Use it as source inspiration, not as a dependency.
- **Why it matters:** it is the smallest working example of exposing `ctx.terminals` sessions to the Web UI via a Typert Remote stream, and it compiles against the exact installed version 0.2.1-rc.2.

### 4.3 `dsh-terminal-button` 0.4.3 — best A-only extension of the official terminal

- MIT, 2026-10-19, explicitly requires **DSH Desktop 0.2.1-rc.2+** and the official sidebar-terminal plugin enabled (README lines 14–19).
- Renders the official `TerminalBody` inside `conversation.composer.dock` by lazy-loading the official chunk: `modules.importChunk(TERMINAL_PACKAGE, TERMINAL_CHUNK)` (`client.js` lines 98–109), and obtains data from the official client service `webTerminals` (`client.js` line 188, `inject = ["slots", "webTerminals"]` line 325). It keeps official retention/hold semantics via a `retainTabs` bridge (`client.js` lines 48–82).
- Host half patches desktop `openTerminal` to open the bottom panel and adds a `dsh` CLI shim through `subprocess.spawnTerminal` PATH injection (`index.js` header lines 1–25; routes `/dsh-terminal/events`, `/dsh-terminal/open-native`, `/dsh-terminal/health`).
- **A: YES; B/C: NO.** It is a second *surface* for the user terminal, not an agent bridge.
- **Risk:** depends on the internal official chunk name `lib/client.terminal.js` and the `webTerminals` service; version-coupled to 0.2.1.x.
- **Market lag:** this profile's discovery snapshot lists `dsh-terminal-button` 0.3.7 (the old self-contained terminal design), while npm has 0.4.3 (the official-terminal extension). Install 0.4.3 from npm if using the CLI; the market's 0.3.7 should not be used on 0.2.1-rc.2.

### 4.4 `dsh-zterm` 0.1.13 — B for SSH-bound terminals

- MIT, 2026-10-15, 1.0 MB, repo <https://github.com/guhanfei-ai/dsh-zterm>. Baseline declared DSH `0.2.0-rc.2`; optional `dsh-better-sidebar`; local PTY is optional (`node-pty` only if the host-local terminal is enabled).
- Human terminal in the right workbench (SSH/JumpServer assets on the right), plus 14 `zterm_*` tools. The AI is explicitly **bound** to one visible terminal; read tools are default, and the human must tick "allow AI write operations" before commands are executed (README lines 14–23, 53–58).
- **A: YES; B: YES** (AI commands execute in the visible bound terminal with real exit codes); **C: PARTIAL text** (tool results include command output/exit code; no screen snapshot or image).
- **Why not first choice:** SSH-centric (the target is a remote host); local PTY is secondary; a heavier product with credentials vault, JumpServer, SFTP, recording. If the user's scenario is "agent operates a remote server and I watch", this is a strong fit; for a local Windows terminal, dsh-tty is simpler.

### 4.5 Screenshot plugins — what C can and cannot do today

**`dsh-screenshot-feedback-hook-mcp` 0.2.1** (MIT, 2026-08-28, <https://github.com/lkh081231/screenshot-feedback-hook-mcp>)

- `take_screenshot` is a real model tool with an **image output schema**: it stores the PNG/JPEG in `ctx.attachments` and renders an image block into the conversation (`sources/extracted/dsh-screenshot-feedback-hook-mcp-0.2.1/package/lib/tools.js` lines 37–160; output schema includes `image.attachmentId/mediaType/bytes/width/height`).
- Capture is delegated to the Python `screenshot-feedback-hook-mcp` CLI (`capture --json`, mss + Pillow) via `uvx`/pipx; the tool takes only `monitor` (0 = all, 1..N) and `delay_ms` — **no window/region/terminal selector** (tools.js lines 86–104).
- C for a terminal: **partial** — it captures the monitor; if the DSH window with the terminal is visible, the image contains the terminal. It cannot target the terminal by id, crop to it, or read the xterm buffer.
- Requirements: `uv`/Python CLI >= 0.3.0, image-capable model, `ctx.attachments`; the plugin refuses to capture when the current model has no image input (`assertImageCapableRoute`).

**`@paicat1/dsh-screenshot` 1.2.0** (MIT, 2026-09-08, <https://github.com/paicat1/dsh-screenshot>)

- Windows-only, zero binary deps, pure PowerShell. Human: `Ctrl+Alt+S` region/window-snap, `Ctrl+Shift+Alt+S` full screen; the window snap uses `PrintWindow(PW_RENDERFULLCONTENT)` and can capture an occluded window (README lines 13–20, 57–59).
- Agent: `modlens_screenshot` tool with `mode: full|region`, optional `prompt` (`sources/extracted/paicat1-dsh-screenshot-1.2.0/package/dsh/index.js` lines 958–1035). **It only registers if a `@liustack/modlens` CLI is found** (`CLI_PATH` check at apply, lines 1055–1080); otherwise there is no agent tool.
- Result is OCR/structured evidence + screenshot path, not an image block. It can `PrintWindow` the DSH window (the exception is a standalone PowerShell/conhost window), so it can capture the terminal *visually*; it does not know what a terminal is.
- **C: partial (image file + OCR), conditional on modlens.**

**`dsh-screenshot-capture` 0.2.4** (MIT, 2026-10-02)

- Human workflow: clipboard watcher → WinForms floating window (comment/key point/copy/save) → Obsidian note + OCR through the host multimodal model (`README.md` lines 19–28).
- Registered tools are `screenshot_status`, `screenshot_inbox_list`, `screenshot_inbox_organize` (`index.mjs` lines 303–370); **there is no capture tool**. Not usable for C.

**Implication:** for C-as-image, either (a) pair dsh-tty with a screen-capture plugin and accept "whatever is visible on the monitor", or (b) build a terminal-buffer screenshot tool inside the terminal plugin (see §6).

---

## 5. Compatibility, dependencies, risk

| Package | DSH 0.2.1-rc.2 | Native deps | Windows | Maintenance | Main risk |
|---|---|---|---|---|---|
| official sidebar terminal | exact (0.2.1-rc.2) | uses DSH `subprocess`/ConPTY | yes (pwsh/powershell/cmd) | official | none functional; B/C excluded by design |
| official terminal bundle | exact (0.2.1-rc.2) | uses DSH `subprocess` | yes (`pwsh` dialect) | official | no live UI, no image |
| `@hyzyn/dsh-tty` 0.32.3 | peer lists rc.1; likely OK, verify | none (`spawnTerminal`, but pokes node-pty handle internals) | yes (PowerShell integration; cmd limited) | active (Oct 17) | DOM-injected sidebar entry; 19 tools; rc.2 not explicit; private-API coupling |
| `dsh-shells` 0.1.3 | deps pinned 0.2.1-rc.2 | none | code exists, **author says unverified** | new (Oct 18), 0 stars | read-only UI; duplicate `@deepseek-ai` deps; GitHub only |
| `dsh-terminal-button` 0.4.3 | requires Desktop ≥0.2.1-rc.2 | none | yes | active (Oct 19) | internal official chunk + `webTerminals` coupling |
| `dsh-bash-terminal-ts` 0.8.2 | engines include 0.2.1-rc.2 | `node-pty@1.2.0-beta.15` (prebuilds) | yes (4 shells) | active (Oct 18) | needs `dsh-better-sidebar` for the tab; model/UI PTYs are separate |
| `dsh-cool-terminal` 0.4.2 | no explicit statement; recent | none (`spawnTerminal`) | yes (PowerShell/cmd default) | active (Oct 16) | `conversation.view` slot / host routes; no agent tools |
| `dsh-plugin-terminal` 0.2.0 | unverified (Aug 19) | `node-pty` | yes (ConPTY) | stale (~2 months) | native build; older client slot; no agent tools |
| `dsh-terminal` 0.1.1 | **NO** (`dsh-client-runtime`) | node-pty | n/a | no releases since Aug 2026 | client half cannot load |
| `dsh-web-shell` 0.1.1 | **NO** (`dsh-client-runtime`, settings `<0.2.0`) | none | bash/zsh only | no releases since Aug 2026 | cannot load; shells unsuitable |
| `@easytz/dsh-terminal-panel` 0.2.7 | **NO** (`dsh-client-runtime`) | none | unknown | stale (Sep 6) | client half cannot load |
| `dsh-terminal-manager` 0.1.1 | **NO** (built for 0.1.2-rc.1) | none | SSH/Telnet | stale (Sep 13) | old `@deepseek-ai/*` pin |
| `dsh-zterm` 0.1.13 | baseline 0.2.0-rc.2 | optional node-pty | local PTY optional; SSH cross-platform | active (Oct 15) | SSH-centric; approval flow |
| `@paicat1/dsh-screenshot` 1.2.0 | no constraint; tool API simple | none (PowerShell) | Windows only | Sep 8 | agent tool requires modlens; no terminal targeting |
| `dsh-screenshot-feedback-hook-mcp` 0.2.1 | requires ≥0.1.0-rc.8 | Python CLI | yes (mss) | Aug 28 | Python/uv dependency; monitor only |
| `dsh-screenshot-capture` 0.2.4 | 0.1.7+ | PowerShell 5.1 | Windows only | Oct 2 | no capture tool; Obsidian workflow |

**Native-build note.** `node-pty` 1.2.0-beta.15 ships prebuilt binaries for all platforms, and DSH itself already ships `node-pty` inside `app.asar.unpacked/dsh/node_modules/node-pty`; nevertheless pnpm 10+ may print `ERR_PNPM_IGNORED_BUILDS` and require `pnpm approve-builds` / `onlyBuiltDependencies: ["node-pty"]`. Plugins that go through `ctx.subprocess.spawnTerminal` (official, dsh-tty, dsh-cool-terminal) avoid this entirely.

**Duplicate-host-package hazard.** `dsh-shells` and older `dsh-screenshot-feedback-hook-mcp` 0.1.0 install `@deepseek-ai/dsh-*` packages into the profile. A second `@deepseek-ai/dsh-tools` in the profile is known to break *every* tool call (`Cannot read properties of undefined (reading 'prepare')`, see the screenshot-feedback README "Upgrading from 0.1.0"). If using dsh-shells, first rewrite its deps to `peerDependencies` and let the host resolve them.

---

## 6. Recommendation

### 6.1 If the goal is "use something now"

1. **A first, no install:** open the right sidebar → **New terminal**. This is the official 0.2.1-rc.2 terminal; it is already mounted. Confirm Windows PowerShell/cmd are in the shell menu.
2. **For B + C(text): install `@hyzyn/dsh-tty` 0.32.3.**
   - It is the only npm-published, actively maintained plugin that combines an interactive xterm panel (A), agent-opened visible tabs / live output (B), and current-screen text capture (C-text).
   - Use `dsh plugin --profile desktop add @hyzyn/dsh-tty`, restart DSH Desktop, then test on rc.2:
     - `tty_open` a tab and confirm the tab appears in the sidebar panel;
     - run a command with `tty_run` and confirm live output + exit code;
     - run `tty_screen` on a TUI (`vim`/`htop`) and confirm the screen text.
   - Because the peer range names rc.1, treat the first run as a compatibility test. If the client bundle fails, the failure is isolated to this plugin; remove it and fall back to §6.2.
3. **For an image of the terminal**, add one of:
   - `dsh-screenshot-feedback-hook-mcp` if a Python CLI is acceptable and the model accepts images — best image-block UX;
   - `@paicat1/dsh-screenshot` if a pure-PowerShell, Windows window-snap is preferred and modlens is acceptable;
   - Otherwise accept C-text (`tty_screen`) until a custom image tool is built.
   Both capture the *screen*, not the terminal buffer; the DSH window must be visible (paicat can snap an occluded window via `PrintWindow`, but still captures the whole window, not the terminal element).

### 6.2 If "official only" is preferred

- A: built-in right-sidebar terminal.
- B/C-text: enable **Plugins → Official → Persistent terminals**; the agent can then use `terminal_open/send/read/...`. There is no live terminal window, but `terminal_read` gives bounded text and `run_in_background` + `job_output` gives streaming job output.
- This is the lowest-risk path (zero third-party code, exact version), at the cost of B not being visual.

### 6.3 If B must cover the *default* `bash`/`pwsh` tool

No existing plugin does this. Options, in increasing effort:

1. **Behavioral workaround:** instruct the agent (system prompt / skill) to use `tty_run` instead of `bash` whenever the user should see the command. dsh-tty's own tool description already encodes this preference. This is free but not enforceable for every call.
2. **Thin bridge plugin:** register a wrapper around the standard shell tool that creates a `ctx.terminals` session (or reuses dsh-tty's) and forwards output to the panel. This is essentially `dsh-bash-terminal-ts` with a shared registry; medium effort, but the default tool is owned by presets, so replacement is invasive.
3. **Fork dsh-tty / build on official `ctx.terminals`:** see §6.4.

### 6.4 Build vs. fork (if image C or strict B is required)

**Recommended base: `@hyzyn/dsh-tty` (Apache-2.0).** It already owns both ends (host PTY registry + browser panel + WebSocket) and has the agent tools. Add one tool:

- `tty_screenshot { sid, format?: "png" }`:
  1. Host tool sends a `capture` frame over the existing `/api/dsh-tty/ws` connection for that sid (or a small HTTP request keyed by sid).
  2. Client serializes the xterm buffer. Two practical routes:
     - **Text-first:** `term.buffer.active` → lines → render to an offscreen `<canvas>` with the terminal font/colors → `canvas.toDataURL("image/png")`. This reproduces the visible screen (including TUI layout) and needs no new native dependency.
     - **DOM-first:** `html2canvas` on the terminal element (adds a browser dependency; handles cursor/colors more faithfully but heavier).
  3. Client POSTs the data URL to a loopback route (`/api/dsh-tty/screenshot`), host decodes it, stores via `ctx.attachments`, and the tool returns an image block (copy the schema/render pattern from `dsh-screenshot-feedback-hook-mcp/lib/tools.js` and `lib/content.js`).
  4. Fallback when the client is disconnected: return `tty_screen` text with a warning.
- Effort: ~2–4 days for someone comfortable with the codebase; main risks are xterm canvas fidelity (CJK/wide chars, cursor, selection) and attachment plumbing.
- License: Apache-2.0 — keep `LICENSE`, add `NOTICE`/modification statement; no copyleft obligation on the host.

**Alternative base: `dsh-shells` (MIT, ~300 LOC).** Add an xterm panel with `term.write` + `session.startSend` for input and a `tty_screenshot` as above. Cleaner/smaller, but you inherit its read-only design, its unverified Windows backends, and its `@deepseek-ai` dependency problem. Effort ~4–7 days. Best used as a *reference* for the Remote `list`/`attach` stream (`src/panel-remote.js`), not as the product base.

**Build from official primitives (no third-party PTY).** Use `ctx.terminals` (`spawn`, `startSend`, `read`, `signal`, `kill`, `list`; documented in `docs/subsystems/terminal.md`), plus a Remote namespace and a client panel. For the panel you can either:
- reuse the official `TerminalBody` chunk the way `dsh-terminal-button` does (`modules.importChunk`), but that body is wired to `webTerminals`/`TerminalController`, not to `ctx.terminals`; or
- render your own xterm instance against the `ctx.terminals` stream (what dsh-tty does).
Effort ~1–2 weeks for a robust A/B/C-text plugin; image adds ~3–5 days. This path avoids native deps and stays closest to the official Windows PowerShell backend, but it has the most integration work.

### 6.5 Decision matrix

| Need | Best choice | Why |
|---|---|---|
| A only | Official right-sidebar terminal | Zero install, exact version, Windows shells |
| A + bottom panel, no agent | `dsh-terminal-button` 0.4.3 | Reuses official PTY/xterm; explicit 0.2.1-rc.2 support |
| A + B + C(text) | **`@hyzyn/dsh-tty` 0.32.3** | Only maintained all-in-one; agent-visible tabs; `tty_screen` |
| B with official-only code | Official *Persistent terminals* (+ optional `dsh-shells` viewer) | No third-party PTY; read-only viewer reference |
| C image, minimal work | `dsh-screenshot-feedback-hook-mcp` | True image block; monitor-level capture |
| C image, Windows-native | `@paicat1/dsh-screenshot` | `PrintWindow` window snap; needs modlens for the agent tool |
| Strict B for default shell | Custom bridge/fork | No existing plugin redirects `bash`/`pwsh` into a visible panel |
| Fork-friendly reference | `@hyzyn/dsh-tty` (Apache-2.0) / `dsh-shells` (MIT) | Complete vs. minimal implementations |

---

## 7. Reference implementations (paths + key files)

All paths are under `C:\Users\LANCANG\Desktop\Code\DSH Plugs\dsh-live-terminal\research\sources\`.

### 7.1 Complete A+B+C(text) implementation

- `extracted\hyzyn-dsh-tty-0.32.3\package\lib\index.js`
  - `spawnTerminal` local PTY: **line 2786**
  - `tty_open` tool: **line 5245**; `tty_run`: **5304**; `tty_capture`: **5448**; `tty_screen`: **5542**; `tty_send`: **5757**
  - permission tier map: lines 181–198; tool registration: lines 5158–6223; system-prompt context: ~6398
- `extracted\hyzyn-dsh-tty-0.32.3\package\client.js`
  - self-contained xterm panel + sidebar DOM entry: search `data-dsh-tty-entry`, `t.inject=["slots","sessions"]`, `u.provide("ttyTerminal"`, `u.provide("ttyPanel"`
  - panel markup/creation: `ta()` (modal), `mg()` (dock), `Zi()` (minimize)
- `extracted\hyzyn-dsh-tty-0.32.3\package\scripts\windows-smoke.mjs` — Windows/ConPTY behavior tests

### 7.2 Minimal official-PTY → UI bridge (read-only)

- `git-repos\dsh-shells\src\panel-remote.js` — `ShellsPanelService`, `list`/`attach`, `session.read()` polling: **lines 49–120**; Remote descriptor: 123–141
- `git-repos\dsh-shells\src\index.js` — backend registration (`BashTerminalBackend`, `ctx.terminals.registerBackend`), Windows `cmd`/`gitbash`/`pwsh`: lines 76–171
- `git-repos\dsh-shells\client\client.js` — right-sidebar panel, `AttachStream`, text rendering: lines 105–180+
- `git-repos\dsh-shells\package.json` — official deps pinned 0.2.1-rc.2: lines 37–41

### 7.3 Official terminal primitives

- `official\@deepseek-ai\dsh-terminal\lib\index.js` — `TerminalSessionService` (`spawn`, `startSend`, `read`, `signal`, `kill`, `list`): lines 48–299
- `official\@deepseek-ai\dsh-terminal-bash\lib\index.js` — `BashTerminalBackend`, `shellDialect` (`bash`/`pwsh`), sanitizer, scrollback, readiness
- `official\@deepseek-ai\dsh-api-terminal-controller\lib\index.js` — `BrowserTerminal` + `@xterm/addon-serialize` screen snapshot: lines 315–349, 390–393; `TerminalController` class: 626+; `create`: 824; `attach`: 887
- `official\@deepseek-ai\dsh-tool-terminal\lib\index.js` — six tools: `terminal_open` 265, `terminal_send` 320, `terminal_read` 467, `terminal_signal` 532, `terminal_close` 586, `terminal_list` 629
- `official\@deepseek-ai\dsh-client-ui-sidebar-terminal\lib\client.terminal.js` — official xterm body chunk (686 KB), loaded lazily by the sidebar
- `official\@deepseek-ai\dsh-web-app\cordis.patch.yml` — `ui-sidebar-terminal` and `terminal-controller` rows

### 7.4 Embedding the official terminal in another surface

- `extracted\dsh-terminal-button-0.4.3\package\client.js`
  - `loadOfficialTerminalBody` via `modules.importChunk`: **lines 98–109**
  - `webTerminals` lookup: **line 188**; `inject = ["slots","webTerminals"]`: **line 325**
  - `retainTabs` bridge: **lines 48–82**
- `extracted\dsh-terminal-button-0.4.3\package\index.js` — desktop `openTerminal` patch, SSE route, `spawnTerminal` PATH shim: header lines 1–25

### 7.5 Image attachment plumbing (for a future `tty_screenshot`)

- `extracted\dsh-screenshot-feedback-hook-mcp-0.2.1\package\lib\tools.js` — `take_screenshot` definition, `image` output schema: lines 37–160
- `...\lib\content.js` — `imageValueFromRef`, `screenshotContent` (how to build the image block)
- `...\lib\capture.js` — CLI spawn, attachment storage, pruning: lines 1–80+
- `extracted\paicat1-dsh-screenshot-1.2.0\package\dsh\index.js` — PowerShell `PrintWindow`/`CopyFromScreen` script and `screenshotTool`: lines 60–400 and 958–1035
- `official\@deepseek-ai\dsh-api-terminal-controller\lib\index.js` — host-side screen snapshot/serialize pattern (text, not image)

### 7.6 Official docs / upstream

- <https://github.com/deepseek-ai/deepseek-harness> — public repo, MIT
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/terminal.md> — `ctx.terminals` contract (`spawn`, `startSend`, `read`, `signal`, `kill`, `list`)
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/capability-seams.md> — plugin/capability seams
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-catalog.md> — terminal tool schemas
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md>
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/web-styling.md> — DSH theme tokens for a custom panel

---

## 8. Gaps and open questions

1. **B is tool-mediated, not automatic.** dsh-tty satisfies B only for `tty_run`/`tty_open`; the stock `bash`/`pwsh` tool remains invisible. If the Lead's requirement is literally "every agent terminal command appears in the window", no existing plugin meets it; a custom bridge/fork is required.
2. **C image is unsolved for terminal buffers.** The existing screenshot plugins capture monitors/windows; none reads the xterm buffer or crops to the terminal element. A custom `tty_screenshot` is the clean solution; effort ~3–5 days on top of dsh-tty.
3. **rc.2 testing is static here.** No plugin was installed. dsh-tty's peer range names rc.1; its publish date is the same day as rc.2. First install should be treated as a smoke test (panel loads, agent tab visible, `tty_screen` works).
4. **Sidebar DOM injection is the main fragility of dsh-tty.** A future DSH sidebar restyle can break the entry injection even if the host half still works. The host tools would remain usable (agent-only), but A would degrade.
5. **`dsh-shells` is a reference, not a dependency.** Its direct `@deepseek-ai/dsh-*` dependencies are a known duplicate-instance hazard; if reused, convert to peers and resolve against the DSH install.
6. **Screenshot plugins add a second capture stack.** `dsh-screenshot-feedback-hook-mcp` needs Python/uv and an image-capable model; `@paicat1/dsh-screenshot` needs modlens for its agent tool. Neither is a drop-in "terminal screenshot".

---

## 9. Appendix — artifacts and commands

### 9.1 Downloaded / extracted

- Tarballs: `sources\tarballs\*.tgz` (dsh-terminal, dsh-plugin-terminal, dsh-bash-terminal-ts, dsh-cool-terminal, dsh-web-shell, dsh-terminal-button, dsh-zterm, dsh-gitbash-shell, dsh-tweaks-git-bash-terminal-tool, dsh-ssh-tui, dsh-task-console, dsh-screenshot-capture, dsh-screenshot-feedback-hook-mcp, @paicat1/dsh-screenshot, @hyzyn/dsh-tty)
- Extracted: `sources\extracted\<name>\package\...`
- GitHub: `sources\git-repos\dsh-shells\` (MIT, 0.1.3)
- Official asar extraction: `sources\official\@deepseek-ai\{dsh-experimental-terminal-bundle, dsh-client-ui-sidebar-terminal, dsh-api-terminal-controller, dsh-tool-terminal, dsh-terminal, dsh-terminal-bash, dsh-web-app, dsh-base}`
- READMEs: `research\readmes\*.md`; npm metadata: `research\npm-json\*.json`, `research\candidate-summary.json`
- Asar tools: `sources\asar-list2.js`, `sources\asar-extract.js`, `sources\asar-strings.js`, `sources\asar-files.json`

### 9.2 Commands used (representative)

```powershell
npm view @hyzyn/dsh-tty --json
npm view @hyzyn/dsh-tty readme
npm pack @hyzyn/dsh-tty --pack-destination "...\sources\tarballs"
tar -xzf "...\hyzyn-dsh-tty-0.32.3.tgz" -C "...\sources\extracted\hyzyn-dsh-tty-0.32.3"
node "...\sources\asar-extract.js" "/dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar-terminal"
node "...\sources\asar-strings.js"   # dsh-client-runtime vs dsh-client-store counts
git clone --depth 1 https://github.com/liu-zhengdong/dsh-shells.git "...\sources\git-repos\dsh-shells"
```

### 9.3 Install-command caveat for Desktop

DSH Desktop has no standalone `dsh` executable on PATH by default (the CLI lives inside `app.asar`). In practice install via the GUI **Plugins / market** page, or use the `dsh` shim that `dsh-terminal-button` adds for its terminals. The `dsh plugin --profile desktop add ...` commands above are the canonical form and work wherever a `dsh` CLI is available.
