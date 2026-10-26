/**
 * dsh-live-terminal — host half (v1.2.1).
 *
 * A Cordis plugin that owns real PTY terminals (interactive shells and visible
 * one-shot commands), mirrors their screens with `@xterm/headless`, streams
 * them to the browser over authenticated HTTP/SSE, exposes the
 * `live_terminal_*` tools to the model, and mirrors built-in `pwsh`/`bash`
 * foreground calls into the visible panel.
 *
 * This half must not import `@deepseek-ai/*` modules: the plugin lives outside
 * the harness package tree. Every capability is consumed through runtime
 * services (`ctx.get`, `ctx.inject`, `ctx.on`, `ctx.tools.register`,
 * `ctx.systemPrompt`).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { registerIntercept } from './host/intercept.js'
import { registerPrompt } from './host/prompt.js'
import { TerminalRegistry } from './host/registry.js'
import { registerRoutes } from './host/routes.js'
import { registerTools } from './host/tools.js'

export const name = 'dsh-live-terminal'

/** Services that must exist before this plugin activates. */
export const inject = ['tools']

/**
 * Default plugin configuration (v1.2.1).
 *
 * `retainExited` stays for backward compatibility; `historySize` is the
 * effective closed-command history bound and defaults to a larger value.
 * `autoCloseFailedDelayMs` is deliberately much longer than the success delay:
 * failures are what the user needs to read.
 */
export const DEFAULT_CONFIG = Object.freeze({
  interceptShellTools: true,
  shellPath: undefined,
  scrollback: 2000,
  maxOutputBytes: 262144,
  maxSessions: 16,
  perSessionMaxSessions: 8,
  commandTimeoutMs: 180000,
  retainExited: 10,
  historySize: 20,
  historyPath: undefined,
  historyPersist: true,
  interceptMinVisibleMs: 1500,
  autoCloseCommandDelayMs: 8000,
  autoCloseFailedDelayMs: 30000,
  autoCloseToolTerminals: true,
  autoCloseNotice: 'all',
  requireSandbox: false,
  allowUnconfined: true,
  portDetection: true,
})

/**
 * Normalise the row config from `cordis.patch.yml` into a complete config.
 * @param {unknown} input raw config.
 * @returns {any} resolved config.
 */
export function resolveConfig(input) {
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const historyPath = typeof source.historyPath === 'string' && source.historyPath.trim().length > 0
    ? source.historyPath.trim()
    : source.historyPath === ''
      ? undefined
      : join(homedir(), '.dsh', 'dsh-live-terminal', 'history.json')
  return {
    interceptShellTools: source.interceptShellTools === undefined ? true : source.interceptShellTools === true,
    shellPath: typeof source.shellPath === 'string' && source.shellPath.trim().length > 0 ? source.shellPath.trim() : undefined,
    scrollback: boundInteger(source.scrollback, DEFAULT_CONFIG.scrollback, 0, 100_000),
    maxOutputBytes: boundInteger(source.maxOutputBytes, DEFAULT_CONFIG.maxOutputBytes, 1024, 16 * 1024 * 1024),
    maxSessions: boundInteger(source.maxSessions, DEFAULT_CONFIG.maxSessions, 1, 128),
    perSessionMaxSessions: boundInteger(source.perSessionMaxSessions, DEFAULT_CONFIG.perSessionMaxSessions, 1, 128),
    commandTimeoutMs: boundInteger(source.commandTimeoutMs, DEFAULT_CONFIG.commandTimeoutMs, 1000, 3_600_000),
    retainExited: boundInteger(source.retainExited, DEFAULT_CONFIG.retainExited, 0, 128),
    historySize: boundInteger(source.historySize, DEFAULT_CONFIG.historySize, 0, 512),
    historyPath,
    historyPersist: source.historyPersist === undefined ? true : source.historyPersist === true,
    // 0 = every intercepted command is visible from the first output frame.
    interceptMinVisibleMs: boundInteger(source.interceptMinVisibleMs, DEFAULT_CONFIG.interceptMinVisibleMs, 0, 60_000),
    // -1 = never auto-close; 0 = close on the next tick.
    autoCloseCommandDelayMs: boundInteger(source.autoCloseCommandDelayMs, DEFAULT_CONFIG.autoCloseCommandDelayMs, -1, 600_000),
    autoCloseFailedDelayMs: boundInteger(source.autoCloseFailedDelayMs, DEFAULT_CONFIG.autoCloseFailedDelayMs, -1, 600_000),
    autoCloseToolTerminals: source.autoCloseToolTerminals === undefined ? true : source.autoCloseToolTerminals === true,
    autoCloseNotice: source.autoCloseNotice === 'failed' || source.autoCloseNotice === 'none' ? source.autoCloseNotice : 'all',
    requireSandbox: source.requireSandbox === true,
    allowUnconfined: source.allowUnconfined === undefined ? true : source.allowUnconfined === true,
    portDetection: source.portDetection === undefined ? true : source.portDetection === true,
  }
}

/**
 * Read the current DSH sandbox policy for an agent without importing any
 * harness package. Returns the fail-safe shape when the service is absent.
 * @param {() => any} getService lazy service getter.
 * @param {any} agent owning agent.
 * @returns {{ mode: string, workspaceRoot: string | undefined, available: boolean }} policy fact.
 */
export function readSandboxPolicy(getService, agent) {
  const fallback = { mode: 'danger-full-access', workspaceRoot: undefined, available: false }
  try {
    const policy = getService()
    if (policy === undefined || policy === null || typeof policy.resolve !== 'function') return fallback
    const resolved = policy.resolve({ session: agent?.session })
    const mode = typeof resolved?.mode === 'string' ? resolved.mode : fallback.mode
    return {
      mode,
      workspaceRoot: typeof resolved?.workspaceRoot === 'string' ? resolved.workspaceRoot : undefined,
      available: true,
    }
  } catch {
    return fallback
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
  const getService = (name) => {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }
  const getSandboxPolicy = () => getService('sandboxPolicy')
  const resolveSandboxPolicy = (agent) => readSandboxPolicy(getSandboxPolicy, agent)
  /** @type {{ config: any, registry: any, logger: any, getAttachments: () => any, getJobs: () => any, getAgents: () => any }} */
  const plugin = {
    config: resolved,
    registry: undefined,
    logger: ctx.logger,
    getAttachments: () => getService('attachments'),
    getJobs: () => getService('jobs'),
    getAgents: () => getService('agents'),
    resolveSandboxPolicy,
  }
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
  const initRegistry = (services) => {
    if (plugin.registry !== undefined) return
    const registry = new TerminalRegistry({
      subprocess: services.subprocess,
      workingDirectory: services.workingDirectory,
      getSessionStore: () => getService('sessions'),
      getSessionQuery: () => getService('sessionQuery'),
      getSandboxPolicy,
      resolveSandboxPolicy,
      logger: ctx.logger,
      config: resolved,
    })
    plugin.registry = registry
    ctx.effect(
      () => async () => {
        await registry.dispose()
      },
      'dsh-live-terminal: terminal sessions',
    )
    log('info', `[dsh-live-terminal] terminal backend ready (shell: ${resolved.shellPath ?? 'auto'}, maxSessions=${resolved.maxSessions}, history=${resolved.historySize})`)
  }
  const subprocess = getService('subprocess')
  const workingDirectory = getService('workingDirectory')
  if (subprocess !== undefined && workingDirectory !== undefined) {
    initRegistry({ subprocess, workingDirectory })
  } else {
    ctx.inject(['subprocess', 'workingDirectory'], (svcCtx) => initRegistry(svcCtx))
  }

  // 5) HTTP + SSE routes: only when the Web composition is present.
  const webServer = getService('webServer')
  const connection = getService('connection')
  if (webServer !== undefined && connection !== undefined) {
    registerRoutes(ctx, plugin)
  } else {
    ctx.inject(['webServer', 'connection'], (webCtx) => {
      registerRoutes(webCtx, plugin)
    })
  }

  log(
    'info',
    `[dsh-live-terminal] host half 1.2.2 loaded (interceptShellTools=${resolved.interceptShellTools}, routes=${
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
