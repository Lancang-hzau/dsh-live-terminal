# DSH visible-terminal plugin — implementation blueprint

Status: research / architecture note (not final code)
Target: **DeepSeek Harness Desktop 0.2.1-rc.2**, Windows 10/11, Web GUI
Workspace: `C:\Users\LANCANG\Desktop\Code\DSH Plugs\dsh-live-terminal`
Author: SDK/architecture research subagent
Date: 2026-10-19 (Asia/Shanghai)

---

## 0. TL;DR

Build a **single dual-face DSH plugin** named `dsh-terminal-panel` (the existing
scaffold in `packages/dsh-terminal-panel` uses this name) that owns:

1. **Host half** — a per-Agent/per-Session live terminal service built on
   `ctx.subprocess.spawnTerminal` (real ConPTY on Windows, no `node-pty`
   dependency), a `@xterm/headless` + `@xterm/addon-serialize` mirror of the
   screen, an authenticated SSE/HTTP surface for the browser, and model-facing
   tools:
   - `live_terminal_open` — open a visible terminal owned by this Agent.
   - `live_terminal_run` — write one command, wait for quiescence, return the
     current screen.
   - `live_terminal_send` — raw input (REPL / interactive / Ctrl-C).
   - `live_terminal_screenshot` — current visible screen as text (and optionally
     a PNG image block).
2. **Client half** — xterm.js 6 rendered in the **global bottom slot
   `shell.bottom`** (recommended), with a small `shell.overlay` toggle when the
   panel is closed. The panel streams PTY output over SSE, sends keystrokes
   back over POST, and auto-opens when an Agent tool starts using the terminal.

Why not re-use the official user terminal (`ctx.terminalController` /
`webTerminals`) as the agent's terminal? Its `attach()` is a Typert Remote
stream and requires a live `ctx.invocation` (`BrowserTerminal.attach` throws
"Terminal attachment requires a Remote invocation" without one —
`dsh-api-terminal-controller/lib/types/terminal.js`), so a Host tool cannot
write into it. Its screen serializer is private. It also runs **outside** the
Agent sandbox by design. Our own PTY service is the smallest design that gives
one shared PTY to the UI and the Agent, plus a screen grid for screenshots.

Why not `ctx.terminals` (`@deepseek-ai/dsh-terminal`)? It is owner-scoped and
excellent for persistent Agent sessions, but its public `read()` is
**line-oriented sanitized text**, not a terminal screen
(`dsh-terminal/lib/types/types.d.ts` `TerminalReadResult`), and it exposes no
output subscription for a live ANSI mirror. Its own `terminal-bash` backend
keeps a zero-scrollback headless xterm internally only for terminal-protocol
replies. Use it only if a line-oriented panel is acceptable; do not use it for
the screenshot requirement.

> **Current scaffold**: `packages/dsh-terminal-panel/lib/index.js` and
> `lib/client.js` already prove the right-sidebar tab path and the
> `ctx.connection.admit(req)` auth pattern. This blueprint keeps those
> contracts but recommends moving the panel to `shell.bottom` and replacing the
> hand-written client bundle with the build in §9. The existing
> `packages/dsh-terminal-panel/package.json` lacks a real `tools/build-client.mjs`;
> §9 supplies one.

---

## 1. Environment facts (verified)

| Fact | Value / evidence |
|---|---|
| DSH Desktop version | `0.2.1-rc.2` (`D:\DSH\resources\runtime\cli\bin\dsh.cmd --version` → `0.2.1-rc.2`) |
| Web GUI | `http://127.0.0.1:58966` (runtime context) |
| Desktop app.asar | `D:\DSH\resources\app.asar`, tree/listing at `%TEMP%\dsh-asar-tree.json`, `%TEMP%\dsh-asar-files.json` |
| Curated official packages | `%TEMP%\dsh-sdk\pkg\` (includes `dsh-tools`, `dsh-terminal`, `dsh-terminal-bash`, `dsh-tool-terminal`, `dsh-api-terminal-controller`, `dsh-client-ui-sidebar-terminal`, `dsh-client-ui-sidebar-right`, `dsh-web-app`, `dsh-base`, `dsh-hmr`, ...) |
| Real third-party examples | `C:\Users\LANCANG\.dsh\profiles\desktop\node_modules\dsh-better-display\` (full TS + tsdown), `dsh-context\` (built host/client), `dshmarket\` |
| Active profile | `C:\Users\LANCANG\.dsh\profiles\desktop\` — `package.json`, `cordis.patch.yml`, `pnpm-workspace.yaml` |
| React | **18.x** — official packages declare `react ^18.2.0`, `react-dom ^18.2.0` (e.g. `dsh-client-ui-sidebar-terminal/package.json`, `dsh-better-display/package.json`); the shell seeds one React instance. Do not bundle React. |
| xterm (browser) | `@xterm/xterm ^6.0.0`, `@xterm/addon-fit ^0.11.0` (`dsh-client-ui-sidebar-terminal/package.json:63-64`); npm versions 6.0.0 / 0.11.0 exist |
| xterm (host) | `@xterm/headless 6.0.0`, `@xterm/addon-serialize 0.14.0` (`%TEMP%\dsh-sdk\pkg\@xterm__headless\package.json`, `...\@xterm__addon-serialize\package.json`; loaded lazily by the official terminal controller) |
| node-pty | `1.2.0-beta.15`, prebuilt Windows assets in `app.asar` at `/dsh/node_modules/node-pty/prebuilds/win32-x64/conpty/` (`conpty.node`, `conpty.dll`, `OpenConsole.exe`); the local subprocess provider spawns with `useConptyDll: true` |
| Bundler in DSH install | none. `esbuild`, `lightningcss`, `tsdown` are **not** in `app.asar`; install them as devDependencies of the plugin. |
| npm access | verified: `npm view @deepseek-ai/dsh-tools@0.2.1-rc.2 dist.tarball` and `npm view @xterm/xterm@6.0.0 version` succeed |

Host-side xterm is also present in the asar at
`/dsh/node_modules/@xterm/headless` and `/dsh/node_modules/@xterm/addon-serialize`
(the official terminal controller lazy-requires them). Both are pure JS and
publish the same versions on npm, so the plugin can declare them as normal
dependencies. The **browser** `@xterm/xterm` is *not* a separate asar package;
it is bundled inside `dsh-client-ui-sidebar-terminal/lib/client.terminal.js`,
so a custom panel must install `@xterm/xterm` + `@xterm/addon-fit` from npm and
bundle them.

The environment’s file policy is `danger-full-access` for this research
session, but the deliverable constraints are: **read-only on `D:\DSH` and
`C:\Users\LANCANG\.dsh`; write only under
`C:\Users\LANCANG\Desktop\Code\DSH Plugs\dsh-live-terminal\docs\`** (plus research temp
artifacts). Nothing in this document requires editing DSH itself.

---

## 2. Recommended architecture

```
┌──────────────────────────────── Browser (DSH Web GUI) ───────────────────────────────┐
│  shell.bottom slot (single, root scope)                                              │
│  ┌──────────────────────────────────────────────────────────────────────────────┐    │
│  │ TerminalDock (React)                                                          │    │
│  │  header: status, session picker, fit/clear/close                              │    │
│  │  @xterm/xterm 6 + FitAddon  ── POST /dsh-terminal-panel/input ───────────┐    │    │
│  │       ▲                                                                  │    │    │
│  │       │ EventSource /dsh-terminal-panel/events (snapshot + output)       │    │    │
│  └───────┼──────────────────────────────────────────────────────────────────┼────┘    │
│          │                                                                  │         │
│  shell.overlay toggle (only when dock closed)                               │         │
└──────────┼──────────────────────────────────────────────────────────────────┼─────────┘
           │ same-origin HttpOnly cookie; connection.admit(req)                │
┌──────────▼──────────────────────────── Host (Cordis) ───────────────────────▼─────────┐
│  dsh-terminal-panel host plugin                                                     │
│   ├─ LiveTerminalRegistry (per Agent.id / SessionId)                                │
│   │    └─ LiveTerminal                                                              │
│   │         ├─ ctx.subprocess.spawnTerminal(...)  (node-pty + ConPTY, sandboxed)     │
│   │         ├─ @xterm/headless Terminal + SerializeAddon  (screen mirror)            │
│   │         ├─ ordered write/output queue, SSE client fan-out                        │
│   │         └─ screenText() / serializeScreen() / png()                             │
│   ├─ routes: /dsh-terminal-panel/events (SSE), /input (POST), /sessions (GET), ...   │
│   ├─ tools: live_terminal_open / run / send / screenshot                            │
│   ├─ systemPrompt.section("tool:live-terminal", order TOOL_PTY)                      │
│   └─ skills.register("live-terminal", ...)                                          │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**Design rules**

1. **One PTY per Agent (session) is the single source of truth.** Both the UI
   and the Agent tools write to / read from the same `LiveTerminal` object.
   The UI is not a separate process and does not need to “take over”.
2. **Every write is serialized** through one promise chain (`write`, `resize`,
   tool run, UI keystroke) so ANSI output and xterm state cannot interleave.
3. **Output is consumed once**: `handle.output` → UTF-8 streaming decoder →
   `screen.write(data, cb)` → after the headless terminal has processed it,
   bump `seq` and broadcast. A snapshot is therefore always consistent with
   the sequence it advertises.
4. **The bottom panel is the primary surface**, because it is designed for
   full-width, persistent content below the three columns and remains mounted
   across main-panel navigation:
   `dsh-client-ui-layout/lib/types/client/index.d.ts:75-84` documents
   `'shell.bottom'` as `kind: 'single', scope: 'root'`, “occupant controls its
   own height and visibility; empty content reserves no space”.
5. **Fall back to `shell.overlay`** (a root-scoped list, click-through until an
   entry opts in) if `shell.bottom` is already occupied by another plugin. The
   toggle button lives there when the dock is closed.
6. **Do not use the private `modules.importChunk()` API.** It exists at runtime
   and `dsh-terminal-button` uses it, but it is `private importChunk` in
   `dsh-client-modules/lib/types/client/system.d.ts:68`. For lazy loading in
   your own package use `require.async("./client.terminal.js")`, which is the
   documented factory contract (`ClientBundleRequire.async`,
   `dsh-client-modules/lib/types/client/manifest.d.ts:187-193`).

### 2.1 Prior art in this workspace (why build this plugin)

`research/existing-plugins.md` evaluated the ecosystem before this blueprint:

- The official right-sidebar terminal already satisfies **A** (interactive
  xterm + real PTY) but is excluded from the Agent transcript by design
  (`dsh-client-ui-sidebar-terminal/README.md`, “Known Limitations”). It cannot
  satisfy B/C.
- `@hyzyn/dsh-tty` 0.32.3 is the closest existing A+B+C(text) plugin: own PTY
  via `spawnTerminal`, xterm panel, 19 tools, `tty_screen` text capture
  (`research/existing-plugins.md:119-155`). It does **not** produce an image,
  injects its sidebar entry by DOM mutation, and reaches into DSH’s node-pty
  handle internals on Windows — not a stable base.
- `dsh-terminal-button` 0.4.3 proves the “reuse the official TerminalBody in a
  bottom/other surface” path, but it is still a **user** terminal, not an Agent
  bridge (`research/existing-plugins.md:175-182`).
- No plugin provides a terminal-buffer image screenshot; the existing
  screenshot plugins capture a monitor/window, not a terminal by id
  (`research/existing-plugins.md:191-212`).

The design above is deliberately smaller than `dsh-tty` (four tools, one
bottom panel, no SSH/SFTP/tunnel surface) and uses only public services plus
the documented client bundle format. The riskiest private-API dependencies in
the ecosystem (DOM injection, `modules.importChunk`, node-pty internals) are
avoided.

---

## 3. Plugin package contract

### 3.1 Package layout

```
packages/dsh-terminal-panel/
  package.json                 # dual-face manifest, dsh.bundle + dsh.client
  cordis.patch.yml             # bundle layer: inserts the host row
  tsconfig.host.json           # host TS -> lib/*.js + lib/types/*.d.ts
  tsconfig.client.json         # client TSX typecheck (noEmit)
  scripts/build-client.mjs     # esbuild + lightningcss -> lib/client.js
  src/
    index.ts                   # host plugin entry (name/inject/Config/apply)
    live-terminal.ts           # LiveTerminal + LiveTerminalRegistry
    routes.ts                  # SSE / input / sessions HTTP surface
    tools.ts                   # four defineTool definitions
    skill.ts                   # ctx.skills.register(...)
    png.ts                     # optional SVG -> PNG via sharp
    protocol.ts                # shared wire types (host + client)
    client/
      index.tsx                # client plugin entry (exports apply/inject)
      TerminalDock.tsx         # xterm panel in shell.bottom
      TerminalToggle.tsx       # shell.overlay toggle when closed
      panel-store.ts           # defineStore handle
      styles.module.css        # optional CSS modules
  lib/                         # build output (checked in for link: installs)
  README.md
```

### 3.2 `package.json` template

```json
{
  "name": "dsh-terminal-panel",
  "version": "0.1.0",
  "description": "Visible terminal panel for DeepSeek Harness: agent commands stream into an in-app xterm and the agent can screenshot the screen.",
  "type": "module",
  "license": "MIT",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    },
    "./client": {
      "default": "./lib/client.js"
    },
    "./package.json": "./package.json"
  },
  "files": [
    "lib",
    "cordis.patch.yml",
    "README.md"
  ],
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-session",
        "@deepseek-ai/dsh-client-ui-conversation"
      ]
    }
  },
  "engines": {
    "dsh": "0.2.1-rc.2",
    "node": "^22.19.0 || >=24.0.0"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.0.5",
    "@deepseek-ai/schemastery": "~3.18.5",
    "@deepseek-ai/dsh-tools": "0.2.1-rc.2"
  },
  "dependencies": {
    "@xterm/headless": "6.0.0",
    "@xterm/addon-serialize": "0.14.0"
  },
  "devDependencies": {
    "@types/node": "^22.20.0",
    "@types/react": "~18.3.1",
    "@xterm/addon-fit": "0.11.0",
    "@xterm/xterm": "6.0.0",
    "esbuild": "^0.25.10",
    "lightningcss": "^1.33.0",
    "typescript": "^5.9.3"
  }
}
```

> **Do not put `@deepseek-ai/dsh-*` in `devDependencies` of the linked
> package.** npm installs devDependencies, and Node will then resolve the
> plugin’s runtime `import '@deepseek-ai/dsh-tools'` to that local copy instead
> of the Host’s copy — the duplicate-host-package failure mode. Type
> declarations for typecheck belong in a separate, non-ancestor
> `tools/typecheck` project (see §9.6). The `@xterm/*` entries are different:
> they are bundled/host-local and intentionally installed.

Notes / rationale:

- `dsh.bundle.patch` marks the package as a **bundle**: the profile launcher
  reads `dsh.profile.bundles`, applies each bundle’s patch, then the profile
  patch (`dsh-app-boot/lib/index.js:499-503`, `551-570`).
- `dsh.client.platform: "web"` + an `exports "./client"` target is the entire
  client-plugin declaration. The Node half of `dsh-client-modules` scans Loader
  entries, reads `package.json`, and rejects a `dsh.client` package without an
  `exports "./client"` (`dsh-client-modules/lib/index.js:720-746`).
- `dsh.client.inject` is **module arrival ordering**, not Cordis service
  injection (the manifest type explicitly says “Informational package-name
  dependencies, not Cordis service injection”,
  `dsh-package-manifest/lib/types/types.d.ts:75-89`). It is consumed by
  `arriveGraphRow()` before loading this row
  (`dsh-client-modules/lib/client.js:776-793`). The **Cordis** services are
  declared by the client module’s own `export const inject = [...]`.
- Keep `@deepseek-ai/*` host packages as **dev/peer**, never `dependencies`.
  A second `@deepseek-ai/dsh-tools` under the profile is a known way to break
  every tool call; see the prior research note
  `research/existing-plugins.md:239`.
- `engines.dsh` exact `0.2.1-rc.2` is the safest local-dev value. Plugin Manager
  compares it to the running runtime version; an exact match needs no
  exemption (`dsh-plugin-manager/README.md`, “Version compatibility”).
  Widen only after testing.
- `@xterm/headless` and `@xterm/addon-serialize` are plain JS; declaring them
  as direct dependencies prevents relying on the installation’s copy and
  avoids a version skew with a future DSH. They are loaded lazily in the host
  (`createRequire`) so they cost nothing until a terminal opens.
- Browser xterm and FitAddon are bundled into `lib/client.js` (they are not in
  the shell’s shared module table). This is what the official sidebar terminal
  does too (its lazy `lib/client.terminal.js` is ~686 KB because it contains
  xterm).

### 3.3 `cordis.patch.yml`

```yaml
# Bundle layer inserted into the profile's ordered patch stack.
# `name` resolves from the profile's node_modules first, then from the DSH
# installation (dsh-app-boot/lib/index.js:499-503).
- insert:
    - id: dsh-terminal-panel
      name: dsh-terminal-panel
```

This is exactly the pattern used by real plugins:
`dsh-better-display/cordis.patch.yml` (`insert` one row whose `name` is the
package) and `dsh-context/cordis.patch.yml`. If you need config, add:

```yaml
      config:
        cols: 120
        rows: 30
        idleMs: 350
```

A patch replaces the targeted row’s whole `config` (`dsh-web-app/README.md`,
“Patch semantics”), so restate every key you want to keep when overriding a
default at the profile layer.

### 3.4 How the two halves are loaded

**Host half**

- The Loader entry is the row inserted by the patch. Its `name` is resolved by
  the profile runtime: installation packages first, then the profile directory
  (`dsh-app-boot/lib/index.js:499-503`). The runtime resolution is an in-memory
  router for Node ESM/CJS; a plugin’s bare imports of `@deepseek-ai/*` resolve
  to the installation copies even though the profile has no `@deepseek-ai`
  directory (`dsh-app-boot/lib/worker/profile-resolution-bootstrap.js`,
  `collectInstallationScopePackages` at `dsh-app-boot/lib/index.js:715-760`).
- Cordis imports the package’s `main`/`exports "."`. The module namespace is
  the plugin: `export const name`, `export const inject`, `export function
  apply(ctx, config)`, optional `export const Config`.
  `dsh-tool-terminal` is the compact reference:
  `export { Config, apply, inject, name }` (`dsh-tool-terminal/lib/index.js:645-651`).
- HMR replaces the module when the linked package’s built files change at a
  profile recomposition (`dsh-hmr/README.md`, “Profile recomposition”). It does
  not watch arbitrary source files by default (`root: []`).

**Client half**

- The client module loader is the shell-owned `window.__ModuleLoader__`
  bootstrap. Each plugin bundle is a classic script that only registers a
  factory; module side effects (including CSS injection) run at materialization.
  See `dsh-client-modules/README.md`, “Lazy-CJS model”.
- Bundle wrapper (this is the exact format the official bundles use):

```js
window.__ModuleLoader__.load({
  id: "dsh-terminal-panel",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    // ... bundled CommonJS body; may call require("react") etc.
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
```

  The official sidebar terminal’s `lib/client.js:1-10` and lazy chunk
  `lib/client.terminal.js:1-6` show the same wrapper; a lazy chunk adds
  `chunk: "client.terminal.js"`.
- The factory’s `require` resolves only:
  1. the **platform seed table** (shell singletons),
  2. already-materialized records,
  3. boot-graph rows (other plugin packages),
  4. registered factories,
  and throws otherwise (`dsh-client-modules/lib/client.js:783-840`).
- The platform seed table is created by the shell in
  `dsh-web-frontend/dist/assets/index-CN7NIWNw.js` (symbol `SZ()` near the
  `__ModuleLoader__` boot code, minified line 190) and contains exactly:

  ```text
  react
  react/jsx-runtime
  react-dom
  react-dom/client
  @deepseek-ai/cordis
  zod
  @tanstack/react-virtual
  @deepseek-ai/dsh-client-store
  @deepseek-ai/dsh-client-ui-slots
  @deepseek-ai/dsh-client-ui-primitives
  @deepseek-ai/dsh-client-ui-dockkit
  ```

  `dsh.client.external` may add only **exact non-baseline** requests, each
  answered by a dynamic package row it names or an exact static-table key;
  self-requests and synchronous cycles are rejected
  (`dsh-client-modules/lib/index.js:402-446`, README “Sharing modules”).
- A package-local lazy chunk must be **self-contained**; entry and chunk output
  cannot synchronously require another relative `client*.js` output
  (`dsh-client-modules/README.md`, “Build requirements”). Use
  `require.async("./client.terminal.js")` for the chunk, not a static import.
- The host serves `/plugins/<package>/client.js` and
  `/plugins/<package>/client.<name>.js?rev=...`; the browser module graph
  follows HMR over `/plugins/events` (`dsh-client-modules/README.md`,
  “Incremental composition”).
- A missing `lib/client.js` fails activation loudly; there is no on-the-fly
  TypeScript build in the Web host. Prebuild it.

### 3.5 `dsh.client` versus `exports.inject`

Keep the two `inject` lists distinct:

| Field | Meaning | Example for this plugin |
|---|---|---|
| `package.json.dsh.client.inject` | Client **module rows** loaded before this bundle (ordering only) | `["@deepseek-ai/dsh-client-ui-layout", "@deepseek-ai/dsh-client-ui-session", "@deepseek-ai/dsh-client-ui-conversation"]` |
| `lib/client.js` `export const inject` | **Cordis services** this client fiber requires | `["slots"]` (add `"locale"`, `"shortcuts"`, `"theme"` only if used) |

Do not put `slots` in `dsh.client.inject`; it is a Cordis service, not a
package row. Do not put a package name in `exports.inject`; Cordis would wait
for a service with that name.

### 3.6 Host/client wire types

Keep a shared `src/protocol.ts` with type-only payloads:

```ts
export type TerminalId = string

export interface TerminalInfo {
  id: TerminalId
  sessionId: string
  title: string
  cols: number
  rows: number
  state: 'running' | 'exited' | 'failed'
  exitCode?: number | null
  owner: 'agent' | 'user'
}

export type ServerEvent =
  | { type: 'snapshot'; terminal: TerminalInfo; seq: number; ansi: string }
  | { type: 'output'; terminalId: TerminalId; seq: number; data: string }
  | { type: 'state'; terminal: TerminalInfo; activity?: string }
  | { type: 'error'; message: string }

export type InputCommand =
  | { type: 'write'; terminalId?: TerminalId; data: string }
  | { type: 'resize'; terminalId?: TerminalId; cols: number; rows: number }
  | { type: 'open'; cwd?: string; cols?: number; rows?: number }
  | { type: 'close'; terminalId: TerminalId }
```

The client bundle only needs the types (erased); the host validates incoming
JSON at runtime.

---

## 4. Client UI extension points

### 4.1 Slot system in one page

- `ctx.slots.register(options, Component)` contributes a component to a slot
  declared by another registration. Declaring a child slot is also the render
  authority (`dsh-client-ui-slots/lib/types/index.d.ts:156-164`,
  `dsh-client-ui-renderer/lib/types/client/registry.d.ts:85`).
- Slot kinds: `single` (one occupant per cell; shadowing by priority),
  `list` (`id`, `order`, `label`), `keyed` (`key`), `chain` (`select`).
  Scopes: `root`, `session-maybe`, `session`
  (`dsh-client-ui-slots/lib/types/index.d.ts:82-85`).
- `ctx.slots.inject(key, callback)` waits for the declaration and re-runs it if
  the slot is redeclared; use this instead of registering blindly
  (`registry.d.ts:96-111`).
- Components receive `PropsRuntime<Key>` (owner props, standard session/global
  hooks, slot-level inject face), `PropsRenderSlots<children>`, `useStore`,
  `actions` if a store seat is declared, and `t` if `locale` is declared
  (`dsh-client-ui-slots/lib/types/index.d.ts:226, 478, 601-617`).
- Global standard props include `useSessions`, `useSessionStatus`,
  `useSessionRetainInfo`, `useSessionAccess`
  (`dsh-client-ui-session/lib/types/client/index.d.ts:68-79`). Root slots get
  these without a session binding; `useSessions` is the session list, **not**
  the selected id. For v1 key the panel by “active terminal id” rather than by
  the selected session.

### 4.2 Recommended: bottom panel (`shell.bottom`)

`dsh-client-ui-layout` declares the seat in
`lib/types/client/index.d.ts:75-84`:

```ts
'shell.bottom': {
  kind: 'single';
  scope: 'root';
};
```

and renders it below all three columns (`lib/client.js:347`), while
`shell.overlay` is a click-through list above everything
(`lib/client.js:313`, declarations at `lib/client.js:639-648`).

Minimal client entry:

```ts
// src/client/panel-store.ts
import { defineStore } from '@deepseek-ai/dsh-client-store'

// Factory, not a module-level handle: dsh-client-store explicitly warns that a
// module-level handle is a disguised singleton across plugin reloads
// (dsh-client-store/lib/types/contract.d.ts:73-79).
export function createPanelStore() {
  return defineStore({
    init: () => ({ open: false, height: 320 }),
    persist: 'dsh.terminal-panel.panel.v1',
    actions: {
      show(d) { d.open = true },
      hide(d) { d.open = false },
      toggle(d) { d.open = !d.open },
      setHeight(d, px: number) { d.height = Math.max(160, Math.min(900, Math.round(px))) },
    },
  })
}

export type PanelStore = ReturnType<typeof createPanelStore>
```

```tsx
// src/client/index.tsx
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createPanelStore } from './panel-store.js'
import { TerminalDock } from './TerminalDock.js'
import { TerminalToggle } from './TerminalToggle.js'

export const name = 'dsh-terminal-panel-client'
export const inject = ['slots']

export function apply(ctx: Context): void {
  const panelStore = createPanelStore()

  // Primary seat: full-width bottom dock.
  ctx.slots.inject('shell.bottom', () => ctx.slots.register({
    name: 'shell.bottom',
    store: panelStore,
  }, TerminalDock))

  // Fallback / reopen affordance: a floating pill when the dock is closed.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-terminal-panel.toggle',
    order: 900,
    store: panelStore,
  }, TerminalToggle))
}
```

Why this works:

- Both registrations use **one shared store handle** in the same `root` scope;
  the slot runtime caches one instance per handle × scope, which is the
  supported pattern for “one handle across two same-scope seats”
  (`dsh-client-ui-sidebar-right/README.md`, “The expand button”).
- `shell.bottom` is `single`: if another plugin already occupies it, the
  registration throws at the occupied cell’s priority. Guard with
  `ctx.slots.spec('shell.bottom')` / `ctx.slots.entries('shell.bottom')` and
  fall back to a floating `shell.overlay` window. Document this in the README.
- The dock component may return a zero-height element when closed
  (`display: none` / `height: 0`), or render `null`; “empty content reserves no
  space” is the layout contract. If you want xterm to stay warm while hidden,
  keep the element mounted with `display: none` rather than unmounting.
- `shell.bottom` remains mounted across main-panel navigation, so the SSE
  connection and xterm buffer survive switching to Settings/Plugins.

### 4.3 Alternative: right-sidebar tab (what the current scaffold does)

This is the officially supported multi-tab terminal surface. Register a tab
type and its body/title seats exactly as the official terminal does
(`dsh-client-ui-sidebar-terminal/lib/client.js:438-490`):

```tsx
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

ctx.effect(() => ctx.sidebarRightTabs.register({
  id: 'dsh-terminal-panel',
  kind: 'terminal-panel',
  multiple: true,
  priority: 'extension',
  title: () => t('title'),
  guide: [{
    id: 'open',
    order: 30,
    title: () => t('title'),
    description: () => t('guideDescription'),
  }],
}), 'dsh-terminal-panel: tab type')

ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
  name: 'sidebar.right.pane.tab',
  key: 'dsh-terminal-panel',
  locale: 'dshTerminalPanel',
  inject: (sessionId) => ({ sessionId }),
}, PanelBody)), 'dsh-terminal-panel: body')
```

Then open it with `ctx.sidebarRight.openTab('terminal-panel', { params })`
(`dsh-client-ui-sidebar-right/lib/types/client/service.d.ts:168`), which also
expands the column. The body slot receives `useTabInfo()` with
`{ sidebar, panel, tab }`; `tab.actions.openTab/openResource/close` are bound to
the tab occurrence (`.../contract/slots.d.ts:113-203`).

Trade-offs versus the bottom dock:

| Surface | Best for | Weakness |
|---|---|---|
| `shell.bottom` | Watching agent progress while chatting; always visible; survives navigation | Single occupant; global (no per-session tab); must handle its own height |
| right sidebar tab | Multiple terminals, per-session tabs, float/fullscreen, official UX | Hidden when the column is collapsed; user must open it; tab body remount semantics |
| `shell.overlay` | A draggable floating window, status pill, or reopen affordance | Click-through layer; you own pointer-events, drag, z-order; not a dock |

### 4.4 Floating / overlay panel

`shell.overlay` is the additive seat for a frame-wide surface; the layer is
click-through and each entry opts into pointer events
(`dsh-client-ui-layout/lib/types/client/index.d.ts:85-98`). A floating terminal
is just:

```tsx
ctx.slots.inject('shell.overlay', () => ctx.slots.register({
  name: 'shell.overlay',
  id: 'dsh-terminal-panel.float',
  order: 900,
  store: panelStore,
}, FloatingTerminal))
```

`FloatingTerminal` renders a fixed-position panel with `pointerEvents: 'auto'`,
its own drag/resize handlers, and the same xterm/SSE child as the dock. This is
a good secondary mode, but it duplicates the dock’s layout code; ship the dock
first and add the float only if users ask.

For a dockkit-managed float of a **right-sidebar** tab, use
`ctx.sidebarRight.float(tabId, rect)`
(`dsh-client-ui-sidebar-right/lib/types/client/service.d.ts:200-205`). That
only applies to tabs in the right sidebar, not to the bottom dock.

### 4.5 Toggle / command surface

Provide three ways to open the panel:

1. **Auto-open on Agent activity** — the SSE `state` event carries
   `activity: 'tool'`; the dock calls `actions.show()`.
2. **Floating toggle** — the `shell.overlay` pill (above) when closed.
3. **Keyboard shortcut** — optional; register through `ctx.shortcuts` (the
   official terminal uses `terminal.new` with `Backquote + Ctrl` on Windows,
   `dsh-client-ui-sidebar-terminal/lib/client.js:388-433`). Shortcut
   registration requires the `shortcuts` service; add it to `inject` only if
   you implement this.

Do not inject a button into `conversation.session.header.actions` unless you
need a per-session placement; that seat is session-scoped and adds coupling for
little benefit.

### 4.6 The xterm component

```tsx
// src/client/TerminalDock.tsx (sketch)
import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ServerEvent } from '../protocol.js'
import type { PanelStore } from './panel-store.js'

type Props = PropsRuntime<'shell.bottom'> & PropsStore<PanelStore>

export function TerminalDock({ useStore, actions }: Props) {
  const open = useStore(s => s.open)
  const height = useStore(s => s.height)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const terminalIdRef = useRef<string | undefined>(undefined)
  const readyRef = useRef(false)
  const pendingRef = useRef<string[]>([])

  // 1) xterm instance, once.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      cols: 120,
      rows: 30,
      scrollback: 1000,
      allowProposedApi: true,
      fontFamily: "Consolas, 'Cascadia Mono', 'Courier New', monospace",
      fontSize: 13,
      theme: { background: '#111318', foreground: '#e6e6e6', cursor: '#e6e6e6' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    fitRef.current = fit

    const dataSub = term.onData(data => {
      void postInput({ type: 'write', terminalId: terminalIdRef.current, data })
    })
    const resizeSub = term.onResize(({ cols, rows }) => {
      void postInput({ type: 'resize', terminalId: terminalIdRef.current, cols, rows })
    })
    return () => {
      dataSub.dispose()
      resizeSub.dispose()
      term.dispose()
      termRef.current = null
    }
  }, [])

  // 2) SSE: snapshot then deltas. Keep reconnecting EventSource.
  useEffect(() => {
    const es = new EventSource('/dsh-terminal-panel/events')
    const onSnapshot = (e: MessageEvent) => {
      const data = JSON.parse(e.data) as Extract<ServerEvent, { type: 'snapshot' }>
      terminalIdRef.current = data.terminal.id
      readyRef.current = false
      pendingRef.current.length = 0
      const term = termRef.current
      if (!term) return
      term.reset()
      term.write(data.ansi, () => {
        readyRef.current = true
        for (const chunk of pendingRef.current.splice(0)) term.write(chunk)
      })
    }
    const onOutput = (e: MessageEvent) => {
      const data = JSON.parse(e.data) as Extract<ServerEvent, { type: 'output' }>
      if (data.terminalId !== terminalIdRef.current) return
      const term = termRef.current
      if (!term) return
      if (!readyRef.current) pendingRef.current.push(data.data)
      else term.write(data.data)
    }
    const onState = (e: MessageEvent) => {
      const data = JSON.parse(e.data) as Extract<ServerEvent, { type: 'state' }>
      terminalIdRef.current = data.terminal.id
      if (data.activity === 'tool') actions.show()
    }
    es.addEventListener('snapshot', onSnapshot as EventListener)
    es.addEventListener('output', onOutput as EventListener)
    es.addEventListener('state', onState as EventListener)
    return () => es.close()
  }, [actions])

  // 3) Fit when the dock becomes visible (a hidden element measures 0×0).
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      fitRef.current?.fit()
      termRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [open])

  return (
    <div
      style={{ display: open ? 'flex' : 'none', height, flexDirection: 'column' }}
      data-dsh-terminal-panel="dock"
    >
      <div style={{ display: 'flex', gap: 8, padding: '4px 8px' }}>
        <strong style={{ flex: 1 }}>Live terminal</strong>
        <button onClick={() => actions.hide()}>Hide</button>
      </div>
      <div ref={hostRef} style={{ flex: 1, minHeight: 0 }} />
    </div>
  )
}

async function postInput(command: unknown): Promise<void> {
  try {
    await fetch('/dsh-terminal-panel/input', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
    })
  } catch {
    // The SSE reconnect / status line owns user-visible errors.
  }
}
```

Implementation notes:

- The `/dsh-terminal-panel/events` and `/input` paths are absolute. This is
  correct when the GUI is served at the origin root (the normal Desktop/Web
  case). Behind a prefix-stripping proxy, absolute paths work because the proxy
  strips the prefix; behind a non-stripping sub-path mount they do not. DSH’s
  own bundle references are document-relative (`plugins/...`), but custom
  routes are absolute in `ctx.webServer.register`. Document the deployment
  assumption.
- `EventSource` sends the same-origin HttpOnly session cookie automatically.
  Do **not** put the launch token in the SSE URL; the token is only accepted by
  the root exchange `/` (or `/connect` for API peers), and is exchanged for a
  signed cookie.
- If the dock is hidden with `display:none`, the xterm instance still processes
  output; only `fit()` must be deferred until visible.
- The theme colors above are a fallback. For a production panel, read the DSH
  theme tokens (the official terminal uses `ctx.theme` snapshots and
  `--dsw-alias-*` / `--dsh-terminal-font-size`); see
  `dsh-client-ui-sidebar-terminal/README.md` “Use this package”.
- A `ResizeObserver` on the host element is a good addition; call `fit()` and
  let `onResize` POST the new dimensions. Debounce ~100 ms.
- Do not render the terminal in a slot that unmounts on every session switch if
  you want the process and screen to survive; `shell.bottom` does not.

---

## 5. Host ↔ client communication

### 5.1 Options

| Option | How | Auth | Verdict |
|---|---|---|---|
| **SSE + POST over `ctx.webServer.register`** | `GET /…/events` holds the response open; `POST /…/input` sends keys/resizes; `GET /…/sessions` lists terminals | Your handler calls `ctx.connection.admit(req)`; same-origin cookie; Host/Origin fence | **Recommended.** Simple, robust, no new runtime dependency, works in Desktop/Web |
| WebSocket via `ctx.webServer.registerUpgrade` | Raw `(req, socket, head)`; use `ws` if you need binary framing | `ctx.connection.admit(req)` before upgrade; optionally `admitConnection()` for API-socket ownership | Fine for high-rate bidirectional use, but adds `ws` and upgrade lifecycle; not needed for terminal text |
| Typert Remote (`ctx.remote.*`) | Generated `@Remote` service + descriptors + client codecs | Gateway Peer + Connection admission | **Avoid for a third-party plugin**: requires generated `typert.host.js` / `typert.remote-client.js` artifacts and strict codecs; the official terminal controller ships ~90 KB generated host descriptors |
| Official `webTerminals` / `remote.terminal` | Client-side service only | Gateway | Cannot drive from a Host tool; `attach()` needs `ctx.invocation` |

`ctx.webServer` registers exact/prefix HTTP routes and exact upgrade routes:
`WebRoute { kind, path, handler(req,res) }` and
`WebUpgradeRoute { path, handler(req,socket,head) }`
(`dsh-host-webserver/lib/types/index.d.ts:31-46`). The handler owns the full
response lifecycle and may hold the response open, explicitly including SSE.
Compression skips SSE (`dsh-host-webserver/README.md`, “Minimal configuration”).

### 5.2 Authentication / browser trust

Custom routes are **not** automatically protected. The `/api` bridge calls
`ctx.connection.admit(req)` itself
(`dsh-client-connection/lib/index.js:1049-1058`); your handler must do the same.
`admit(request)` returns either `{ peer }` or `{ rejection: 401 | 403 }`
(`dsh-client-connection/lib/types/rpc.d.ts:93-98`), and internally applies:

1. the browser-trust fence (loopback / listener bind IP / `trustedHosts`,
   `Origin`, `Sec-Fetch-Site`), then
2. the signed browser cookie or an API-session cookie.

The cookie is minted by the launch-token exchange at `GET /` (or `/connect`
for API peers), is host-only, `Path=/`, `HttpOnly`, `SameSite=Strict`, and is
`Secure` exactly when the listener serves TLS
(`dsh-client-connection/README.md`, “Browser authentication and request
trust”). That is why an `EventSource` / `fetch(..., { credentials:
'same-origin' })` from the GUI works without any token handling.

```ts
// src/routes.ts (auth helper)
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'

export function authorize(
  connection: { admit(req: IncomingMessage): { peer: unknown } | { rejection: 401 | 403 } },
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const admission = connection.admit(req)
  if ('rejection' in admission) {
    res.writeHead(admission.rejection)
    res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
    return false
  }
  return true
}
```

An `EventSource` request is a normal same-origin GET with cookies; the fence
accepts it because `Host` names the listener and `Sec-Fetch-Site` is
`same-origin`. If the page is opened through a proxy, the proxy authority must
be in `trustedHosts` (`dsh-web-app --trusted-host`) and the cookie must have
been minted for that authority. Do not accept `?token=` on the SSE route.

### 5.3 SSE route + hub

```ts
// src/routes.ts (SSE)
import type { ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'

export function registerEventRoute(ctx: Context, live: LiveTerminalRegistry): void {
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/dsh-terminal-panel/events',
      handler: async (req, res) => {
        if (!authorize(webCtx.connection, req, res)) return
        const url = new URL(req.url ?? '/', 'http://dsh.invalid')
        const wanted = url.searchParams.get('terminal') ?? undefined
        const client = new SseClient(res)
        const terminal = live.pick(wanted)
        if (terminal) {
          // Atomic: register the client and send the snapshot in one queued step.
          await terminal.attach(client)
          client.send({ type: 'state', terminal: terminal.info })
        }
        const heartbeat = setInterval(() => client.comment('ping'), 20_000)
        const cleanup = () => {
          clearInterval(heartbeat)
          terminal?.detach(client)
          client.close()
        }
        req.once('close', cleanup)
        res.once('close', cleanup)
      },
    }), 'dsh-terminal-panel: events')
  })
}
```

`SseClient` is deliberately boring:

```ts
class SseClient {
  private queue: string[] = []
  private bytes = 0
  private closed = false
  private draining = false

  constructor(private readonly res: ServerResponse) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders?.()
    res.write('retry: 1000\n\n')
  }

  send(event: ServerEvent): void {
    if (this.closed) return
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
    this.bytes += Buffer.byteLength(frame)
    this.queue.push(frame)
    // 4 MiB per follower, mirroring the official terminal's bounded follower.
    if (this.bytes > 4 * 1024 * 1024) {
      this.close()
      return
    }
    this.drain()
  }

  comment(text: string): void {
    if (!this.closed) this.res.write(`: ${text}\n\n`)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.queue.length = 0
    this.bytes = 0
    try { this.res.end() } catch { /* already gone */ }
  }

  private drain(): void {
    if (this.draining) return
    this.draining = true
    while (!this.closed && this.queue.length > 0) {
      const frame = this.queue.shift()!
      this.bytes -= Buffer.byteLength(frame)
      if (!this.res.write(frame)) {
        this.res.once('drain', () => {
          this.draining = false
          this.drain()
        })
        return
      }
    }
    this.draining = false
  }
}
```

Notes:

- Use **named SSE events** (`event: snapshot|output|state|error`) rather than
  a single `message`; the client can attach dedicated listeners.
- Send a `snapshot` first, then deltas. The snapshot carries `seq`; the client
  discards any delta until the snapshot write callback has completed.
- A slow follower is dropped at the byte cap; EventSource reconnects and gets a
  fresh snapshot. This is the same “slow followers fail explicitly” policy the
  official terminal uses (`dsh-api-terminal-controller/lib/types/stream.js`).
- **Snapshot and attach must be atomic** with respect to output: if you send a
  snapshot, then `attach(client)`, a chunk produced between those two steps is
  lost. Implement `terminal.attach(client)` as one queued operation that
  registers the client and returns/sends the snapshot under the same
  `enqueue()` chain (the official `BrowserTerminal.attach` does this inside one
  `enqueue`).
- `req.once('close')` and `res.once('close')` both fire in different Node paths;
  make `cleanup` idempotent.
- Do not set `Content-Length`; do not let the web server’s gzip wrapper touch
  the stream (SSE is excluded, but `no-transform` is belt-and-braces).

### 5.4 Input route

```ts
// src/routes.ts (input)
webCtx.effect(() => webCtx.webServer.register({
  kind: 'exact',
  path: '/dsh-terminal-panel/input',
  handler: async (req, res) => {
    if (!authorize(webCtx.connection, req, res)) return
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    const body = await readJsonBody(req, 64 * 1024)
    if (body === undefined) { res.writeHead(400); res.end('bad json'); return }
    try {
      await live.applyInput(body as InputCommand)
      res.writeHead(204); res.end()
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: String(error) }))
    }
  },
}), 'dsh-terminal-panel: input')
```

`readJsonBody` must bound the body size, listen for `aborted`, and never trust
the browser’s `terminalId` for Agent authority: UI input is user authority and
may address any terminal; a **tool** must pass its own `exec.agent` and the
service must check ownership.

### 5.5 Sessions route and user-created terminals

```ts
webCtx.webServer.register({
  kind: 'exact',
  path: '/dsh-terminal-panel/sessions',
  handler: (req, res) => {
    if (!authorize(webCtx.connection, req, res)) return
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ terminals: live.list() }))
  },
})
```

The UI’s “New terminal” action can POST `{ type: 'open', cwd, cols, rows }`.
That terminal is **user-owned** and intentionally unsandboxed (matching the
official user terminal, which “runs with the execution environment’s
system-user permissions, independently of the Agent’s sandbox mode and
approval policy” — `dsh-api-terminal-controller/README.md`). Show a small
“unsandboxed user terminal” label in the header. Agent-created terminals use
the sandbox path in §7.

### 5.6 WebSocket alternative (only if needed)

`ctx.webServer.registerUpgrade({ path, handler(req, socket, head) })` hands you
the raw socket. Call `admit(req)` before the handshake, then use `ws`’s
`WebSocketServer({ noServer: true }).handleUpgrade(...)`. For API peers,
`admitConnection(req)` claims socket ownership and returns a `release` that
disposes the Peer (`dsh-client-connection/lib/types/rpc.d.ts:99-106`); for a
browser cookie it returns the shared browser Peer with a no-op release. The
upgrade handler owns protocol negotiation and the socket. SSE is still the
better default for a terminal because output is one-way and input is small.

### 5.7 Why not Typert Remote

`@deepseek-ai/dsh-api-terminal-controller` demonstrates the full pattern:
a `TypertRemoteService` subclass with `@Remote` / `@Remote({ mode: 'stream' })`
decorators, generated strict descriptors (`lib/typert.host.js`, 90 KB) and
client bindings (`lib/typert.remote-client.js`). The Host gateway validates
named arguments against generated codecs and resolves Peers; building that for
a third-party plugin is a large amount of generated machinery for one terminal
stream. A custom SSE route is the pragmatic choice this blueprint recommends.

---

## 6. Agent tools

### 6.1 The tool definition contract

`defineTool` compiles the parameter/output DSL to raw JSON Schema, validates
arguments before `execute`, and keeps `output`, `execute`, finalizers, and
presenters off the model wire (`dsh-tools/lib/index.js:838-878`;
`dsh-tools/lib/types/schema.d.ts:178-248`). The important fields:

```ts
interface DefineToolOptions<S, O> {
  name: string
  description: string
  parameters: S                      // implicit open object root; `required: true` per property
  output: {
    schema: O                        // canonical JSON value schema
    render(args, value): ContentBlock[]
    presentationMeta?(args, value): JsonValue
  }
  timeoutMs?: number                 // declarative; enforced by the timeout policy wrapper
  isConcurrencySafe?(args): boolean
  execute(args, exec: ToolRunContext): Promise<InferValue<O>>
  projectContent?(exec, result): ContentBlock[] | undefined
  finalizeContent?(exec, result): ContentBlock[] | undefined
  presentCall?(args): ToolCallView | undefined
  presentResult?(args, result): ToolResultView | undefined
}
```

`ToolRunContext` (the `exec` argument) carries:

- `callId`, `rootCallId`, `name`, `arguments` (frozen), `token`
- `agent?: Agent` — **the owning Agent**; use `exec.agent.id` /
  `exec.agent.session` for ownership and cwd
- `parent?` for PTC sub-calls
- `signal: AbortSignal` — forward it to all async work
- `deferContext(userMessage)` and `concludeTurn()` for composite tools

(`dsh-tools/lib/types/index.d.ts:216-322`).
`exec.agent` is optional by type (some callers have no Agent), so every tool
must fail clearly when it is absent:

```ts
const agent = exec.agent
if (!agent) throw new Error('live_terminal_run requires an initiating Agent')
```

The built-in Web Client derives tool cards from the raw call arguments/result,
not from `presentCall`/`presentResult` (`dsh-tools/README.md`, “Host
presentation descriptors”). Presenters are still useful for Host-local
consumers, but do not rely on them for the Web UI. A custom card is registered
in the client `tool.call.toolview` slot (§6.5).

### 6.2 Tool registration

Register directly in `apply` (the service proxy binds the registration to the
calling fiber), exactly as `dsh-tool-terminal` does:

```ts
ctx.tools.register(defineTool({ /* ... */ }))
```

The registry feeds the visible schema set into system-prompt assembly
automatically (`dsh-tools/README.md`). Registration/disposal changes the tool
list and therefore the prompt/tool-schema prefix; expect KV-cache invalidation
after a plugin reload.

Recommended tool set (keep it small to limit schema tokens):

| Tool | Purpose | Key args | Result |
|---|---|---|---|
| `live_terminal_open` | Create/reuse the Agent’s visible terminal | `cwd?`, `cols?`, `rows?`, `title?` | id + screen + cursor |
| `live_terminal_run` | Run one command in the visible PTY and wait | `command`, `wait_ms?`, `idle_ms?` | screen + wait reason + cursor + exit code |
| `live_terminal_send` | Raw input for REPLs / interactive prompts / Ctrl-C | `text`, `submit?`, `wait_ms?` | screen + cursor |
| `live_terminal_screenshot` | Capture the current visible screen | `format?: 'text' \| 'ansi' \| 'png'`, `terminal_id?` | text + ANSI? + optional PNG image block |

Optionally add `live_terminal_close` and `live_terminal_list`; they are cheap
but each schema costs tokens. `live_terminal_open` + `run` can be collapsed
into `run` (auto-open) if you prefer three tools.

Name collision: official persistent terminals use `terminal_open`,
`terminal_send`, etc. (`dsh-tool-terminal/lib/index.js:264+`). Use the
`live_terminal_*` prefix, and check `ctx.tools.get('live_terminal_run',
scope)` before registering in a composition that might also mount a fork.

### 6.3 `live_terminal_run` sketch

```ts
// src/tools.ts
import { defineTool } from '@deepseek-ai/dsh-tools'

ctx.tools.register(defineTool({
  name: 'live_terminal_run',
  description:
    'Run one shell command in the visible terminal panel and wait for output to settle. ' +
    'Use this when the user should watch the command live. Returns the current visible screen, ' +
    'cursor position, and a wait reason. The command runs with the session sandbox policy.',
  parameters: {
    command: { type: 'string', required: true, description: 'Shell command to type and submit (one Enter).' },
    wait_ms: { type: 'integer', description: 'Maximum wait in milliseconds (default 15000, max 600000).' },
    idle_ms: { type: 'integer', description: 'Settle after this much output silence (default 350).' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        terminalId: { type: 'string', required: true },
        screen: { type: 'string', required: true },
        ansi: { type: 'string' },
        cols: { type: 'integer', required: true },
        rows: { type: 'integer', required: true },
        cursor: {
          type: 'object', additionalProperties: false,
          properties: { row: { type: 'integer', required: true }, col: { type: 'integer', required: true } },
        },
        wait: { type: 'string', required: true, enum: ['idle', 'timeout', 'exit'] },
        exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.screen }],
  },
  isConcurrencySafe: () => false, // one writer per visible terminal
  async execute(args, exec) {
    const agent = exec.agent
    if (!agent) throw new Error('live_terminal_run requires an initiating Agent')
    const terminal = await live.ensure(agent, exec.signal)
    const result = await terminal.run(String(args.command), {
      waitMs: clamp(args.wait_ms ?? 15_000, 1_000, 600_000),
      idleMs: clamp(args.idle_ms ?? 350, 50, 10_000),
      signal: exec.signal,
      activity: { tool: 'live_terminal_run', callId: String(exec.callId) },
    })
    return {
      terminalId: terminal.id,
      screen: result.screen,
      ansi: result.ansi,
      cols: result.cols,
      rows: result.rows,
      cursor: result.cursor,
      wait: result.wait,
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    }
  },
  presentCall: (args) => ({ card: 'terminal', title: `Run ${args.command}` }),
}))
```

Schema DSL notes:

- The parameters map is an **implicit open object**; requiredness is
  `required: true` on the property, not a JSON-Schema `required` array.
- Every explicit `object` output node needs `additionalProperties: boolean`;
  omitting it is a compile error (`dsh-tools/lib/types/schema.d.ts:54-62`).
- `oneOf` needs at least two branches.
- `render` receives the validated args and canonical value; return
  `ContentBlock[]` (`text`, `image`, ...). A thrown/denied call renders as
  `Error: <message>`; ordinary tool failures do not end the turn
  (`dsh-tools/README.md`, “Execution and cancellation”).

### 6.4 Tool progress / live updates

There is **no public “stream partial tool result” API**. The pipeline records a
started call, then a settle event with rendered content
(`dsh-tools/README.md`, “PTC mode”/“Execution”). Live terminal output therefore
does **not** travel through the tool-result channel. The design is:

- The tool writes the command to the shared PTY and returns a final screen
  snapshot.
- The UI receives the **same PTY output live over SSE**, independent of the
  tool call and even while the tool is still waiting.
- The panel status line can show tool activity (`activity` event) so the user
  sees “agent is typing/running …”.
- If you need a live tool card in the conversation, the client tool view can
  subscribe to the same SSE stream and render the terminal screen inside the
  card; the tool’s final result still arrives normally. That is optional and
  adds a second terminal mirror per card; do not do it in v1.

To observe other tools for an activity feed (not output), a Host listener on
`tools/result` can broadcast `{ name, isError }`; do not broadcast raw
arguments (they may contain secrets). This is optional.

### 6.5 Custom tool card (optional)

Register a keyed view for the wire tool name:

```tsx
ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
  name: 'tool.call.toolview',
  key: 'live_terminal_screenshot',
}, ScreenshotCard))
```

The owner payload is `ToolCallOwnerProps`: `callId`, `toolName`,
`phase` (`preparing`/`start`/`result`), the stage-specific `block`, `cwd`,
`home`, `loadImage`, `openFile`, `inspect`
(`dsh-client-ui-tool/README.md`, “Registering a business tool view”). The
registered card receives the session slot runtime share but no React node or
Runtime service. If you do not register one, an unregistered tool name uses the
generic card; the image block may be flattened to text. For v1 the terminal
panel is the visual surface, so a custom card is optional.

### 6.6 System-prompt guidance

Register a section at the allocated PTY order so the model prefers the visible
terminal for watchable work:

```ts
ctx.systemPrompt.section({
  name: 'tool:live-terminal',
  order: ctx.systemPrompt.getSectionOrder('TOOL_PTY'),
  text:
    'A visible terminal panel mirrors a real PTY that the user can watch. ' +
    'Use live_terminal_run instead of one-shot shell tools when the user should see progress, ' +
    'when a command needs interactive stdin, or when the screen itself matters. ' +
    'Use live_terminal_screenshot to inspect the current screen; prefer its text grid, and request ' +
    'format "png" only when the model accepts images. The panel is already visible; do not paste the ' +
    'whole screen back into chat unless it is needed.',
})
```

Facts:

- `PromptSection` is `{ name, order, text | (context) => string, interpolate?,
  complete? }`; duplicate names in one layer throw; sections sort by
  ascending `order`, then code-unit name (`dsh-system-prompt/lib/types/index.d.ts:47-70`).
- `TOOL_PTY` is centrally allocated at `1700`
  (`dsh-system-prompt/lib/types/index.d.ts:119-154`), the same slot used by
  the official persistent-terminal guidance.
- Registration returns a disposer; registering through the plugin’s `ctx`
  scopes it to the plugin and emits `system-prompt/change`.
- A plugin prompt section is repeated on every request; keep it short. Changes
  invalidate the request prefix from the first changed token.
- `interpolate: false` preserves literal `{{…}}`; use it only when needed.

### 6.7 Skill registration

Ship a skill so a human can invoke the workflow and the model gets a compact
routing description:

```ts
ctx.skills.register({
  name: 'live-terminal',
  description:
    'Run commands in the visible DSH terminal panel and capture its screen. ' +
    'Use when the user should watch a command, for interactive REPLs, or for TUI screenshots.',
  whenToUse:
    'Prefer over one-shot shell tools when live visibility, interactive stdin, ' +
    'or the rendered terminal screen matters.',
  source: 'plugin:dsh-terminal-panel',
  content: [
    '# Live terminal',
    '',
    '1. `live_terminal_open` once per session when you need a persistent shell.',
    '2. `live_terminal_run` for a command the user should watch; read the returned screen.',
    '3. `live_terminal_send` for REPL input; send "\\u0003" to interrupt.',
    '4. `live_terminal_screenshot` to inspect the current screen; text first, PNG only for image-capable models.',
    '',
    'The user can type into the same terminal. Do not assume exclusive control; ' +
    'avoid destructive commands without approval.',
  ].join('\n'),
  invocation: { modelInvocable: true, userInvocable: true },
})
```

Types:

- `SkillRegistration = Omit<SkillDefinition, 'invocation' | 'provider'> &
  { invocation?; provider? }`; `SkillDefinition` extends `SkillSummary` with
  `content` and requires `name`, `description`, `source`, `invocation` resolved
  (`dsh-skill/lib/types/index.d.ts:44-84`).
- `ctx.skills.register()` is first-wins per name within a layer; a duplicate
  logs a warning and returns a no-op disposer (`dsh-skill/lib/index.js:193-214`).
- The model-facing `skill` tool and its catalog are owned by
  `@deepseek-ai/dsh-tool-skill`; the registry only merges providers. The base
  composition mounts `dsh-skill`, `dsh-skill-filesystem`, and `dsh-tool-skill`
  (`dsh-base/cordis.patch.yml:308-315`).
- Guard the registration with `ctx.inject(['skills'], ...)` so the plugin still
  loads in a composition without the skill service.

---

## 7. PTY options

### 7.1 Comparison

| Option | Mechanics | Pros | Cons | Use? |
|---|---|---|---|---|
| **`ctx.subprocess.spawnTerminal`** | Local provider spawns `node-pty` with ConPTY on Windows; returns a `Readable` output, `write`, `resize`, `terminate`, `inspectForeground`, `inspectActivity` | Real PTY; no native dependency in the plugin; provider owns process tree/Job cleanup; Windows supported; same primitive as official user terminal and persistent terminal backend | Output is a Node `Readable` (not typed async iterable); no screen emulation — you add headless xterm; sandbox is your responsibility | **Recommended** |
| `ctx.terminals` + `dsh-terminal-bash` | Official owner-scoped session registry + bash/pwsh backend, line-oriented sanitized output, readiness detection | Owner fencing, sandbox integration, official tools, readiness | No raw output subscription/ANSI mirror; `read()` is line text; screen grid not exposed; sessions single-owner | Only for a line-oriented panel or if you delegate tools |
| `ctx.terminalController` / `webTerminals` | Official user terminal: `BrowserTerminal` + headless xterm + serializer, Typert Remote attach stream | Official xterm UI and screen serializer already exist; browser reconnect; retention | `attach()` needs a live `ctx.invocation`; no Host write API; user terminals bypass the Agent sandbox; coupling to generated Remote artifacts | Not for Agent-driven |
| Bundle `node-pty` | Direct native module + prebuilds | Full control | Native ABI/build approval, duplicate node-pty copies, ConPTY asset packing, Windows teardown work; `pnpm approve-builds` friction | Avoid |
| `ctx.subprocess.spawn` + pipes | Ordinary child process | Simple | Not a TTY; no interactive programs, no resize, no screen | No |

### 7.2 `spawnTerminal` contract

`SubprocessTerminalSpawnSpec`
(`dsh-subprocess/lib/types/types.d.ts:198-217`):

```ts
{
  argv: readonly string[]          // argv[0] is the program
  cwd: string
  env?: Record<string, string>     // layered after the provider's credential scrub
  rows: number
  cols: number
  terminalType: string             // sets TERM; use "xterm-256color" for a real UI
  shellActivity?: boolean          // Windows: unsupported -> unknown activity
  graceMs: number                  // TERM->KILL cleanup grace
  signal?: AbortSignal             // allocation cancellation only
}
```

`SubprocessTerminalHandle`
(`dsh-subprocess/lib/types/types.d.ts:238-278`):

```ts
{
  pid: number
  output: Readable                 // UTF-8 text bytes, ends after queued output
  done: Promise<SubprocessOutcome> // top-level process exit
  write(data: string): Promise<void>
  resize(cols: number, rows: number): Promise<void>
  inspectForeground(): Promise<{ processGroupId: number; inputWaiting: boolean } | undefined>
  inspectActivity(): Promise<{ state: 'idle' | 'busy' | 'unknown'; revision: number }>
  signalForeground(signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGTSTP' | 'SIGHUP'): Promise<number>
  terminate(): Promise<void>       // whole observed session; idempotent
}
```

The local provider sets `useConptyDll: true` on Windows and resolves
`conpty/conpty.dll` + `OpenConsole.exe` relative to node-pty’s addon
(`dsh-subprocess-local/lib/index.js:1618-1680`; README “Running terminal
sessions” and “Windows limitations”). It keeps terminal output backpressured
and terminates the whole session on `terminate()`.

### 7.3 Shell resolution on Windows

```ts
async function resolveShell(ctx: Context, configured: string | undefined, signal: AbortSignal) {
  if (configured) return { path: await ctx.subprocess.resolveExecutable(configured, undefined, signal), args: [] }
  const env = await ctx.subprocess.terminalEnvironment(signal)
  const candidates = env.platform === 'windows'
    ? ['pwsh', 'powershell', env.defaultShell ?? 'cmd.exe']
    : [env.defaultShell ?? '/bin/sh']
  for (const candidate of candidates) {
    try {
      const path = await ctx.subprocess.resolveExecutable(candidate, undefined, signal)
      const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1).toLowerCase()
      return {
        path,
        args: name.startsWith('pwsh') || name.startsWith('powershell') ? ['-NoLogo'] : [],
      }
    } catch { /* try next */ }
  }
  throw new Error('no usable shell found (tried pwsh, powershell, cmd.exe)')
}
```

This mirrors the official shell resolution (`dsh-api-terminal-controller/lib/types/shells.js`):
PowerShell gets `-NoLogo`, POSIX gets `-i`, `cmd` gets no args. `resolveExecutable`
verifies the executable and returns its absolute path
(`dsh-subprocess/lib/types/index.d.ts:88`). Do not add `-NoProfile` unless the
user asks; DSH’s official user terminal preserves the user profile.

### 7.4 Sandbox: do not silently run unconfined

The official *user* terminal deliberately bypasses the Agent sandbox. Our
Agent-created terminal must not. Copy the terminal-bash pattern
(`dsh-terminal-bash/lib/index.js:1047-1065`):

```ts
async function shellArgv(ctx: Context, agent: Agent, shellPath: string, args: string[], signal: AbortSignal) {
  const policy = ctx.sandboxPolicy.resolve({ session: agent.session })
  const argv = [shellPath, ...args]
  if (policy.mode === 'danger-full-access') return argv
  const sandbox = ctx.get('sandbox')
  if (!sandbox) throw new Error(`sandbox mode "${policy.mode}" requires a ctx.sandbox provider`)
  return (await sandbox.confine(argv, { ...policy, mode: policy.mode }, signal)).argv
}
```

Facts:

- `sandboxPolicy.resolve({ session })` folds the session’s last
  `sandbox/mode` event over the deployment default and the session’s immutable
  cwd (`dsh-sandbox-policy/lib/types/index.d.ts:49-88`).
- `sandbox.confine(argv, policy, signal)` returns the wrapped argv or rejects
  with `SandboxUnavailableError`; it never silently runs unconfined
  (`dsh-sandbox/README.md`, “Fail-closed behavior”).
- `danger-full-access` bypasses confinement; `read-only`/`workspace-write` use
  the same-world backend (Windows ACL, partial enforcement).
- Sandbox mode changes while a terminal is open: the official backend fences
  them; our simpler policy is to **close and reopen** the Agent terminal when a
  `sandbox/mode` event changes the mode, or to refuse writes with a clear
  message. Do not keep a terminal open under a policy that no longer matches
  the session.
- A user-created terminal (`createdBy: 'user'`) is unsandboxed by design and
  must be labeled as such in the UI.

### 7.5 `LiveTerminal` implementation sketch

```ts
// src/live-terminal.ts
import { createRequire } from 'node:module'
import type { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'

const require_ = createRequire(import.meta.url)
type HeadlessTerminal = import('@xterm/headless').Terminal
type SerializeAddon = import('@xterm/addon-serialize').SerializeAddon

export class LiveTerminal {
  readonly id: string
  readonly ownerId: string | undefined
  readonly createdAt = Date.now()
  private readonly screen: HeadlessTerminal
  private readonly serializer: SerializeAddon
  private infoState: TerminalInfo
  private readonly decoder = new TextDecoder('utf-8', { ignoreBOM: true })
  private readonly clients = new Set<{ send(event: ServerEvent): void }>()
  private chain: Promise<void> = Promise.resolve()
  private seq = 0
  private closed = false
  private exitCode: number | null | undefined

  private constructor(
    private readonly ctx: Context,
    private readonly handle: SubprocessTerminalHandle,
    info: TerminalInfo,
    scrollback: number,
  ) {
    this.id = info.id
    this.ownerId = info.owner === 'agent' ? info.sessionId : undefined
    this.infoState = info
    const { Terminal } = require_('@xterm/headless') as typeof import('@xterm/headless')
    const { SerializeAddon } = require_('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize')
    this.screen = new Terminal({ cols: info.cols, rows: info.rows, scrollback, allowProposedApi: true })
    this.serializer = new SerializeAddon()
    this.screen.loadAddon(this.serializer)
    void this.consume()
  }

  static async spawn(ctx: Context, agent: Agent | undefined, request: OpenRequest, config: LiveConfig): Promise<LiveTerminal> {
    const signal = request.signal
    const cwd = request.cwd ?? (agent ? await ctx.workingDirectory.ensure(agent, signal) : process.cwd())
    const shell = await resolveShell(ctx, config.shellPath, signal)
    const argv = agent
      ? await shellArgv(ctx, agent, shell.path, [...shell.args, ...config.shellArgs], signal)
      : [shell.path, ...shell.args, ...config.shellArgs]
    const cols = clamp(request.cols ?? config.cols, 2, config.maxCols)
    const rows = clamp(request.rows ?? config.rows, 1, config.maxRows)
    const handle = await ctx.subprocess.spawnTerminal({
      argv, cwd, cols, rows,
      terminalType: 'xterm-256color',
      graceMs: config.disposeGraceMs,
      signal,
      env: { TERM: 'xterm-256color' },
      shellActivity: false,
    })
    const info: TerminalInfo = {
      id: `lt-${crypto.randomUUID()}`,
      sessionId: agent?.id ?? 'user',
      title: request.title ?? (agent ? `Agent ${agent.id.slice(0, 8)}` : 'User terminal'),
      cols, rows, state: 'running', owner: agent ? 'agent' : 'user',
    }
    const terminal = new LiveTerminal(ctx, handle, info, config.scrollback)
    void terminal.watchExit()
    return terminal
  }

  /** Serialize every terminal operation; output and snapshots share one order. */
  private enqueue<T>(op: () => Promise<T> | T): Promise<T> {
    const next = this.chain.then(op)
    this.chain = next.then(() => undefined, () => undefined)
    return next
  }

  private async consume(): Promise<void> {
    try {
      for await (const chunk of this.handle.output as AsyncIterable<Buffer>) {
        const text = this.decoder.decode(chunk, { stream: true })
        if (text.length > 0) await this.output(text)
      }
      const tail = this.decoder.decode()
      if (tail.length > 0) await this.output(tail)
    } catch (error) {
      this.broadcast({ type: 'error', message: String(error) })
    }
  }

  private output(data: string): Promise<void> {
    return this.enqueue(async () => {
      await new Promise<void>((resolve) => this.screen.write(data, resolve))
      this.seq += 1
      this.broadcast({ type: 'output', terminalId: this.id, seq: this.seq, data })
    })
  }

  async run(command: string, opts: RunOptions): Promise<RunResult> {
    await this.write(`${command.replace(/\r?\n/gu, '\r')}\r`)
    return this.waitForQuiet(opts)
  }

  async write(data: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed) throw new Error(`terminal ${this.id} is closed`)
      await this.handle.write(data)
    })
  }

  async resize(cols: number, rows: number): Promise<void> {
    return this.enqueue(async () => {
      await this.handle.resize(cols, rows)
      this.screen.resize(cols, rows)
      this.infoState = { ...this.infoState, cols, rows }
      this.broadcast({ type: 'state', terminal: this.info })
    })
  }

  async waitForQuiet(opts: RunOptions): Promise<RunResult> {
    const deadline = Date.now() + opts.waitMs
    let lastSeq = this.seq
    let lastOutput = Date.now()
    while (Date.now() < deadline) {
      opts.signal?.throwIfAborted()
      await sleep(50)
      if (this.seq !== lastSeq) {
        lastSeq = this.seq
        lastOutput = Date.now()
      } else if (Date.now() - lastOutput >= opts.idleMs) {
        return this.snapshot('idle')
      }
      if (this.exitCode !== undefined) return this.snapshot('exit')
    }
    return this.snapshot('timeout')
  }

  async snapshot(wait: 'idle' | 'timeout' | 'exit'): Promise<RunResult> {
    return this.enqueue(() => {
      const buf = this.screen.buffer.active
      const lines: string[] = []
      for (let row = 0; row < this.screen.rows; row += 1) {
        const line = buf.getLine(buf.viewportY + row)
        lines.push(line ? line.translateToString(true) : '')
      }
      return {
        screen: lines.join('\n').replace(/\s+$/u, ''),
        ansi: this.serializer.serialize({ scrollback: 0 }),
        cols: this.screen.cols,
        rows: this.screen.rows,
        cursor: { row: buf.cursorY + 1, col: buf.cursorX + 1 },
        wait,
        exitCode: this.exitCode,
      }
    })
  }

  async attach(client: { send(event: ServerEvent): void }): Promise<void> {
    await this.enqueue(() => {
      client.send({
        type: 'snapshot',
        terminal: this.info,
        seq: this.seq,
        ansi: this.serializer.serialize({ scrollback: 0 }),
      })
      this.clients.add(client)
    })
  }

  detach(client: { send(event: ServerEvent): void }): void {
    this.clients.delete(client)
  }

  private broadcast(event: ServerEvent): void {
    for (const client of this.clients) {
      try { client.send(event) } catch { this.clients.delete(client) }
    }
  }

  private async watchExit(): Promise<void> {
    try {
      const outcome = await this.handle.done
      this.exitCode = outcome.exitCode
      this.infoState = { ...this.infoState, state: 'exited', exitCode: outcome.exitCode }
      this.broadcast({ type: 'state', terminal: this.info })
    } catch (error) {
      this.infoState = { ...this.infoState, state: 'failed' }
      this.broadcast({ type: 'state', terminal: this.info })
    }
  }

  get info(): TerminalInfo { return { ...this.infoState } }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.handle.terminate().catch(() => undefined)
    this.screen.dispose()
    for (const client of this.clients) client.send({ type: 'state', terminal: { ...this.info, state: 'exited' } })
    this.clients.clear()
  }
}
```

Critical ordering details:

- `screen.write(data, cb)` is asynchronous; awaiting the callback before
  broadcasting `seq` is what makes a later snapshot consistent with the last
  broadcast sequence.
- `handle.output` is a Node `Readable`; `for await` works in Node, but the
  type says `Readable`, so cast to `AsyncIterable<Buffer>` or use `on('data')`
  + a queue. Do **not** attach a second consumer.
- `handle.done` rejects on spawn/provider failure; handle both resolve and
  reject.
- `terminate()` may take up to `graceMs`; dispose is async. HMR/plugin unload
  should await it so the next plugin instance does not inherit a live process.
- The service should cap per-Agent terminals (e.g. 4) and close idle ones.
  Official user terminals allow 8 per session and reclaim unattended ones;
  mirror a smaller limit.

### 7.6 Windows notes

- **No `node-pty` dependency**: `ctx.subprocess.spawnTerminal` uses the
  installation’s node-pty and its bundled ConPTY assets. This avoids
  `pnpm approve-builds`, native ABI mismatches, and duplicate copies.
- **ConPTY asset path**: the provider passes `useConptyDll: true` and resolves
  `conpty/conpty.dll` and `OpenConsole.exe` relative to node-pty’s addon
  (`dsh-subprocess-local/README.md`, “Windows terminal allocation requires
  node-pty’s bundled console host assets”). Do not repackage node-pty yourself.
- **SIGINT**: the provider implements `signalForeground('SIGINT')` as a
  `\x03` Ctrl-C write; `SIGTSTP`/`SIGHUP` are rejected on Windows
  (`dsh-subprocess-local/README.md`, “Windows terminal signalling is
  console-wide”). For Ctrl-C in the UI, write `"\u0003"` or call
  `signalForeground('SIGINT')`.
- **Readiness**: Windows has no exact stdin-wait tier. Use output silence
  (`idle`) with a minimum wait; do not claim a command finished just because
  the screen went quiet. `inspectActivity()` on Windows is `unknown` for
  custom shells (`dsh-subprocess-local/README.md`).
- **Encoding**: the PTY is UTF-8; PowerShell may emit `\r\n`. Preserve bytes in
  xterm; the headless mirror normalizes rendering. For text screenshots,
  `translateToString(true)` trims right-side blanks; keep `\n` joins.
- **Shell startup**: `pwsh -NoLogo` inherits the user profile (aliases,
  prompt). If the profile is slow, the first `run` may include startup text;
  wait for the first output before accepting a command (or send a newline and
  wait for quiescence at open).
- **Sandbox**: Windows ACL enforcement is `partial`; `read-only` may deny
  `[Console]::` initialization that PowerShell needs. If the shell cannot
  start under the current mode, fail with the sandbox diagnostic rather than
  silently retrying unconfined.

### 7.7 Process/owner lifecycle

- Key Agent terminals by `agent.id` (which is the SessionId: `Agent.id` is
  typed as `SessionId`, `dsh-agent/lib/types/types.d.ts:11-13`). One live
  terminal per Agent is enough for v1; multiple tabs can be keyed by
  `agent.id + ':' + name`.
- Tool calls check `terminal.ownerId === agent.id`; a foreign id is an error,
  mirroring the official `ctx.terminals` fencing (“FOREIGN_SESSION”).
- The user/UI may address any terminal (user authority); do not let a tool
  inherit that authority.
- On plugin dispose/HMR: close all Agent terminals and user terminals, await
  `terminate()`, and clear the registry. A PTY that survives plugin reload
  becomes an orphan with no screen mirror.
- Do not persist terminal IDs across Host restarts; PTYs are process-local.
  Browser reload should reconnect by matching the current Host registry, not by
  trusting a saved id. The panel can show “terminal ended” with a New button.

---

## 8. Screen capture / “screenshot”

### 8.1 Why a headless mirror

`@xterm/headless` is the same terminal emulator as the browser xterm, without a
DOM. Feeding it the exact PTY byte stream gives:

- the **visible text grid** (`buffer.active` + `getLine` +
  `translateToString`), including TUI layouts, alternate buffer, cursor
  position;
- an **ANSI snapshot** via `@xterm/addon-serialize`
  (`serialize({ scrollback: 0 })` for the visible screen);
- a consistent sequence number for browser reconnect.

The official user terminal already does exactly this host-side:
`BrowserTerminal` constructs a headless `Terminal` + `SerializeAddon`, feeds
`screen.write(data, resolve)`, and returns `serializer.serialize()` in its
`snapshot` frame (`dsh-api-terminal-controller/lib/types/terminal.js:7-37,
76-82`). Our plugin reuses the pattern but exposes it to the Agent.

```ts
// visible text grid
function screenText(screen: HeadlessTerminal): { text: string; cursor: { row: number; col: number } } {
  const buf = screen.buffer.active
  const lines: string[] = []
  for (let row = 0; row < screen.rows; row += 1) {
    const line = buf.getLine(buf.viewportY + row)
    lines.push(line ? line.translateToString(true) : '')
  }
  return {
    text: lines.join('\n').replace(/\s+$/u, ''),
    cursor: { row: buf.cursorY + 1, col: buf.cursorX + 1 }, // 1-based for the model
  }
}
```

API facts (from `@xterm/headless` typings):

- `IBuffer.getLine(y)` returns `IBufferLine | undefined`; result is live, read
  immediately.
- `IBufferLine.translateToString(trimRight?, startColumn?, endColumn?)`.
- `IBuffer.viewportY` is the top line of the viewport; `baseY` is the top of
  the bottom page (they are equal when scrolled to the bottom); `cursorX`,
  `cursorY` are viewport-relative.
- `Terminal.write(data, callback)` invokes `callback` after parsing;
  `Terminal.resize(cols, rows)`, `Terminal.dispose()`.
- `SerializeAddon.serialize({ scrollback: 0 })` serializes the visible screen;
  omit `scrollback` for history.

### 8.2 Text/ANSI tool result

`live_terminal_screenshot` returns text by default:

```ts
output: {
  schema: {
    type: 'object', additionalProperties: false,
    properties: {
      terminalId: { type: 'string', required: true },
      text: { type: 'string', required: true },
      ansi: { type: 'string' },
      cols: { type: 'integer', required: true },
      rows: { type: 'integer', required: true },
      cursor: { type: 'object', additionalProperties: false, properties: {
        row: { type: 'integer', required: true }, col: { type: 'integer', required: true },
      } },
      image: { type: 'object', additionalProperties: false, properties: {
        attachmentId: { type: 'string', required: true },
        mediaType: { type: 'string', required: true },
        bytes: { type: 'integer', required: true },
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
      } },
    },
  },
  render: (_args, value) => {
    const blocks: ContentBlock[] = [{ type: 'text', text: value.text }]
    if (value.image) {
      type ImageRef = import('@deepseek-ai/dsh-attachment').ImageAttachmentRef
      const attachment: ImageRef = {
        attachmentId: value.image.attachmentId as ImageRef['attachmentId'],
        mediaType: value.image.mediaType as ImageRef['mediaType'],
        bytes: value.image.bytes,
        width: value.image.width,
        height: value.image.height,
      }
      blocks.push({ type: 'image', attachment })
    }
    return blocks
  },
}
```

This is the `read_image` pattern: the canonical value carries only JSON image
metadata; `render` reconstructs the `ImageBlock` from it
(`dsh-tool-fs/lib/index.js:928-975, 1049-1055`). `ContentBlock` is
merge-extensible and the image block is
`{ type: 'image', attachment: ImageAttachmentRef }`
(`dsh-llm/lib/types/types.d.ts:55-71, 109-126`).

### 8.3 PNG from the Host (optional)

The host already has the text grid; render it to SVG and rasterize with
`sharp` if available. This needs **no browser connection** and works even if
the DSH tab is closed.

```ts
// src/png.ts
import { createRequire } from 'node:module'
const require_ = createRequire(import.meta.url)

function xml(text: string): string {
  return text.replace(/[<>&"']/gu, ch => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' } as Record<string, string>
  )[ch]!)
}

export async function pngFromScreen(
  text: string, cols: number, rows: number,
): Promise<{ data: Uint8Array; width: number; height: number } | undefined> {
  let sharp: any
  try { sharp = require_('sharp') } catch { return undefined }

  const cellW = 8.4
  const lineH = 17
  const pad = 12
  const width = Math.min(4096, Math.ceil(cols * cellW + pad * 2))
  const height = Math.min(4096, Math.ceil(rows * lineH + pad * 2))
  const lines = text.split('\n').slice(0, rows)
  const body = lines.map((line, index) =>
    `<text x="${pad}" y="${pad + 14 + index * lineH}" xml:space="preserve">${xml(line)}</text>`
  ).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<rect width="100%" height="100%" fill="#111318"/>`
    + `<g font-family="Consolas, 'Cascadia Mono', monospace" font-size="14" fill="#e6e6e6">${body}</g>`
    + `</svg>`

  const data = await sharp(Buffer.from(svg)).png().toBuffer()
  return { data, width, height }
}
```

Then store it through the attachment service:

```ts
const png = await pngFromScreen(snap.screen, snap.cols, snap.rows)
if (png && ctx.get('attachments')) {
  const ref = await ctx.attachments.saveImage({
    data: png.data,
    mediaType: 'image/png',
    name: 'terminal-screen.png',
  })
  image = {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
  }
}
```

Facts:

- `ctx.attachments.saveImage({ data, mediaType, name? })` returns an
  `ImageAttachmentRef` with verified `attachmentId`, `bytes`, `width`,
  `height` (`dsh-attachment/lib/types/types.d.ts:5-28, 115-121`).
- The base composition mounts `dsh-attachment-local`
  (`dsh-base/cordis.patch.yml:146-147`), so the service is available in the
  desktop/web profiles. Guard with `ctx.get('attachments')` anyway.
- `sharp` is a native dependency. It is present in the DSH installation, but
  importing the installation’s copy couples you to its ABI. Two safe choices:
  1. declare `sharp` as an **optional** dependency and lazy-`require` it;
     failure to load simply returns text only;
  2. skip Host PNG entirely in v1 and add it after the text path is stable.
- SVG text rendering depends on installed fonts; `Consolas`/`Cascadia Mono`
  exist on Windows. CJK/wide characters need a font with those glyphs; xterm’s
  cell width may differ. For exact glyph fidelity, a browser capture is better;
  for a readable screenshot, SVG is fine.
- Cap dimensions (4096 px) and rows/cols (200×500) to bound memory. The
  attachment service itself enforces image limits (`imageLimits`).

### 8.4 Alternative: browser canvas capture

If you need pixel-perfect xterm colors/cursor/selection:

1. The Dock keeps the xterm instance. On a `capture` request (SSE event or a
   POST response), it renders the visible buffer to an offscreen `<canvas>`:
   iterate `term.buffer.active` rows, draw each cell with the cell’s
   `getFgColor`/`getBgColor`/`getChars` (xterm exposes cell attributes through
   `IBufferLine.getCell`), or use an `html-to-image`/`html2canvas` library on
   the `.xterm` element.
2. `canvas.toDataURL('image/png')` → POST to `/dsh-terminal-panel/capture`.
3. The Host decodes base64, calls `attachments.saveImage`, and resolves the
   pending tool request.

Problems: requires the page to be open, introduces a request/response
correlation between the tool and one browser tab, and the DOM renderer’s
selection/cursor may not be captured by all libraries. The Host SVG path has
none of these dependencies. **Recommendation: text first, Host SVG PNG second,
browser capture only if visual fidelity is a hard requirement.**

### 8.5 Image-capable model gating

`read_image` checks the active route’s `inputModalities` before saving an image
(`dsh-tool-fs/lib/index.js:902-918`) and returns a clear error for text-only
models. Our screenshot tool should either:

- always return text, and add the PNG only when `ctx.get('llm')` reports an
  image-capable active route (reuse the read_image logic if you can), or
- return the PNG unconditionally and let `dsh-llm` project a text placeholder
  for text-only routes (`projectImagesForTextModel`,
  `dsh-llm/lib/types/content.js:218-233`).

For a predictable UX, prefer the first: if the model cannot see images, return
text and a short note instead of an image block that becomes a placeholder.

### 8.6 Screenshot of a running command

A screen capture during a running command is naturally partial. Return the
current screen plus `wait: 'running' | 'idle' | 'timeout'`; do not imply the
command finished. For long-running commands, the Agent can call
`live_terminal_screenshot` repeatedly (each call is cheap) or wait for a later
`live_terminal_run`/`send` result.

### 8.7 Scrollback

`serialize()` without `scrollback` includes history; the visible grid is
`rows` lines. For a bounded history capture, add `scrollback?: number` to the
tool args and serialize that many rows, or expose the last N lines from
`buffer.getLine(baseY - n + row)`. Keep the default visible-screen-only: it is
what the user sees and what the requirement asks for.

---

## 9. Build toolchain

### 9.1 Why a bespoke build

There is no public DSH client-bundle builder in `app.asar`. The official
packages are built in the DSH repo with tsdown/rolldown and a custom
`externalClientBundle` adapter; `dsh-better-display`’s `tsdown.config.ts`
imports that adapter from DSHX (`externalClientBundle('dsh-better-display',
['src/dsh-better-display.ts'], { clientEntry: 'src/client/index.tsx' })`,
`tsdown.config.ts:21-26`). That adapter is not shipped with DSH and is not on
npm as a public package. The wrapper format is small and stable, so a ~120-line
esbuild script is the most reliable path.

The build must produce a **classic script** (no top-level `import`/`export`)
that calls `window.__ModuleLoader__.load({ id, factory })` and returns a CJS
module exporting `apply`/`inject`. We tested this exact shape with esbuild
0.25.10 and lightningcss 1.33.0: esbuild’s CJS output references `module` and
`require`, the wrapper supplies them, and `module.exports` is the factory
return.

### 9.2 Host `tsconfig.host.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "skipLibCheck": true,
    "rootDir": "src",
    "outDir": "lib",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/client/**"]
}
```

- `NodeNext` requires relative imports to use `.js` extensions (`import {
  LiveTerminal } from './live-terminal.js'`). This is what the official
  packages emit.
- Bare `@deepseek-ai/*` imports are left as-is; the profile runtime resolver
  maps them to installation copies.
- Host entry is `src/index.ts` → `lib/index.js`; `package.json.main` matches.
- `declaration: true` gives `lib/types/index.d.ts` for the `exports "."` types
  field (not strictly required, but good for editors).

### 9.3 Client `tsconfig.client.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["react"]
  },
  "include": [
    "src/client/**/*.ts",
    "src/client/**/*.tsx",
    "src/client/style.d.ts",
    "src/protocol.ts"
  ]
}
```

`src/client/style.d.ts`:

```ts
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
declare module '*.css' {
  const css: string
  export default css
}
```

The client is typechecked but never emitted by `tsc`; esbuild owns the bundle.
Type-only imports of `@deepseek-ai/dsh-client-*` are erased and create no
module-table request.

### 9.4 `scripts/build-client.mjs` (tested shape)

```js
// Build the DSH client bundle: CJS body + __ModuleLoader__ wrapper.
// - only the platform seed table is external
// - xterm and all other deps are bundled
// - CSS (including CSS modules) is compiled with lightningcss and injected
import { build } from 'esbuild'
import { transform } from 'lightningcss'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))

// Exact platform seed table from the shell (see §3.4). Do not add packages
// here unless they are in `dsh.client.external` and answered by a graph row.
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** Compile one CSS file into a JS module that injects a style tag. */
const cssPlugin = {
  name: 'dsh-css',
  setup(buildApi) {
    // Let esbuild resolve the specifier (including package CSS such as
    // @xterm/xterm/css/xterm.css), then replace the CSS output with a JS module.
    buildApi.onLoad({ filter: /\.css$/ }, async args => {
      const source = await readFile(args.path)
      const isModule = /\.module\.css$/i.test(args.path)
      const result = transform({
        filename: args.path,
        code: source,
        minify: true,
        ...(isModule
          ? { cssModules: { pattern: 'dshTerm_[hash]_[local]' } }
          : {}),
      })
      const mapping = Object.fromEntries(
        Object.entries(result.exports ?? {}).map(([local, value]) => [local, value.name]),
      )
      const tagId = `${pkg.name}/${relative(root, args.path).replaceAll('\\', '/')}`
      const css = JSON.stringify(result.code.toString())
      const contents = `
const css = ${css};
if (typeof document !== 'undefined') {
  const id = ${JSON.stringify(tagId)};
  if (document.querySelector('style[data-plugin-css=' + JSON.stringify(id) + ']') === null) {
    const style = document.createElement('style');
    style.dataset.plugin = ${JSON.stringify(pkg.name)};
    style.dataset.pluginCss = id;
    style.textContent = css;
    document.head.appendChild(style);
  }
}
export default ${JSON.stringify(mapping)};
`
      return { contents, loader: 'js', resolveDir: dirname(args.path) }
    })
  },
}

const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome120'],
  jsx: 'automatic',
  sourcemap: false, // wrapping shifts the map; add a mapped wrapper only if needed
  legalComments: 'none',
  external: PLATFORM_MODULES,
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [cssPlugin],
  logLevel: 'info',
})

const body = result.outputFiles[0].text
const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${body}
    return module.exports;
  }
});
`

await mkdir(resolve(root, 'lib'), { recursive: true })
await writeFile(resolve(root, 'lib/client.js'), wrapped, 'utf8')
console.log(`client bundle: lib/client.js (${Buffer.byteLength(wrapped)} bytes)`)
```

Notes:

- The wrapper is intentionally not minified; the `id` must equal the package
  name / graph row id.
- `sourcemap: false` because the wrapper line offset would make an external map
  lie unless the wrapper is added as a banner in the same build. If source maps
  matter, use esbuild’s `banner`/`footer` to add the wrapper inside the build
  and let esbuild generate the map; the CJS body then starts on the same line
  as the map expects.
- `PLATFORM_MODULES` must match the shell seed table exactly. Adding
  `@deepseek-ai/dsh-client-ui-layout` to `external` **without** a
  `dsh.client.external` entry would make `require` fail at materialization
  (“missed the module table”). Add it to both if you actually import it at
  runtime; type-only imports do not need either.
- Do **not** set `packages: 'external'`; that would externalize xterm too.
- CSS module class names are hashed (`dshTerm_<hash>_<local>`); the default
  export is a plain object. The injected `<style>` is tagged with
  `data-plugin` and `data-plugin-css` so HMR/unload can find it (the official
  bundles use the same convention, e.g. `dsh-client-ui-sidebar-terminal/lib/client.js:13-19`).
- A lazy chunk is optional. If you add one, build a second CJS bundle from
  `src/client/terminal-panel.tsx`, wrap it with
  `{ id: pkg.name, chunk: "client.terminal.js", factory }`, and load it with
  `const mod = await require.async("./client.terminal.js")`. The chunk must be
  self-contained and may require only platform seeds / declared externals
  (`ClientBundleRequire.async`, `dsh-client-modules/lib/types/client/manifest.d.ts:187-193`;
  official example: `dsh-client-ui-sidebar-terminal/lib/client.js:167`).
- For a production plugin, add `minify: true`; xterm + React glue will be
  ~400–500 KB minified. The official sidebar terminal’s lazy chunk is ~686 KB.

### 9.5 Package scripts

```json
{
  "scripts": {
    "build": "npm run build:host && npm run build:client",
    "build:host": "tsc -p tsconfig.host.json",
    "build:client": "node scripts/build-client.mjs",
    "typecheck": "tsc -p tsconfig.host.json --noEmit && tsc -p tsconfig.client.json --noEmit",
    "watch:client": "node scripts/build-client.mjs --watch"
  }
}
```

`--watch` is not in the sketch above; add an esbuild `context()` branch if you
want it. For the normal dev loop, a rebuild + page reload is sufficient.

### 9.6 Typecheck without duplicate host packages

This is the subtle packaging trap in DSH plugin development. A Host plugin
imports `@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`, etc. at runtime.
The profile runtime resolver supplies the **Host’s** copies. If the plugin’s
own `node_modules` contains another copy, Node resolves the plugin’s local copy
first (normal `node_modules` lookup), and two tool registries / two Cordis
service systems / two `schemastery` instances can break the Host. The known
symptom is every tool call failing with a missing `prepare` (prior research:
`research/existing-plugins.md:239`).

Therefore:

- **Do not install `@deepseek-ai/*` host packages into
  `packages/dsh-terminal-panel/node_modules`.** Keep them in
  `peerDependencies` only, and install dev dependencies with
  `npm install --legacy-peer-deps` (or a `.npmrc` containing
  `legacy-peer-deps=true`). npm then installs esbuild/lightningcss/typescript
  and `@xterm/*`, but not the peers.
- `tsc` still needs the declarations. Put them in a **typecheck project outside
  the plugin package’s resolution ancestry**:

```
C:\Users\LANCANG\Desktop\Code\DSH Plugs\dsh-live-terminal\
  packages\dsh-terminal-panel\        # the linked package (no host packages)
  tools\typecheck\
    package.json                      # devDeps: @deepseek-ai/* type packages
    node_modules\                     # installed here, NOT under packages/
```

`tools/typecheck/package.json`:

```json
{
  "name": "dsh-terminal-panel-typecheck",
  "private": true,
  "devDependencies": {
    "@deepseek-ai/cordis": "~4.0.5",
    "@deepseek-ai/dsh-agent": "0.2.1-rc.2",
    "@deepseek-ai/dsh-attachment": "0.2.1-rc.2",
    "@deepseek-ai/dsh-client-store": "0.2.1-rc.2",
    "@deepseek-ai/dsh-client-ui-conversation": "0.2.1-rc.2",
    "@deepseek-ai/dsh-client-ui-layout": "0.2.1-rc.2",
    "@deepseek-ai/dsh-client-ui-primitives": "0.2.1-rc.2",
    "@deepseek-ai/dsh-client-ui-renderer": "0.2.1-rc.2",
    "@deepseek-ai/dsh-client-ui-session": "0.2.1-rc.2",
    "@deepseek-ai/dsh-client-ui-slots": "0.2.1-rc.2",
    "@deepseek-ai/dsh-client-ui-tool": "0.2.1-rc.2",
    "@deepseek-ai/dsh-host-webserver": "0.2.1-rc.2",
    "@deepseek-ai/dsh-llm": "0.2.1-rc.2",
    "@deepseek-ai/dsh-sandbox": "0.2.1-rc.2",
    "@deepseek-ai/dsh-sandbox-policy": "0.2.1-rc.2",
    "@deepseek-ai/dsh-session": "0.2.1-rc.2",
    "@deepseek-ai/dsh-skill": "0.2.1-rc.2",
    "@deepseek-ai/dsh-subprocess": "0.2.1-rc.2",
    "@deepseek-ai/dsh-system-prompt": "0.2.1-rc.2",
    "@deepseek-ai/dsh-terminal": "0.2.1-rc.2",
    "@deepseek-ai/dsh-tools": "0.2.1-rc.2",
    "@deepseek-ai/dsh-working-directory": "0.2.1-rc.2",
    "@deepseek-ai/schemastery": "~3.18.5"
  }
}
```

Add `paths` to both `tsconfig.host.json` and `tsconfig.client.json` (they live
in `packages/dsh-terminal-panel`, so the relative path is `../../tools/...`):

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@deepseek-ai/*": ["../../tools/typecheck/node_modules/@deepseek-ai/*"]
    }
  }
}
```

TypeScript resolves `@deepseek-ai/dsh-tools` and subpaths like
`@deepseek-ai/dsh-tools/types` through the wildcard. The typecheck project’s
`node_modules` is not an ancestor of `packages/dsh-terminal-panel/lib/index.js`,
so the runtime never finds those copies.

Install and typecheck:

```powershell
cd "C:\Users\LANCANG\Desktop\Code\DSH Plugs\dsh-live-terminal\tools\typecheck"
npm install
cd "..\..\packages\dsh-terminal-panel"
npm install --legacy-peer-deps
npm run typecheck
```

Alternative for maintainers with a DSH source checkout: symlink the Harness
packages into the plugin’s `node_modules` so they resolve to the **same
realpath** as the Host (the pattern in
`dsh-better-display/scripts/link-harness-dependencies.mjs`). Do not symlink to
an extracted copy under `%TEMP%`: the realpath differs from the Host module, so
you reintroduce duplicate module identity. The separate typecheck project is
simpler and has no runtime path at all.

If npm is unavailable, a fallback is to copy the extracted `lib/types`
declarations into `tools/typecheck/types` and point `paths` there; still keep
them outside `packages/dsh-terminal-panel`. It is brittle across DSH versions.

---

## 10. Install / dev loop (exact Windows commands)

### 10.1 The CLI

Use the Desktop-installed CLI; it is the same launcher that owns the reserved
`desktop` profile:

```powershell
$dsh = 'D:\DSH\resources\runtime\cli\bin\dsh.cmd'
& $dsh --version
# 0.2.1-rc.2
```

`dsh.cmd` runs the bundled Electron with `ELECTRON_RUN_AS_NODE=1` and
`@deepseek-ai/dsh-desktop-host/lib/cli.js`
(`D:\DSH\resources\runtime\cli\bin\dsh.cmd`). The desktop host passes
`manageDesktopProfile: true`, which is what allows `--profile desktop` plugin
operations (`dsh-desktop-host/lib/cli.js:94-104`).

### 10.2 Create an isolated Web dev profile (recommended)

Do **not** test in the running Desktop profile first. Create a separate
`webdev` profile from the shipped `web` template:

```powershell
# First run creates the profile from the web template and boots it.
# Use --no-open and a non-default port; Ctrl+C after the URL line appears.
& $dsh --profile webdev --from-default-profile web --no-open --port 59080
```

Important: `--from-default-profile web` **replaces** the custom profile with a
fresh copy of the shipped template every time it is passed
(`dsh/lib/bin.js:105`, option help). Use it only for the initial creation (or
when you intentionally reset the profile). Later boots are:

```powershell
& $dsh --profile webdev --no-open --port 59080
```

If the profile directory is missing, `dsh plugin --profile webdev add …`
creates a **base-only** profile (`DEFAULT_PROFILE_BUNDLES =
["@deepseek-ai/dsh-base"]`, `dsh-app-boot/lib/index.js:551-570`), not a Web
profile. That is why the template creation step comes first.

### 10.3 Install the plugin as a link

From the workspace that contains the plugin package:

```powershell
& $dsh plugin --profile webdev add "link:C:\Users\LANCANG\Desktop\Code\DSH Plugs\dsh-live-terminal\packages\dsh-terminal-panel"
```

What this does:

- forwards the arguments to pnpm in the profile directory
  (`dsh/lib/plugin-BiveYA7h.js:63-98`; `dsh plugin --profile <name> <pnpm args>`);
- adds `dsh-terminal-panel` to the profile `dependencies` as a `link:` spec;
- because the package declares `dsh.bundle.patch`, appends it to
  `dsh.profile.bundles` (`dsh-plugin-manager/README.md`, “Install”);
- the profile’s runtime resolution sees the linked package and its `lib/*.js`
  (`dsh-app-boot/lib/index.js:499-503`).

Inspect the profile after install:

```powershell
Get-Content "$env:USERPROFILE\.dsh\profiles\webdev\package.json" -Raw
Get-Content "$env:USERPROFILE\.dsh\profiles\webdev\cordis.patch.yml" -Raw
```

Expected `package.json` shape:

```json
{
  "name": "dsh-profile-webdev",
  "private": true,
  "dependencies": {
    "dsh-terminal-panel": "link:C:\\Users\\LANCANG\\Desktop\\Code\\DSH plugin\\packages\\dsh-terminal-panel"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-terminal-panel"
      ]
    }
  }
}
```

If the CLI’s pnpm cannot handle a `link:` path with spaces, the manual fallback
is to add the dependency + bundle list yourself and run the installation
package manager in the profile directory (the Desktop `dsh plugin` command
already uses the correct bundled package manager; prefer fixing quoting over
hand-editing).

### 10.4 Run the dev host

```powershell
& $dsh --profile webdev --no-open --port 59080
```

- The CLI prints a `dsh web:` line with a **process token**; open that URL once.
  The token exchanges for a signed cookie and redirects to a clean `./`.
- The dev host uses the `webdev` profile, not `desktop`, so it does not disturb
  the running Desktop app. It listens on a different port.
- The dev host and the Desktop app share `$DSH_HOME` (credentials, sessions),
  but not the profile composition. Be careful not to run destructive commands
  against the same workspace from two agents.
- If `--port 59080` is occupied, choose another port. `--host` accepts one
  concrete local IP; wildcard binds are rejected.

### 10.5 Rebuild / reload loop

```powershell
cd "C:\Users\LANCANG\Desktop\Code\DSH Plugs\dsh-live-terminal\packages\dsh-terminal-panel"
npm install --legacy-peer-deps   # once: build tools + xterm; do NOT install host peers
npm run build                    # host tsc + client esbuild
```

Then pick one:

- **Restart the dev host** (most reliable): Ctrl+C, re-run the `dsh --profile
  webdev …` command. A PTY is process-local; restarting closes all terminals.
- **HMR profile recomposition**: `dsh-hmr` watches the profile `package.json`
  and both patch files. Rebuilding a linked package does not by itself emit a
  change event for those files; a profile recomposition compares the files of
  linked package targets and replaces plugins whose loaded files changed
  (`dsh-hmr/README.md`, “Profile recomposition”). Touch/edit
  `~/.dsh/profiles/webdev/cordis.patch.yml` (even a comment) to trigger a
  recomposition, or use the Plugin Manager UI. Expect the plugin to unload and
  reload, which closes its PTYs.
- **Client bundle**: after `npm run build:client`, reload the browser page.
  The client module graph can pick up a new revision through `/plugins/events`,
  but a full reload is the only guaranteed path for a replaced bundle and is
  required when a changed chunk/ID is involved (`dsh-client-modules/README.md`,
  “Boot manifest injection” / “Known Limitations”).
- **Host source watching**: the base profile’s `hmr` config is `root: []`
  (module source watching disabled) unless the profile patch enables it. Do not
  rely on editing `.ts` files being live. `tsc` output changes are what the
  profile compares.

### 10.6 Test the Desktop profile

Once the isolated Web profile works:

```powershell
# Fully quit the Desktop app first if you want the least surprising result.
& $dsh plugin --profile desktop add "link:C:\Users\LANCANG\Desktop\Code\DSH Plugs\dsh-live-terminal\packages\dsh-terminal-panel"
```

Then start DSH Desktop. The Desktop profile is reserved and managed by the
Electron application (`dsh/lib/bin.js:35-37` rejects it in the npm CLI; the
Desktop carrier allows it). Prefer the GUI’s **Plugins** page for install /
enable / disable when the app is running; it uses the same operations and
avoids concurrent profile writers.

### 10.7 Smoke-test checklist

Without a model (proves A + transport):

1. Open the dev URL; confirm the bottom panel toggle is visible.
2. Click **New terminal**; confirm a PowerShell prompt appears.
3. Type `Get-Location`, `dir`, `Get-ChildItem`; confirm echo and output.
4. Resize the browser window; confirm the xterm refits (the Host receives a
   resize and the shell redraws).
5. Reload the page; confirm the panel reconnects and receives a snapshot
   (the Host PTY survives a browser reload because it is process-local and
   independent of the page).
6. Run `curl.exe -i http://127.0.0.1:59080/dsh-terminal-panel/events` in a
   second shell **without** the cookie; confirm 401/403, not a stream.

With a model (proves B + C):

7. Ask: “Use live_terminal_run to run `Get-Process | Select-Object -First 5`
   and show me the screen.” Confirm the command appears in the panel live and
   the tool result contains the screen text.
8. Ask: “Use live_terminal_screenshot on the current screen.” Confirm the
   result text matches the visible screen; if the model is image-capable and
   the optional PNG path is enabled, confirm the image block.
9. Start a TUI (`vim`, `htop`, `Get-Process` pager); screenshot again; confirm
   the text grid reflects the alternate buffer.
10. Close the plugin / restart the Host while a terminal is running; confirm
    the process is terminated (check `Get-Process pwsh`) and the panel shows a
    reconnect/ended state.

### 10.8 Uninstall

```powershell
& $dsh plugin --profile webdev remove dsh-terminal-panel
```

The plugin manager deselects the bundle, stops it, then runs pnpm remove
(`dsh-plugin-manager/README.md`, “Failure behavior”). If the profile is broken,
remove the dependency and bundle entry manually and run pnpm install.

---

## 11. Pitfalls / risks / do-nots

### 11.1 Client bundle and module system

1. **React must be external.** Bundling a second React copy breaks hooks
   (`useState` of one React instance on a component rendered by another). The
   platform seed table provides React; keep `react`, `react/jsx-runtime`,
   `react-dom`, `react-dom/client` in `external`.
2. **No `react-dom` needed** for a slot component; the shell renders it. Do not
   create a second root.
3. **The client bundle must be prebuilt.** `lib/client.js` is served as-is; a
   missing bundle fails activation with a build instruction
   (`dsh-client-modules/README.md`, “Build requirements”). There is no runtime
   TSX loader in the Web host.
4. **`dsh.client.external` is not a dependency list.** It must contain only
   exact non-baseline module requests that another graph row answers. Self,
   missing supplier, and synchronous cycle are rejected
   (`dsh-client-modules/lib/index.js:414-445`).
5. **`dsh.client.inject` is not Cordis injection.** Use the module’s
   `export const inject` for services.
6. **No synchronous require of relative chunks.** A chunk is self-contained;
   use `require.async`.
7. **Do not use `modules.importChunk()`.** It is private in the type surface
   (`dsh-client-modules/lib/types/client/system.d.ts:68`); it works today but
   is not a contract.
8. **CSS modules are build-time only.** The runtime sees a JS object + an
   injected `<style>`; do not `import './x.css'` expecting Vite to handle it.
9. **`require` resolution order** is platform seed → memoized → graph rows →
   registered factories. A typo produces “missed the module table” at
   materialization, after the page boot screen.
10. **HMR is not a bundler.** Rebuilding client code does not automatically
    rebuild or reload it; page reload is the reliable path.

### 11.2 UI

11. **`shell.bottom` is single.** Another plugin can occupy it; registration
    at the same priority throws. Check `ctx.slots.entries('shell.bottom')` and
    fall back to `shell.overlay`/right sidebar.
12. **Hidden xterm measures 0×0.** Do not call `fit()` while `display:none`;
    fit on open and on resize.
13. **Bottom slot has no session binding.** `PropsRuntime<'shell.bottom'>` has
    global props only. Do not expect a `sessionId`; key the panel by the active
    terminal id or fetch the session selection from the workspace/sidebar
    service (verify the exact service; it is not part of `useSessions`).
14. **`shell.overlay` is click-through.** Set `pointerEvents: 'auto'` on your
    floating root, or the toggle is unclickable.
15. **The panel persists across navigation**; do not tear down SSE on every
    conversation render. Keep the EventSource in a component that stays
    mounted (the dock itself).
16. **EventSource reconnects automatically**; the server must send a snapshot
    on every new connection. Do not assume sequence continuity.
17. **Multiple tabs** each open their own SSE client. Input from two tabs races;
    either accept last-writer-wins or add a “control” token in the UI.
18. **Use the CSS token fonts**, not a hard-coded `monospace` only; the
    Settings terminal font and `--dsh-terminal-font-size` should be honored for
    consistency with the official terminal. xterm measures glyphs in a canvas
    context, where `var(--…)` does not resolve: read the computed family/size
    from `getComputedStyle(document.body)` and pass concrete values; update or
    recreate the terminal when the theme/font changes.

### 11.3 Host / PTY

19. **`handle.output` is a `Readable`, not a typed async iterable.** Attach one
    consumer; do not also `pipe()` it elsewhere.
20. **Serialize writes.** The UI and the Agent both write; without a queue,
    ANSI sequences can interleave with command text.
21. **Wait for xterm to process before broadcasting a sequence.** Otherwise a
    reconnecting client can receive a snapshot older than a delta it already
    saw.
22. **Idle is not exit.** On Windows there is no exact stdin-wait tier; a quiet
    screen may be a running command waiting for input. Return `wait:
    'timeout'` rather than claiming completion when the deadline hits.
23. **Do not use `shellActivity: true` on Windows**; activity is `unknown`, and
    the local provider’s shell hooks are bash/zsh/POSIX-specific.
24. **Sandbox is the plugin’s job.** `spawnTerminal` does not confine by
    itself; call `sandboxPolicy.resolve` + `sandbox.confine` exactly like
    terminal-bash, or explicitly run unconfined and label it.
25. **Sandbox mode changes** while a PTY is open must close/reopen or refuse
    input; do not let a terminal outlive its policy.
26. **A user terminal is unsandboxed.** That matches the official user
    terminal, but it must be a separate, labeled owner; never let an Agent tool
    silently use it.
27. **`terminate()` is async and whole-session.** Await it on plugin
    dispose/HMR; otherwise a pwsh tree survives and the next reload has no
    screen mirror.
28. **Do not persist terminal ids.** PTYs die with the Host process; a saved id
    is stale after restart.
29. **Windows ConPTY assets** are owned by the installation’s node-pty; do not
    bundle a second node-pty or copy the prebuilds.
30. **`SIGTSTP`/`SIGHUP` are unsupported on Windows**; Ctrl-Z won’t suspend a
    pwsh process the way it does on POSIX.

### 11.4 Tools / prompt

31. **Tool schemas are model-visible and cached.** Adding/removing tools changes
    the prompt/tool prefix and can invalidate KV cache; register once at plugin
    startup, not per call.
32. **`timeoutMs` is declarative only.** If you need a hard deadline, the
    composition must mount `dsh-tool-call-timeout-policy`; otherwise implement
    your own `exec.signal` handling (our `waitForQuiet` does).
33. **`presentCall`/`presentResult` are not consumed by the Web Client.**
    Register `tool.call.toolview` if you need a custom card.
34. **Image blocks need an attachment ref**, not base64. Store with
    `attachments.saveImage`, then render `{ type: 'image', attachment: ref }`.
35. **Text-only models** project images to placeholders; prefer returning text
    unless the active route accepts images.
36. **Names can collide** with the official `terminal_*` tools or a fork; prefix
    and check `ctx.tools.get`.
37. **Prompt sections repeat every request.** Keep the guidance short; a long
    section costs tokens on every turn.
38. **Skill names are kebab-case and first-wins per layer.** A duplicate returns
    a no-op disposer, not an error.

### 11.5 Packaging / install

39. **Never install `@deepseek-ai/dsh-*` as dependencies *or* devDependencies
    of the linked package.** The profile runtime already supplies them; a
    second copy of `dsh-tools` is known to break all tool calls
    (`research/existing-plugins.md:239`). Use `peerDependencies` + 
    `npm install --legacy-peer-deps`, and put type-only declarations in a
    separate `tools/typecheck` project outside the plugin’s resolution
    ancestry (§9.6).
40. **`engines.dsh` is enforced at install/startup.** Use the exact running
    version for local dev; a mismatch requires an exemption
    (`dsh-plugin-manager` “Version compatibility”).
41. **`--from-default-profile` wipes the custom profile.** Do not leave it in
    the dev command after the first creation.
42. **`dsh plugin` requires the profile to exist or auto-creates base-only.**
    Create the Web template first.
43. **Desktop package operations** belong to the Desktop shell when the app is
    running; prefer the Plugins page or quit the app before CLI installs.
44. **Linked package rebuilds need a recomposition or restart.** HMR compares
    loaded files at a recomposition; it does not watch arbitrary source.
45. **A plugin that serves custom HTTP routes adds attack surface.** Always call
    `ctx.connection.admit`; never trust `terminalId` from an Agent tool body.

### 11.6 Security

46. **The terminal is arbitrary code execution.** It is exactly as powerful as
    the user’s shell. The only boundary is the sandbox policy; do not market it
    as a security feature.
47. **Do not log PTY output or commands by default.** They can contain secrets.
    `ctx.logger` diagnostics should name ids/states, not content.
48. **SSE payloads are visible to any authenticated page.** Treat terminal
    output as sensitive; do not add cross-origin permissive headers.
49. **Tool arguments are model-controlled.** Validate `cwd` against the
    session/workspace, bound `wait_ms`/`idle_ms`, and never pass raw command
    strings through a shell wrapper.
50. **Profile plugins run in-process outside the workspace file sandbox**
    (`dsh-plugin-manager/README.md`: “installed Host code executes in-process
    outside the workspace sandbox”). Review any third-party plugin before
    installing it; this is also why the plugin must not fetch/execute remote
    code at runtime.

---

## 12. Open questions / risks

1. **Bottom-slot fit under the Windows titlebar.** `shell.bottom` is below the
   three columns, but the frame reserves the caption strip; test the dock at
   100%, 125%, and 150% DPI and with the right sidebar fullscreen. The layout
   README documents `--dsh-frame-top-clearance` and Windows
   `data-windows-titlebar`; the bottom seat should not need it, but verify.
2. **Idle detection on Windows.** A command that prints nothing (`cd`,
   `Set-Location`) settles only after `idleMs`; a command waiting on stdin also
   looks idle. Consider installing a prompt marker
   (`dsh-terminal-bash` exports `PWSH_PROMPT_SETUP`) or using
   `inspectForeground()`/`inspectActivity()` where supported, and document the
   heuristic. This is the biggest correctness risk for `live_terminal_run`.
3. **Sandbox mode change semantics.** Close/reopen vs. refuse writes vs. fence
   the mode change; the official backend fences, which requires intercepting
   `session/event` before the mode commits. A simpler close-on-change may
   surprise the user. Decide before v1.
4. **User terminal authority.** Should an Agent tool be able to write to a
   user-created terminal? If yes, ownership/isolation weakens; if no, the UI
   needs a clear “Agent terminals” vs “My terminals” split.
5. **PNG dependency.** `sharp` is native and ABI-coupled; `@resvg/resvg-js` is
   another native option; a pure-JS rasterizer needs a font parser. Text-first
   is safe. If PNG is mandatory, prefer the browser canvas route over adding a
   native dependency, at the cost of requiring an open page.
6. **Image-capable route detection.** Reuse `read_image`’s `ctx.llm` check or
   return text + PNG and let `dsh-llm` project a placeholder. The former is
   cleaner but couples to model-selection internals.
7. **Reverse-proxy prefix.** Absolute custom routes work with prefix-stripping
   proxies but not with a non-stripping sub-path mount. Confirm the deployment
   target; if needed, make the route path and client base configurable.
8. **Bottom slot ownership.** If another plugin already occupies
   `shell.bottom`, fall back cleanly; do not shadow it at a lower priority
   without the user’s knowledge.
9. **Selected session.** `useSessions` is the list, not the selection. If
   per-session terminals are required, identify the workspace/sidebar selection
   service (or register a right-sidebar tab, which is session-scoped) instead
   of guessing.
10. **HMR reload kills PTYs.** During development, every host reload loses the
    screen; that is expected. In production, a plugin update restarts the
    plugin and closes its terminals; warn in the UI/README.
11. **Multiple Agents.** Per-Agent terminals are isolated, but the panel shows
    one at a time. A dropdown/list is enough for v1; multi-pane/tabs are a
    larger UI project.
12. **Output volume.** A very chatty command can flood the SSE fan-out and the
    headless xterm. Use a bounded per-client queue, a bounded scrollback, and a
    `maxResultBytes` cap; consider coalescing deltas at ~60 Hz for the browser
    while still feeding xterm every chunk.
13. **`dsh.client.inject` ordering.** If the layout/session rows are absent
    (custom minimal composition), `ctx.slots.inject('shell.bottom')` simply
    never runs; the plugin should degrade without failing the whole host. Test
    with `@deepseek-ai/dsh-base` only.
14. **Tool schema cost.** Four tools with rich descriptions add fixed tokens per
    request. If the deployment uses PTC mode, only `run_code` is visible and
    the generated SDK includes these definitions; test both `native` and `ptc`
    presentations.
15. **Cross-platform shells.** This blueprint targets Windows/pwsh; POSIX
    needs `-i`, no `-NoLogo`, and different readiness. The code paths are
    already parameterized; do not assume `pwsh` exists on macOS/Linux.

---

## 13. File / line citation index

Paths are absolute where they are outside the workspace; `%TEMP%` is
`C:\Users\LANCANG\AppData\Local\Temp`. Official extracted packages are under
`%TEMP%\dsh-sdk\pkg\`; the npm type tarballs extracted during this research are
under `%TEMP%\dsh-npm-types\`.

### 13.1 Plugin contract / loading

| Claim | Evidence |
|---|---|
| Bundle patch + client declaration in a real plugin | `C:\Users\LANCANG\.dsh\profiles\desktop\node_modules\dsh-better-display\package.json:20-40` |
| Bundle patch file format | `...\dsh-better-display\cordis.patch.yml:1-4`; `...\dsh-context\cordis.patch.yml`; `...\dshmarket\cordis.patch.yml` |
| `dsh.bundle.patch` type | `%TEMP%\dsh-npm-types\dsh-package-manifest\package\lib\types\types.d.ts:65-69` |
| `dsh.client` fields (`platform`, `inject`, `immediately`, `external`) | same file `:75-89` |
| Host client-module scan / `exports "./client"` requirement | `%TEMP%\dsh-sdk\pkg\dsh-client-modules\lib\index.js:720-746` |
| Client graph row / ordering / cycle rejection | `...\dsh-client-modules\lib\index.js:402-446` |
| `dsh.client.inject` is module arrival, not services | `...\dsh-client-modules\lib\client.js:776-793`; manifest type `:79-80` |
| Client bundle registration / factory / require.async | `%TEMP%\dsh-npm-types\dsh-client-modules\package\lib\types\client\manifest.d.ts:187-206` |
| Platform seed table | `%TEMP%\dsh-sdk\pkg\dsh-web-frontend\dist\assets\index-CN7NIWNw.js` (minified line 190, `SZ()` near `__ModuleLoader__`) |
| Bundle wrapper example | `%TEMP%\dsh-sdk\pkg\dsh-client-ui-sidebar-terminal\lib\client.js:1-10`; chunk: `...\lib\client.terminal.js:1-6` |
| Runtime module resolution (installation packages) | `%TEMP%\dsh-sdk\pkg\dsh-app-boot\lib\index.js:499-503, 715-760` |
| Profile templates / default bundles | `...\dsh-app-boot\lib\index.js:551-570` |
| `--from-default-profile` semantics | `%TEMP%\dsh-sdk\pkg\dsh\lib\bin.js:39-49, 105` |
| Desktop CLI allows reserved profile | `%TEMP%\dsh-sdk\pkg\dsh-desktop-host\lib\cli.js:94-104`; `bin\dsh.cmd` |
| Plugin CLI forwards to pnpm | `%TEMP%\dsh-sdk\pkg\dsh\lib\plugin-BiveYA7h.js:63-98` |

### 13.2 UI / slots

| Claim | Evidence |
|---|---|
| Slot kind/scope vocabulary | `%TEMP%\dsh-npm-types\dsh-client-ui-slots\package\lib\types\index.d.ts:82-85` |
| `ctx.slots.register` overloads / validation / disposer | same file `:793-808`; `%TEMP%\dsh-npm-types\dsh-client-ui-renderer\package\lib\types\client\registry.d.ts:85, 96-111` |
| `shell.bottom` single/root, height/visibility contract | `%TEMP%\dsh-npm-types\dsh-client-ui-layout\package\lib\types\client\index.d.ts:75-84` |
| Frame renders `shell.bottom` / `shell.overlay` | `%TEMP%\dsh-sdk\pkg\dsh-client-ui-layout\lib\client.js:313, 347, 639-648` |
| `shell.overlay` click-through list | layout type `:85-98` |
| Right sidebar tab type fields | `%TEMP%\dsh-npm-types\dsh-client-ui-sidebar-right\package\lib\types\client\tab-registry.d.ts:74-120` |
| Right sidebar `openTab` / `float` | `%TEMP%\dsh-npm-types\dsh-client-ui-sidebar-right\package\lib\types\client\service.d.ts:131-205` |
| Official terminal registration example | `%TEMP%\dsh-sdk\pkg\dsh-client-ui-sidebar-terminal\lib\client.js:438-490` |
| `useTabInfo` / tab actions | `%TEMP%\dsh-npm-types\dsh-client-ui-sidebar-right\package\lib\types\client\contract\slots.d.ts:113-203` |
| Global standard props (`useSessions`) | `%TEMP%\dsh-npm-types\dsh-client-ui-session\package\lib\types\client\index.d.ts:68-99` |
| Store handle / `PropsStore` / `defineStore` | `%TEMP%\dsh-npm-types\dsh-client-store\package\lib\types\contract.d.ts:73-121` |
| Shared store across two same-scope seats | `%TEMP%\dsh-sdk\pkg\dsh-client-ui-sidebar-right\README.md` (“The expand button”) |

### 13.3 Transport / auth

| Claim | Evidence |
|---|---|
| HTTP routes / upgrade routes | `%TEMP%\dsh-npm-types\dsh-host-webserver\package\lib\types\index.d.ts:31-46` |
| `/api` route calls `connection.admit` | `%TEMP%\dsh-sdk\pkg\dsh-client-connection\lib\index.js:1049-1058` |
| `admit` implementation | same file `:742-752` |
| `PeerAdmission` / `ConnectionAdmission` | `%TEMP%\dsh-npm-types\dsh-client-connection\package\lib\types\rpc.d.ts:93-106` |
| Cookie / launch token / trust fence | `%TEMP%\dsh-sdk\pkg\dsh-client-connection\README.md` (“Browser authentication and request trust”) |
| SSE is excluded from compression | `%TEMP%\dsh-sdk\pkg\dsh-host-webserver\README.md` (“Minimal configuration”) |
| Official SSE/WebSocket status quo | `%TEMP%\dsh-sdk\pkg\dsh-client-modules\README.md` (“Incremental composition”, `/plugins/events`) |

### 13.4 Tools / prompt / skills

| Claim | Evidence |
|---|---|
| `defineTool` / output DSL | `%TEMP%\dsh-sdk\pkg\dsh-tools\lib\index.js:838-878`; `%TEMP%\dsh-npm-types\dsh-tools\package\lib\types\schema.d.ts:178-248` |
| `ToolRunContext` fields (`agent`, `signal`, `callId`) | `%TEMP%\dsh-npm-types\dsh-tools\package\lib\types\index.d.ts:216-322` |
| Web Client ignores Host presenters | `%TEMP%\dsh-sdk\pkg\dsh-tools\README.md` (“Host presentation descriptors”) |
| Tool card registration | `%TEMP%\dsh-sdk\pkg\dsh-client-ui-tool\README.md` (“Registering a business tool view”) |
| Persistent terminal tool set / guidance | `%TEMP%\dsh-sdk\pkg\dsh-tool-terminal\lib\index.js:145-264` |
| Prompt section type / `TOOL_PTY` order | `%TEMP%\dsh-npm-types\dsh-system-prompt\package\lib\types\index.d.ts:47-70, 119-154` |
| Skill registration type | `%TEMP%\dsh-npm-types\dsh-skill\package\lib\types\index.d.ts:44-84`; registry `lib/index.js:193-214` |
| Base composition mounts skills/system-prompt/attachments | `%TEMP%\dsh-sdk\pkg\dsh-base\cordis.patch.yml:146-147, 308-315, 504-505` |

### 13.5 PTY / screen / attachments

| Claim | Evidence |
|---|---|
| `spawnTerminal` spec / handle | `%TEMP%\dsh-npm-types\dsh-subprocess\package\lib\types\types.d.ts:198-278` |
| Local provider spawn / ConPTY / assets | `%TEMP%\dsh-sdk\pkg\dsh-subprocess-local\lib\index.js:1618-1680`; `...\README.md` (“Running terminal sessions”, “Windows limitations”) |
| Sandbox spawn pattern | `%TEMP%\dsh-sdk\pkg\dsh-terminal-bash\lib\index.js:1047-1065`; `:950-970` |
| Sandbox policy resolve / confine | `%TEMP%\dsh-npm-types\dsh-sandbox-policy\package\lib\types\index.d.ts:49-88`; `%TEMP%\dsh-npm-types\dsh-sandbox\package\lib\types\index.d.ts:19-57, 127-141` |
| Official headless xterm + serialize | `%TEMP%\dsh-sdk\pkg\dsh-api-terminal-controller\lib\types\terminal.js:7-37, 76-82`; package versions `%TEMP%\dsh-sdk\pkg\@xterm__headless\package.json`, `...\@xterm__addon-serialize\package.json` |
| `ctx.terminals` read is line-oriented | `%TEMP%\dsh-npm-types\dsh-terminal\package\lib\types\types.d.ts:91-109` |
| `BrowserTerminal.attach` needs Remote invocation | `%TEMP%\dsh-sdk\pkg\dsh-api-terminal-controller\lib\types\terminal.js` (`attach`) and `lib\index.js` (`TerminalController.attach`); README “Use this package” |
| `read_image` image value/render pattern | `%TEMP%\dsh-sdk\pkg\dsh-tool-fs\lib\index.js:928-975, 1027-1055` |
| `ContentBlock` / `ImageBlock` | `%TEMP%\dsh-npm-types\dsh-llm\package\lib\types\types.d.ts:55-126` |
| Attachment `saveImage` / ref | `%TEMP%\dsh-npm-types\dsh-attachment\package\lib\types\types.d.ts:5-28, 115-121` |
| Windows SIGINT / readiness / ConPTY assets | `%TEMP%\dsh-sdk\pkg\dsh-subprocess-local\README.md` (“Windows terminal signalling is console-wide”, “Windows terminal allocation…”, “Windows readiness…”) |

### 13.6 Build / dev / HMR

| Claim | Evidence |
|---|---|
| DSHX/tsdown client adapter is external | `C:\Users\LANCANG\.dsh\profiles\desktop\node_modules\dsh-better-display\tsdown.config.ts:17-26` |
| Official client wrapper format | sidebar terminal `lib/client.js:1-10`; chunk `lib/client.terminal.js:1-6` |
| Client bundle must be prebuilt | `%TEMP%\dsh-sdk\pkg\dsh-client-modules\README.md` (“Build requirements”) |
| HMR profile recomposition / linked files | `%TEMP%\dsh-sdk\pkg\dsh-hmr\README.md` (“Use this package”, “Understand the implementation”) |
| HMR `root: []` default | `...\dsh-hmr\README.md` (“Configuration”) |
| Profile files (live example) | `C:\Users\LANCANG\.dsh\profiles\desktop\package.json:1-22`; `...\cordis.patch.yml:1-32` |

---

## 14. Minimal end-to-end host skeleton

This is the wiring shape; the detailed classes are in §5–§8.

```ts
// src/index.ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-client-connection'
import z from '@deepseek-ai/schemastery'
import { LiveTerminalRegistry } from './live-terminal.js'
import { registerRoutes } from './routes.js'
import { registerTools } from './tools.js'
import { registerSkill } from './skill.js'

export const name = 'dsh-terminal-panel'
export const inject = ['tools', 'subprocess', 'systemPrompt', 'workingDirectory', 'sandboxPolicy']

export const Config = z.object({
  shellPath: z.string(),
  shellArgs: z.array(z.string()).default([]),
  cols: z.number().step(1).min(2).max(500).default(120),
  rows: z.number().step(1).min(1).max(200).default(30),
  maxCols: z.number().step(1).min(2).max(500).default(500),
  maxRows: z.number().step(1).min(1).max(200).default(200),
  scrollback: z.number().step(1).min(0).max(10_000).default(1_000),
  disposeGraceMs: z.number().step(1).min(100).default(3_000),
  idleMs: z.number().step(1).min(50).max(10_000).default(350),
  maxWaitMs: z.number().step(1).min(100).max(600_000).default(30_000),
  maxResultBytes: z.number().step(1).min(1_024).default(262_144),
  allowUserTerminal: z.boolean().default(true),
})

export function apply(ctx: Context, config: z.infer<typeof Config>): void {
  const live = new LiveTerminalRegistry(ctx, config)
  ctx.effect(() => () => live.dispose(), 'dsh-terminal-panel: terminals')

  registerTools(ctx, live, config)

  ctx.inject(['webServer', 'connection'], (webCtx) => {
    registerRoutes(webCtx, live, config)
  })

  ctx.inject(['skills'], (skillCtx) => {
    skillCtx.effect(() => registerSkill(skillCtx), 'dsh-terminal-panel: skill')
  })

  ctx.systemPrompt.section({
    name: 'tool:live-terminal',
    order: ctx.systemPrompt.getSectionOrder('TOOL_PTY'),
    text:
      'A visible terminal panel mirrors a real PTY that the user can watch. ' +
      'Use live_terminal_run when the user should see progress, when a command needs interactive stdin, ' +
      'or when the rendered screen matters. Use live_terminal_screenshot to inspect the current screen; ' +
      'prefer its text grid and request PNG only for image-capable models.',
  })

  ctx.logger.info('[dsh-terminal-panel] loaded')
}
```

```ts
// src/routes.ts — registration list
export function registerRoutes(ctx: Context, live: LiveTerminalRegistry, config: LiveConfig): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-terminal-panel/events',
    handler: (req, res) => handleEvents(ctx, live, req, res),
  }), 'dsh-terminal-panel: events')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-terminal-panel/input',
    handler: (req, res) => handleInput(ctx, live, req, res),
  }), 'dsh-terminal-panel: input')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-terminal-panel/sessions',
    handler: (req, res) => handleSessions(ctx, live, req, res),
  }), 'dsh-terminal-panel: sessions')
}
```

`ctx` inside `registerRoutes` is the `webCtx` from `ctx.inject(['webServer',
'connection'], ...)`; its type includes both services after the augmentation
import (`import type {} from '@deepseek-ai/dsh-client-connection'` and
`import type {} from '@deepseek-ai/dsh-host-webserver'`). These type-only
imports are erased at build time and create no module-table request; they exist
only so `tsc` sees `ctx.webServer`, `ctx.connection`, `ctx.tools`,
`ctx.systemPrompt`, `ctx.skills`, etc.

```ts
// src/tools.ts — registration list
export function registerTools(ctx: Context, live: LiveTerminalRegistry, config: LiveConfig): void {
  ctx.tools.register(openTool(live, config))
  ctx.tools.register(runTool(live, config))
  ctx.tools.register(sendTool(live, config))
  ctx.tools.register(screenshotTool(live, config, ctx))
}
```

Each `*Tool` returns `defineTool({...})`; `screenshotTool` closes over `ctx`
only to reach `ctx.get('attachments')`.

---

## 15. Verification spikes (do these before writing the full plugin)

1. **Client shell spike (half day).** Hand-write a 20-line `lib/client.js` that
   registers a colored `shell.bottom` div and a `shell.overlay` button using
   the exact wrapper. Install into `webdev`, confirm both render and no
   “missed the module table” error. This validates the build/format before any
   xterm work.
2. **Transport spike (half day).** Add `/ping` and `/events` routes; confirm
   `curl` without a cookie gets 401, the browser EventSource gets 200 and
   heartbeats, and a browser `fetch` POST reaches the handler. This validates
   `admit` and SSE buffering.
3. **PTY spike (one day).** On the Host, spawn pwsh with `spawnTerminal`, feed
   output to `@xterm/headless`, expose `snapshot()` over SSE, and render it in
   xterm. Test `Get-Location`, `dir`, a TUI, resize, and reload.
4. **Tool spike (half day).** Register only `live_terminal_run` with the schema
   in §6.3; run one command from the Agent; confirm the panel shows it live and
   the result text matches the screen.
5. **Screenshot spike (half day).** Add `live_terminal_screenshot` text; then
   optional PNG via `sharp`; verify attachments and image blocks on an
   image-capable model.
6. **Failure spikes (half day).** Kill the browser mid-command; restart the
   Host; unload/reload the plugin; deny writes under `read-only`; confirm no
   orphan pwsh processes and clear errors.

If spike 1 or 2 fails, stop and fix the contract before building the terminal;
those are the two “unknowns” that can invalidate the whole design.

---

## 16. Bottom line

- **A (visible interactive terminal)**: own xterm in `shell.bottom`, PTY via
  `ctx.subprocess.spawnTerminal`. This is the most robust and gives one shared
  PTY for the UI and the Agent.
- **B (agent commands live in that panel)**: `live_terminal_*` tools write to
  the same `LiveTerminal`; output fans out over SSE. The stock `bash`/`pwsh`
  tools are not intercepted — guide the Agent with the prompt section + skill,
  or replace those tools in a fork if absolute coverage is required.
- **C (screenshot)**: headless xterm mirror → text grid + ANSI immediately;
  optional Host SVG→PNG → `ctx.attachments.saveImage` → image block. Text first
  is reliable; PNG is an optional layer with an ABI/font risk.
- **Packaging**: dual-face bundle with `dsh.bundle.patch` + `dsh.client`;
  prebuilt `lib/client.js` in the exact `__ModuleLoader__` format; install with
  `dsh plugin --profile webdev add link:…`; test on an isolated `webdev`
  profile before touching the Desktop profile.

