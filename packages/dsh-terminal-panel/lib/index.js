/**
 * dsh-terminal-panel — host half.
 *
 * A Cordis plugin that owns real PTY terminals (interactive shells and visible
 * one-shot commands), mirrors their screens with `@xterm/headless`, streams
 * them to the browser over authenticated HTTP/SSE, exposes seven
 * `live_terminal_*` tools to the model, and mirrors built-in `pwsh`/`bash`
 * foreground calls into the visible panel.
 *
 * This half must not import `@deepseek-ai/*` modules: the plugin lives outside
 * the harness package tree. Every capability is consumed through runtime
 * services (`ctx.get`, `ctx.inject`, `ctx.on`, `ctx.tools.register`,
 * `ctx.systemPrompt`).
 *
 * Safe degradation: tools and shell interception are registered even when the
 * `webServer` or `connection` services are absent (e.g. an embedded profile
 * without the Web GUI); HTTP/SSE routes are only registered when both exist.
 */

import { registerIntercept } from './host/intercept.js'
import { registerPrompt } from './host/prompt.js'
import { TerminalRegistry } from './host/registry.js'
import { registerRoutes } from './host/routes.js'
import { registerTools } from './host/tools.js'

export const name = 'dsh-terminal-panel'

/** Services that must exist before this plugin activates. */
export const inject = ['tools']

/** Default plugin configuration. */
export const DEFAULT_CONFIG = Object.freeze({
  interceptShellTools: true,
  shellPath: undefined,
  scrollback: 2000,
  maxOutputBytes: 262144,
  maxSessions: 16,
  commandTimeoutMs: 180000,
  retainExited: 10,
})

/**
 * Normalise the row config from `cordis.patch.yml` into a complete config.
 * @param {unknown} input raw config.
 * @returns {{ interceptShellTools: boolean, shellPath: string | undefined, scrollback: number, maxOutputBytes: number, maxSessions: number, commandTimeoutMs: number, retainExited: number }} resolved config.
 */
export function resolveConfig(input) {
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  return {
    interceptShellTools: source.interceptShellTools === undefined ? true : source.interceptShellTools === true,
    shellPath: typeof source.shellPath === 'string' && source.shellPath.trim().length > 0 ? source.shellPath.trim() : undefined,
    scrollback: boundInteger(source.scrollback, DEFAULT_CONFIG.scrollback, 0, 100_000),
    maxOutputBytes: boundInteger(source.maxOutputBytes, DEFAULT_CONFIG.maxOutputBytes, 1024, 16 * 1024 * 1024),
    maxSessions: boundInteger(source.maxSessions, DEFAULT_CONFIG.maxSessions, 1, 128),
    commandTimeoutMs: boundInteger(source.commandTimeoutMs, DEFAULT_CONFIG.commandTimeoutMs, 1000, 3_600_000),
    retainExited: boundInteger(source.retainExited, DEFAULT_CONFIG.retainExited, 0, 128),
  }
}

/**
 * Cordis plugin body.
 * @param {any} ctx plugin context.
 * @param {unknown} [config] row config.
 * @returns {void}
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  /** @type {{ config: any, registry: TerminalRegistry | undefined, logger: any }} */
  const plugin = { config: resolved, registry: undefined, logger: ctx.logger }
  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(message)
    } catch {
      // logging must never break activation
    }
  }

  // 1) Model-facing tools (tools service is guaranteed by `inject`).
  registerTools(ctx, plugin)

  // 2) Built-in shell interception (foreground pwsh/bash mirrored into the panel).
  registerIntercept(ctx, plugin)

  // 3) System-prompt guidance (registered once the service exists).
  registerPrompt(ctx)

  // 4) Terminal backend: needs subprocess + workingDirectory.
  const initRegistry = (svcCtx) => {
    if (plugin.registry !== undefined) return
    const registry = new TerminalRegistry({
      subprocess: svcCtx.subprocess,
      workingDirectory: svcCtx.workingDirectory,
      // Resolve the session store lazily: the registry may be constructed
      // before every optional service (notably `sessions`) has been provided,
      // and /create needs it at request time to open in the session workspace.
      getSessionStore: () => ctx.get('sessions'),
      // The live-preferred session corpus also resolves persisted sessions
      // that the GUI lists but that are not live in this Host process.
      getSessionQuery: () => ctx.get('sessionQuery'),
      logger: ctx.logger,
      config: resolved,
    })
    plugin.registry = registry
    svcCtx.effect(
      () => async () => {
        await registry.dispose()
      },
      'dsh-terminal-panel: terminal sessions',
    )
    log('info', `[dsh-terminal-panel] terminal backend ready (shell: ${resolved.shellPath ?? 'auto'}, maxSessions=${resolved.maxSessions})`)
  }
  const subprocess = ctx.get('subprocess')
  const workingDirectory = ctx.get('workingDirectory')
  if (subprocess !== undefined && workingDirectory !== undefined) {
    initRegistry({ subprocess, workingDirectory })
  } else {
    ctx.inject(['subprocess', 'workingDirectory'], initRegistry)
  }

  // 5) HTTP + SSE routes: only when the Web composition is present.
  const webServer = ctx.get('webServer')
  const connection = ctx.get('connection')
  if (webServer !== undefined && connection !== undefined) {
    registerRoutes(ctx, plugin)
  } else {
    ctx.inject(['webServer', 'connection'], (webCtx) => {
      registerRoutes(webCtx, plugin)
    })
  }

  log(
    'info',
    `[dsh-terminal-panel] host half loaded (interceptShellTools=${resolved.interceptShellTools}, routes=${
      webServer !== undefined && connection !== undefined ? 'direct' : 'deferred'
    })`,
  )
}

/**
 * @param {unknown} value candidate integer.
 * @param {number} fallback default.
 * @param {number} min lower bound.
 * @param {number} max upper bound.
 * @returns {number} bounded integer.
 */
function boundInteger(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}
