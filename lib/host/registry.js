/**
 * Session registry for the terminal panel.
 *
 * Owns the PTY sessions, resolves the shell once, keeps one default
 * interactive terminal per agent, and enforces the session/retention limits.
 * Visible commands run in their own one-shot `kind: 'command'` sessions; the
 * per-agent interactive terminal is used by `live_terminal_send` /
 * `live_terminal_read` / `live_terminal_exec`.
 *
 * HTTP routes, model-facing tools and the built-in shell interceptor all use
 * this one registry, so the panel always shows the same terminals.
 *
 * v1.2.1 additions (see docs/impl-1.2.1-contract.md §5.2):
 * - shell-ready visibility timing (hide timer starts on first output, with a
 *   4s spawn-based fallback);
 * - auto-close pause/resume/keep with `autoCloseAt`/`autoClosePaused`/`pinned`;
 * - bounded, persisted {@link CommandHistory} of closed command terminals;
 * - multi-client writer lease, capture-request round-trip, replay/export;
 * - localhost port detection + notices, per-session capacity, sandbox metadata;
 * - `command-finished` / `auto-close` / `port` notices.
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { CommandHistory } from './history.js'
import { commandArgv, interactiveArgv, resolveShell } from './shell.js'
import { sleep, TerminalPanelSession } from './session.js'
import { commandTitle } from './wrapper.js'

/** Default terminal columns for new sessions. */
export const DEFAULT_COLS = 120
/** Default terminal rows for new sessions. */
export const DEFAULT_ROWS = 30
/** Maximum accepted terminal columns. */
export const MAX_COLS = 500
/** Maximum accepted terminal rows. */
export const MAX_ROWS = 200
/** PTY terminal type advertised to the child shell. */
const TERMINAL_TYPE = 'xterm-256color'
/** Grace period for terminating a whole PTY session. */
const GRACE_MS = 1000
/** Fallback delay (from creation) when a hidden intercepted shell prints nothing. */
const VISIBILITY_FALLBACK_MS = 4000
/** Maximum plain-text tail persisted with one history entry. */
const HISTORY_TEXT_BYTES = 64 * 1024
/** Default wait budget for {@link TerminalRegistry#waitForExit}. */
const DEFAULT_WAIT_TIMEOUT_MS = 30_000
/** Default payload bound for wait results. */
const WAIT_TEXT_BYTES = 16 * 1024

/**
 * Validate and clamp terminal dimensions.
 * @param {unknown} cols requested columns.
 * @param {unknown} rows requested rows.
 * @returns {{ cols: number, rows: number }} valid dimensions.
 */
export function normalizeDimensions(cols, rows) {
  const width = Number.isSafeInteger(cols) && cols >= 2 && cols <= MAX_COLS ? cols : DEFAULT_COLS
  const height = Number.isSafeInteger(rows) && rows >= 1 && rows <= MAX_ROWS ? rows : DEFAULT_ROWS
  return { cols: width, rows: height }
}

/**
 * @typedef {object} SandboxInfo
 * @property {string} mode DSH sandbox mode for the session.
 * @property {boolean} confined whether the PTY was actually confined (false in 1.2.1).
 * @property {boolean} required whether the plugin configuration requires confinement.
 */

export class TerminalRegistry {
  /** @type {Map<string, TerminalPanelSession>} */
  #sessions = new Map()
  /** @type {Map<string, string>} agent id -> default interactive session id. */
  #agentTerminals = new Map()
  /** @type {Set<string>} in-flight default terminals protected from capacity reclamation. */
  #startingDefaults = new Set()
  /** @type {Set<string>} command sessions hidden from the panel until they prove visible. */
  #hidden = new Set()
  /** @type {Map<string, ReturnType<typeof setTimeout>>} reveal timers per hidden session id. */
  #visibilityTimers = new Map()
  /** @type {Map<string, ReturnType<typeof setTimeout>>} 4s spawn-based reveal fallbacks. */
  #visibilityFallbackTimers = new Map()
  /** @type {Map<string, ReturnType<typeof setTimeout>>} auto-close timers per exited command session id. */
  #autoCloseTimers = new Map()
  /** @type {Map<string, { origin: 'intercept' | 'tool', keepOpen: boolean }>} command session origin/metadata. */
  #commandMeta = new Map()
  /** @type {string} signature of the last emitted `sessions` list (suppresses no-op events). */
  #lastSessionsSignature = '[]'
  /** @type {Map<string, Promise<TerminalPanelSession>>} in-flight agent terminal creation. */
  #creating = new Map()
  /** @type {Set<(name: string, data: any) => void>} global SSE subscribers. */
  #eventSubscribers = new Set()
  /** @type {any} */
  #subprocess
  /** @type {any} */
  #workingDirectory
  /** @type {any} */
  #sessionStore
  /** @type {(() => any) | undefined} */
  #getSessionStore
  /** @type {any} */
  #sessionQuery
  /** @type {(() => any) | undefined} */
  #getSessionQuery
  /** @type {any} */
  #logger
  /** @type {object} */
  #config
  /** @type {((agent: any) => { mode?: string, confined?: boolean, required?: boolean } | undefined) | undefined} */
  #resolveSandboxPolicy
  /** @type {CommandHistory} */
  #history
  /** @type {Map<string, Promise<{ path: string, kind: string }>>} cache per shell-kind hint ('' = no hint). */
  #shellPromises = new Map()
  /** @type {number} capacity slots reserved by in-flight creations. */
  #pending = 0
  /** @type {Map<string, number>} in-flight reservations per DSH session id. */
  #pendingBySession = new Map()
  /** @type {boolean} */
  #disposed = false

  /**
   * @param {object} options registry services and config.
   * @param {any} options.subprocess subprocess service.
   * @param {any} options.workingDirectory working-directory service.
   * @param {any} [options.sessions] optional `ctx.sessions` service (legacy pre-resolved store).
   * @param {() => any} [options.getSessionStore] lazy `ctx.sessions` accessor.
   * @param {any} [options.sessionQuery] optional `ctx.sessionQuery` service (legacy pre-resolved).
   * @param {() => any} [options.getSessionQuery] lazy `ctx.sessionQuery` accessor.
   * @param {any} [options.logger] logger with `warn`/`info`.
   * @param {object} options.config resolved plugin config (see lib/index.js `resolveConfig`).
   * @param {(agent: any) => { mode?: string, confined?: boolean, required?: boolean } | undefined} [options.resolveSandboxPolicy]
   *   injected by index.js to fold the current DSH sandbox policy (synchronous).
   */
  constructor({
    subprocess,
    workingDirectory,
    sessions,
    getSessionStore,
    sessionQuery,
    getSessionQuery,
    logger,
    config,
    resolveSandboxPolicy,
  }) {
    if (subprocess === undefined || subprocess === null) throw new Error('dsh-live-terminal: subprocess service is required')
    this.#subprocess = subprocess
    this.#workingDirectory = workingDirectory
    this.#sessionStore = sessions
    this.#getSessionStore = typeof getSessionStore === 'function' ? getSessionStore : undefined
    this.#sessionQuery = sessionQuery
    this.#getSessionQuery = typeof getSessionQuery === 'function' ? getSessionQuery : undefined
    this.#logger = logger
    this.#config = config !== null && typeof config === 'object' ? config : {}
    this.#resolveSandboxPolicy = typeof resolveSandboxPolicy === 'function' ? resolveSandboxPolicy : undefined
    this.#history = new CommandHistory({
      size: this.#configInteger('historySize', 20, 0, 500),
      file: this.#configString('historyPath'),
      persist: this.#configFlag('historyPersist', true),
      logger: logger,
    })
  }

  /** Number of live + retained sessions. */
  get size() {
    return this.#sessions.size
  }

  /** Resolved configuration (read-only by convention). */
  get config() {
    return this.#config
  }

  /** Closed-command history store (bounded, optionally persisted). */
  get history() {
    return this.#history
  }

  /**
   * All visible sessions as plain `SessionInfo` values, oldest first. Sessions
   * still hidden from the panel (fast intercepted commands) are omitted.
   * @returns {import('./session.js').SessionInfo[]} session infos.
   */
  list() {
    return [...this.#sessions.values()]
      .filter((session) => !this.#hidden.has(session.id))
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((session) => session.info)
  }

  /**
   * Look up one session by id.
   * @param {string} id session id.
   * @returns {TerminalPanelSession | undefined} session.
   */
  lookup(id) {
    if (typeof id !== 'string') return undefined
    return this.#sessions.get(id)
  }

  /**
   * Resolve the terminal addressed by a tool call.
   * @param {any} agent owning agent (may be undefined).
   * @param {string} [terminalId] explicit terminal id.
   * @returns {TerminalPanelSession | undefined} session when found.
   */
  resolveForAgent(agent, terminalId) {
    if (typeof terminalId === 'string' && terminalId.length > 0) return this.lookup(terminalId)
    if (agent === undefined || agent === null) return undefined
    const mapped = this.#agentTerminals.get(agent.id)
    return mapped === undefined ? undefined : this.lookup(mapped)
  }

  /**
   * Resolve the most recent visible session owned by an agent.
   *
   * @param {any} agent owning agent.
   * @param {{ prefer?: 'active' | 'command' | 'any' }} [options] selection policy.
   *   `active` (default) prefers a running session, then the newest command,
   *   then the newest interactive session; `command` keeps the historical
   *   command-first behavior; `any` returns the newest owned session.
   * @returns {TerminalPanelSession | undefined} most recent owned session.
   */
  resolveRecentForAgent(agent, options = {}) {
    const agentId = agent?.id
    if (typeof agentId !== 'string' || agentId.length === 0) return undefined
    const owned = [...this.#sessions.values()]
      .map((session, index) => ({ session, index }))
      .filter(
        (entry) =>
          !this.#hidden.has(entry.session.id) &&
          entry.session.owner === 'agent' &&
          entry.session.agentId === agentId,
      )
    if (owned.length === 0) return undefined
    const prefer = options.prefer === 'command' || options.prefer === 'any' ? options.prefer : 'active'
    // Same-millisecond creations keep Map insertion order as the final tie-break
    // so the newest terminal is deterministic.
    const newest = (left, right) => right.session.createdAt - left.session.createdAt || right.index - left.index
    const pick = (entries) => (entries.length > 0 ? entries.sort(newest)[0].session : undefined)
    if (prefer === 'any') return pick(owned)
    if (prefer === 'command') {
      const commands = owned.filter((entry) => entry.session.kind === 'command')
      return pick(commands) ?? pick(owned)
    }
    const running = owned.filter((entry) => entry.session.state === 'running')
    const active = pick(running)
    if (active !== undefined) return active
    const commands = owned.filter((entry) => entry.session.kind === 'command')
    return pick(commands) ?? pick(owned)
  }

  /**
   * Resolve one session for a tool/route and enforce ownership.
   *
   * @param {any} agent owning agent.
   * @param {string} terminalId explicit terminal id.
   * @param {{ writable?: boolean }} [options] capability required.
   * @returns {TerminalPanelSession} visible (and writable when requested) session.
   */
  resolveVisible(agent, terminalId, options = {}) {
    if (typeof terminalId !== 'string' || terminalId.length === 0) throw new Error('terminalId must be a non-empty string')
    const session = this.lookup(terminalId)
    if (session === undefined) throw new Error(`terminal ${terminalId} not found`)
    const writable = options.writable === true
    if (session.owner === 'user') {
      if (writable) throw new Error(`terminal ${terminalId} is user-owned and read-only to agents; it cannot be written to or closed`)
      return session
    }
    if (session.agentId !== agent?.id) {
      throw new Error(`terminal ${terminalId} belongs to another agent and is not ${writable ? 'writable' : 'visible'} from this agent`)
    }
    return session
  }

  /**
   * Register the default interactive terminal for an agent.
   *
   * @param {string} agentId agent id.
   * @param {string} sessionId terminal session id.
   * @returns {import('./session.js').SessionInfo | undefined} the session info when found.
   */
  setDefaultTerminal(agentId, sessionId) {
    if (typeof agentId !== 'string' || agentId.length === 0) throw new Error('agentId must be a non-empty string')
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('sessionId must be a non-empty string')
    const session = this.lookup(sessionId)
    if (session === undefined) return undefined
    this.#agentTerminals.set(agentId, sessionId)
    return session.info
  }

  /**
   * Number of sessions (live + retained) that belong to one DSH session.
   *
   * @param {string} sessionId DSH session id.
   * @returns {number} session count.
   */
  perSessionCount(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return 0
    let count = 0
    for (const session of this.#sessions.values()) {
      if (session.sessionId === sessionId) count += 1
    }
    return count
  }

  /**
   * Read the current sandbox metadata for one agent.
   *
   * @param {any} agent owning agent.
   * @returns {SandboxInfo} sandbox metadata.
   */
  sandboxFor(agent) {
    return this.#sandboxFor(agent)
  }

  /**
   * Wait for a terminal to exit, to match a pattern, or both, without killing it.
   *
   * @param {string} id terminal id.
   * @param {{ timeoutMs?: number, pattern?: string, mode?: 'exit' | 'pattern' | 'either', since?: 'now' | 'unread', signal?: AbortSignal }} [options] wait options.
   * @returns {Promise<{ terminalId: string, state: string, exitCode: number | null, signal: string | null, durationMs: number | null, timedOut: boolean, matched: boolean, text: string, truncated: boolean, reason: string }>} wait outcome.
   */
  waitForExit(id, options = {}) {
    const session = this.#requireSession(id)
    const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS)
    const pattern = typeof options.pattern === 'string' && options.pattern.length > 0 ? options.pattern : undefined
    const mode = options.mode === 'exit' || options.mode === 'pattern' ? options.mode : pattern === undefined ? 'exit' : 'either'
    const since = options.since === 'now' ? 'now' : 'unread'
    if (mode === 'exit' && session.state !== 'running') return Promise.resolve(this.#waitOutcome(session, false, false, 'already-exited'))
    let matcher
    if (pattern !== undefined) {
      try {
        matcher = new RegExp(pattern)
      } catch (error) {
        return Promise.reject(new Error(`invalid regular expression: ${error instanceof Error ? error.message : String(error)}`))
      }
    }
    return new Promise((resolve) => {
      let settled = false
      let timer
      let unsubscribe = () => {}
      // Rolling match window so a pattern split across output chunks still hits.
      let haystack = ''
      const onAbort = () => finish(false, false, 'aborted')
      const finish = (timedOut, matched, reason) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener?.('abort', onAbort)
        try {
          unsubscribe()
        } catch {
          // ignore
        }
        resolve(this.#waitOutcome(session, timedOut, matched, reason))
      }
      const check = (text) => {
        if (matcher === undefined) return false
        return matcher.test(text)
      }
      // Backlog: a pattern that already appeared before the call still matches,
      // unless the caller asked for "from now on only".
      if (mode !== 'exit' && since !== 'now' && matcher !== undefined) {
        try {
          haystack = session.plainText()
        } catch {
          haystack = ''
        }
        if (check(haystack)) {
          finish(false, true, 'pattern')
          return
        }
        haystack = haystack.slice(-65_536)
      }
      if (mode === 'pattern' && matcher === undefined) {
        finish(false, false, 'no-pattern')
        return
      }
      if (session.state !== 'running' && mode !== 'exit') {
        finish(false, false, 'already-exited')
        return
      }
      if (options.signal?.aborted === true) {
        finish(false, false, 'aborted')
        return
      }
      unsubscribe = session.subscribe((name, data) => {
        if (name === 'exit') {
          finish(false, false, 'exit')
          return
        }
        if (mode !== 'exit' && name === 'output' && matcher !== undefined && typeof data?.chunk === 'string') {
          haystack = `${haystack}${data.chunk}`.slice(-65_536)
          if (check(haystack)) finish(false, true, 'pattern')
        }
      })
      options.signal?.addEventListener?.('abort', onAbort, { once: true })
      // Ref'd on purpose: the caller is awaiting this wait inside a tool call,
      // and an unref'd timer can leave an idle host exiting before the timeout
      // rejects/resolves the promise.
      timer = setTimeout(() => finish(true, false, 'timeout'), timeoutMs)
      session.whenExited.then(
        () => finish(false, false, 'exit'),
        () => finish(false, false, 'exit'),
      )
    })
  }

  /**
   * All retained task entries of one agent's terminal sessions.
   *
   * @param {number} [limit] maximum entries.
   * @param {string} [terminalId] filter by original terminal id.
   * @returns {import('./history.js').HistoryEntry[]} history entries.
   */
  historyList(limit, terminalId) {
    return this.#history.list({ limit, terminalId })
  }

  /**
   * Replay retained output frames of one session.
   *
   * @param {string} id terminal id.
   * @param {number} [fromSeq] exclusive lower sequence bound.
   * @returns {{ frames: { seq: number, chunk: string }[], nextSeq: number }} replay payload.
   */
  replay(id, fromSeq = 0) {
    const session = this.#requireSession(id)
    const from = Number.isSafeInteger(fromSeq) && fromSeq > 0 ? fromSeq : 0
    const frames = session.framesSince(from)
    const last = frames.length > 0 ? frames[frames.length - 1].seq + 1 : from
    return { frames, nextSeq: last }
  }

  /**
   * Export one session (or its history record) as text/ANSI.
   *
   * @param {string} id terminal id.
   * @param {'text' | 'ansi'} [format] export format.
   * @returns {{ text: string, bytes: number, truncated: boolean }} export payload.
   */
  exportSession(id, format = 'text') {
    const session = this.lookup(id)
    if (session !== undefined) return session.exportText(format)
    const entry = this.#history.get(id)
    if (entry === undefined) throw new Error(`terminal ${id} not found`)
    return { text: entry.text, bytes: Buffer.byteLength(entry.text, 'utf8'), truncated: entry.truncated }
  }

  /**
   * Attach a browser client to a session's input lease.
   *
   * @param {string} id terminal id.
   * @param {string} clientId browser client id.
   * @returns {{ writerClientId: string | null }} lease state.
   */
  attachClient(id, clientId) {
    return this.#requireSession(id).attachClient(clientId)
  }

  /**
   * Detach a browser client from a session's input lease.
   *
   * @param {string} id terminal id.
   * @param {string} clientId browser client id.
   * @returns {{ writerClientId: string | null }} lease state.
   */
  detachClient(id, clientId) {
    const session = this.lookup(id)
    if (session === undefined) return { writerClientId: null }
    return session.detachClient(clientId)
  }

  /**
   * Make one client the writer for a session.
   *
   * @param {string} id terminal id.
   * @param {string} clientId browser client id.
   * @returns {{ writerClientId: string | null }} lease state.
   */
  takeControl(id, clientId) {
    return this.#requireSession(id).takeControl(clientId)
  }

  /**
   * @param {string} id terminal id.
   * @param {string | undefined} clientId browser client id.
   * @returns {boolean} whether the client may write.
   */
  isWritable(id, clientId) {
    const session = this.lookup(id)
    if (session === undefined) return false
    return session.isWritable(clientId)
  }

  /**
   * Ask the connected browser for a PNG of one terminal.
   *
   * @param {string} id terminal id.
   * @param {{ timeoutMs?: number }} [options] wait options.
   * @returns {Promise<{ buffer: Buffer, width: number, height: number }>} captured PNG.
   */
  requestCapture(id, options = {}) {
    return this.#requireSession(id).requestCapture(options)
  }

  /**
   * Resolve a pending capture request.
   *
   * @param {string} id terminal id.
   * @param {string} requestId capture request id.
   * @param {{ buffer?: Buffer | Uint8Array | string, width?: number, height?: number }} payload image payload.
   * @returns {boolean} whether a pending request was resolved.
   */
  resolveCapture(id, requestId, payload) {
    return this.#requireSession(id).resolveCapture(requestId, payload)
  }

  /**
   * Subscribe to global session-list events (`sessions`, `notice`).
   * @param {(name: string, data: any) => void} listener listener.
   * @returns {() => void} disposer.
   */
  subscribeEvents(listener) {
    this.#eventSubscribers.add(listener)
    return () => {
      this.#eventSubscribers.delete(listener)
    }
  }

  /**
   * Create a one-shot command session (`shell -Command <command>`).
   *
   * @param {object} options command session options.
   * @param {string} options.command command text.
   * @param {string} [options.cwd] working directory.
   * @param {number} [options.cols] columns.
   * @param {number} [options.rows] rows.
   * @param {string} [options.shellKindHint] requested shell kind (`pwsh` | `bash`).
   * @param {'intercept' | 'tool'} [options.origin] who created the session.
   * @param {boolean} [options.keepOpen] keep the terminal after the command exits.
   * @param {string} [options.agentId] owning agent id.
   * @param {string} [options.sessionId] DSH session id.
   * @param {string} [options.title] display title.
   * @param {'agent' | 'user'} [options.owner] owner kind (default agent when agentId is set).
   * @param {Record<string, string>} [options.env] extra environment variables.
   * @param {any} [options.agent] owning agent (for cwd resolution and sandbox policy).
   * @param {AbortSignal} [options.signal] allocation cancellation.
   * @param {boolean} [options.requireSandbox] force sandbox-required semantics.
   * @returns {Promise<TerminalPanelSession>} created session.
   */
  async createCommandSession(options) {
    const command = typeof options.command === 'string' ? options.command : ''
    if (command.trim().length === 0) throw new Error('command must be a non-empty string')
    const dimensions = normalizeDimensions(options.cols, options.rows)
    const origin = options.origin === 'intercept' ? 'intercept' : 'tool'
    const keepOpen = options.keepOpen === true
    const owner = options.owner === 'agent' || options.owner === 'user' ? options.owner : options.agentId === undefined ? 'user' : 'agent'
    const requireSandbox = options.requireSandbox === undefined ? this.#requireSandbox() : options.requireSandbox === true
    const sandbox = this.#sandboxFor(options.agent, requireSandbox)
    if (owner === 'agent' && (requireSandbox || this.#allowUnconfined() === false) && sandbox.mode !== 'danger-full-access') {
      throw sandboxRequiredError(sandbox)
    }
    const shell = await this.#shell(options.signal, options.shellKindHint)
    const cwd = await this.#resolveCwd({ agent: options.agent, cwd: options.cwd, signal: options.signal })
    await this.#reserveSlot(options.sessionId)
    const hideForMs = origin === 'intercept' ? this.#interceptMinVisibleMs() : 0
    return this.#spawn({
      argv: commandArgv(shell, command),
      kind: 'command',
      owner,
      command,
      title: options.title ?? commandTitle(command),
      cols: dimensions.cols,
      rows: dimensions.rows,
      cwd,
      sessionId: options.sessionId,
      agentId: options.agentId,
      shellKind: shell.kind,
      sandbox,
      env: options.env,
      signal: options.signal,
      commandMeta: { origin, keepOpen },
      hideForMs,
    })
  }

  /**
   * Create an interactive session.
   *
   * @param {object} options interactive session options.
   * @param {string} [options.cwd] working directory.
   * @param {number} [options.cols] columns.
   * @param {number} [options.rows] rows.
   * @param {string} [options.shellKindHint] requested shell kind.
   * @param {string} [options.agentId] owning agent id.
   * @param {string} [options.sessionId] DSH session id.
   * @param {string} [options.title] display title.
   * @param {'agent' | 'user'} [options.owner] owner kind.
   * @param {Record<string, string>} [options.env] extra environment variables.
   * @param {any} [options.agent] owning agent (for cwd resolution and sandbox policy).
   * @param {AbortSignal} [options.signal] allocation cancellation.
   * @param {boolean} [options.startingDefault] protect the session as an in-flight agent default terminal.
   * @param {boolean} [options.requireSandbox] force sandbox-required semantics.
   * @returns {Promise<TerminalPanelSession>} created session.
   */
  async createInteractive(options = {}) {
    const dimensions = normalizeDimensions(options.cols, options.rows)
    const owner = options.owner === 'agent' || options.owner === 'user' ? options.owner : 'user'
    const requireSandbox = options.requireSandbox === undefined ? this.#requireSandbox() : options.requireSandbox === true
    const sandbox = this.#sandboxFor(options.agent, requireSandbox)
    if (
      owner === 'agent' &&
      (requireSandbox || this.#allowUnconfined() === false) &&
      sandbox.mode !== 'danger-full-access'
    ) {
      throw sandboxRequiredError(sandbox)
    }
    const shell = await this.#shell(options.signal, options.shellKindHint)
    const cwd = await this.#resolveCwd({ agent: options.agent, cwd: options.cwd, signal: options.signal })
    await this.#reserveSlot(options.sessionId)
    return this.#spawn({
      argv: interactiveArgv(shell),
      kind: 'interactive',
      owner,
      title: options.title ?? defaultShellTitle(shell.kind),
      cols: dimensions.cols,
      rows: dimensions.rows,
      cwd,
      sessionId: options.sessionId,
      agentId: options.agentId,
      shellKind: shell.kind,
      sandbox,
      env: options.env,
      signal: options.signal,
      startingDefault: options.startingDefault === true,
    })
  }

  /**
   * Reuse or create the agent's default interactive terminal.
   * @param {any} agent owning agent.
   * @param {{ cwd?: string, cols?: number, rows?: number, title?: string, shellKindHint?: string, env?: Record<string, string>, signal?: AbortSignal }} [options] creation options.
   * @returns {Promise<TerminalPanelSession>} the agent's terminal.
   */
  async ensureAgentTerminal(agent, options = {}) {
    const agentId = agent?.id
    if (typeof agentId !== 'string' || agentId.length === 0) {
      throw new Error('terminal tools require an initiating agent')
    }
    const existingId = this.#agentTerminals.get(agentId)
    if (existingId !== undefined) {
      const existing = this.lookup(existingId)
      if (existing !== undefined && existing.running) return existing
      if (existing !== undefined) await this.close(existingId)
      this.#agentTerminals.delete(agentId)
    }
    const pending = this.#creating.get(agentId)
    if (pending !== undefined) return pending
    const creation = (async () => {
      const session = await this.createInteractive({
        agent,
        agentId,
        sessionId: agent.session?.id,
        owner: 'agent',
        title: options.title,
        cwd: options.cwd,
        cols: options.cols,
        rows: options.rows,
        shellKindHint: options.shellKindHint,
        env: options.env,
        signal: options.signal,
        startingDefault: true,
      })
      try {
        try {
          await session.waitReady({ signal: options.signal })
        } catch {
          // Readiness is best-effort; the session itself stays usable.
        }
        if (session.state !== 'running') {
          await this.close(session.id)
          throw new Error('terminal shell exited during startup')
        }
        this.#agentTerminals.set(agentId, session.id)
        return session
      } finally {
        this.#startingDefaults.delete(session.id)
      }
    })()
    this.#creating.set(agentId, creation)
    try {
      return await creation
    } finally {
      if (this.#creating.get(agentId) === creation) this.#creating.delete(agentId)
    }
  }

  /**
   * Wait for a one-shot command session to settle.
   * @param {TerminalPanelSession} session command session.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] wait options.
   * @returns {Promise<{ output: string, truncated: boolean, exitCode: number | null, signal: string | null, timedOut: boolean, aborted: boolean, durationMs: number | null, ports: import('./session.js').PortInfo[], sandbox: SandboxInfo }>} outcome.
   */
  async waitForCommandSession(session, options = {}) {
    const timeoutMs = positiveInteger(options.timeoutMs, this.#configInteger('commandTimeoutMs', 180_000, 1, 3_600_000))
    const outcome = await waitForExit(session, timeoutMs, options.signal)
    if (outcome.kind !== 'exit') {
      try {
        await session.terminate()
      } catch {
        // ignore
      }
      await settleWithGrace(session, 1500)
    }
    const tail = session.plainTail(this.#maxOutputBytes())
    return {
      output: tail.text,
      truncated: tail.truncated,
      exitCode: outcome.kind === 'exit' ? session.exitCode : null,
      signal: outcome.kind === 'exit' ? session.signal : 'SIGTERM',
      timedOut: outcome.kind === 'timeout',
      aborted: outcome.kind === 'aborted',
      durationMs: session.durationMs,
      ports: [...session.ports.values()].map((port) => ({ ...port })),
      sandbox: { ...session.sandbox },
    }
  }

  /**
   * Resolve a working directory for a tool or route caller.
   * @param {any} agent owning agent (optional).
   * @param {string} [cwd] requested directory (absolute or relative).
   * @param {AbortSignal} [signal] cancellation.
   * @returns {Promise<string>} resolved absolute directory.
   */
  resolveCwd(agent, cwd, signal) {
    return this.#resolveCwd({ agent, cwd, signal })
  }

  /**
   * Resolve the committed working directory of a DSH session.
   *
   * This is what lets the panel's "+ new terminal" button open in the session
   * workspace instead of the host process directory. Resolution order:
   *
   * 1. a live session in `ctx.sessions` (authoritative current directory via
   *    `ctx.workingDirectory.get(session)`, or its durable header cwd),
   * 2. `ctx.sessionQuery`'s live-preferred session corpus, which also covers
   *    persisted sessions that the GUI lists but that are not live in the Host.
   *
   * Both services are read lazily at call time (service injection ordering can
   * make them unavailable when the registry is constructed). An unknown session
   * id yields `undefined` and the caller falls back to the default directory.
   *
   * @param {string} sessionId DSH session id.
   * @returns {Promise<string | undefined>} absolute session working directory.
   */
  async resolveSessionCwd(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    const store = this.#getSessionStore?.() ?? this.#sessionStore
    if (store !== undefined && store !== null) {
      const session = findLiveSession(store, sessionId)
      if (session !== undefined && session !== null) {
        const directory = this.#directoryOf(session)
        if (directory !== undefined) return directory
      }
    }
    return this.#querySessionCwd(sessionId)
  }

  /**
   * Read one durable session header cwd from `ctx.sessionQuery`.
   * @param {string} sessionId DSH session id.
   * @returns {Promise<string | undefined>} absolute header cwd.
   */
  async #querySessionCwd(sessionId) {
    const query = this.#getSessionQuery?.() ?? this.#sessionQuery
    if (query === undefined || query === null) return undefined
    const candidates = sessionIdCandidates(sessionId)
    if (typeof query.filterSessions === 'function') {
      try {
        const records = await query.filterSessions([{ kind: 'id', values: candidates }])
        const directory = headerCwdOf(records)
        if (directory !== undefined) return directory
      } catch {
        // fall through to the corpus listing
      }
    }
    if (typeof query.listSessions === 'function') {
      try {
        const records = await query.listSessions()
        if (Array.isArray(records)) {
          const found = records.find((record) => candidates.includes(record?.header?.id))
          const directory = headerCwdOf(found === undefined ? undefined : [found])
          if (directory !== undefined) return directory
        }
      } catch {
        // unknown/offline session: caller falls back to the default directory
      }
    }
    return undefined
  }

  /**
   * Current working directory of a live Session: projection state first, then
   * the immutable header (for sessions restored without their projections).
   * @param {any} session live Session.
   * @returns {string | undefined} absolute directory.
   */
  #directoryOf(session) {
    const getDirectory = this.#workingDirectory?.get
    if (typeof getDirectory === 'function') {
      try {
        const directory = getDirectory.call(this.#workingDirectory, session)
        if (isAbsolute(directory) && directory.length > 0) return directory
      } catch {
        // fall through to the header cwd
      }
    }
    const headerCwd = session.header?.cwd
    return typeof headerCwd === 'string' && isAbsolute(headerCwd) ? headerCwd : undefined
  }

  /**
   * Pin/keep one terminal open: cancel any scheduled auto-close.
   *
   * @param {string} id terminal id.
   * @returns {import('./session.js').SessionInfo} updated info.
   */
  keep(id) {
    const session = this.#requireSession(id)
    const meta = this.#commandMeta.get(id)
    if (meta !== undefined) meta.keepOpen = true
    session.setKeepOpen(true)
    session.setPinned(true)
    this.#clearAutoCloseTimer(id)
    session.setAutoClosePaused(false)
    session.setAutoCloseAt(null)
    this.#emitSessions()
    return session.info
  }

  /**
   * Pause the auto-close countdown of one command terminal.
   *
   * @param {string} id terminal id.
   * @returns {import('./session.js').SessionInfo} updated info.
   */
  pauseAutoClose(id) {
    const session = this.#requireSession(id)
    this.#clearAutoCloseTimer(id)
    session.pauseAutoClose('manual')
    this.#emitSessions()
    return session.info
  }

  /**
   * Resume the auto-close countdown of one command terminal.
   *
   * @param {string} id terminal id.
   * @returns {import('./session.js').SessionInfo} updated info.
   */
  resumeAutoClose(id) {
    const session = this.#requireSession(id)
    this.#clearAutoCloseTimer(id)
    session.resumeAutoClose()
    const meta = this.#commandMeta.get(id) ?? { origin: 'tool', keepOpen: false }
    if (session.state === 'running') {
      session.setAutoCloseAt(null)
    } else if (!session.pinned && meta.keepOpen !== true) {
      const delayMs = this.#autoCloseDelayMs(meta, isFailedCommand(session))
      if (delayMs !== undefined) this.#scheduleAutoClose(id, delayMs)
    }
    this.#emitSessions()
    return session.info
  }

  /**
   * Rename one terminal.
   *
   * @param {string} id terminal id.
   * @param {string} title new title.
   * @returns {import('./session.js').SessionInfo} updated info.
   */
  setTitle(id, title) {
    return this.#requireSession(id).setTitle(title)
  }

  /**
   * Deliver one signal to one terminal.
   *
   * @param {string} id terminal id.
   * @param {string} name signal name.
   * @returns {Promise<{ delivered: string }>} delivery acknowledgement.
   */
  signal(id, name) {
    return this.#requireSession(id).sendSignal(name)
  }

  /**
   * Terminate and remove one session (retained exited sessions included).
   * @param {string} id session id.
   * @param {{ reason?: 'closed' | 'auto-close' }} [options] close reason for the history record.
   * @returns {Promise<boolean>} whether a session was removed.
   */
  async close(id, options = {}) {
    // Any explicit close cancels auto-close/hidden bookkeeping first: a manual
    // close must never emit an auto-close notice, and timers must not keep a
    // removed session around.
    this.#clearVisibilityTimer(id)
    this.#clearVisibilityFallback(id)
    this.#clearAutoCloseTimer(id)
    this.#hidden.delete(id)
    this.#startingDefaults.delete(id)
    const session = this.#sessions.get(id)
    if (session === undefined) {
      this.#commandMeta.delete(id)
      return false
    }
    if (session.kind === 'command') {
      // A failed command keeps the more informative `failed` reason; otherwise
      // the close cause wins (auto-close vs manual close).
      const closeReason = isFailedCommand(session)
        ? 'failed'
        : options.reason === 'auto-close'
          ? 'auto-close'
          : 'closed'
      this.#recordHistory(session, closeReason)
    }
    this.#commandMeta.delete(id)
    this.#sessions.delete(id)
    if (session.agentId !== undefined && this.#agentTerminals.get(session.agentId) === id) {
      this.#agentTerminals.delete(session.agentId)
    }
    try {
      await session.dispose()
    } finally {
      this.#emitSessions()
    }
    return true
  }

  /**
   * Terminate every session and release the mirror screens.
   * @returns {Promise<void>} after cleanup.
   */
  async dispose() {
    if (this.#disposed) return
    this.#disposed = true
    for (const timer of this.#visibilityTimers.values()) clearTimeout(timer)
    this.#visibilityTimers.clear()
    for (const timer of this.#visibilityFallbackTimers.values()) clearTimeout(timer)
    this.#visibilityFallbackTimers.clear()
    for (const timer of this.#autoCloseTimers.values()) clearTimeout(timer)
    this.#autoCloseTimers.clear()
    const sessions = [...this.#sessions.values()]
    for (const session of sessions) {
      if (session.kind === 'command') this.#recordHistory(session, 'closed')
    }
    this.#sessions.clear()
    this.#hidden.clear()
    this.#commandMeta.clear()
    this.#lastSessionsSignature = '[]'
    this.#agentTerminals.clear()
    this.#startingDefaults.clear()
    this.#creating.clear()
    this.#shellPromises.clear()
    this.#eventSubscribers.clear()
    this.#pending = 0
    this.#pendingBySession.clear()
    await Promise.allSettled(sessions.map((session) => session.dispose()))
    this.#history.dispose()
  }

  /**
   * @param {string} id terminal id.
   * @returns {TerminalPanelSession} session.
   */
  #requireSession(id) {
    if (typeof id !== 'string' || id.length === 0) throw new Error('terminalId must be a non-empty string')
    const session = this.lookup(id)
    if (session === undefined) throw new Error(`terminal ${id} not found`)
    return session
  }

  /**
   * @param {any} subprocess subprocess service.
   * @param {object} options spawn options.
   * @returns {Promise<TerminalPanelSession>} spawned session.
   */
  async #spawn(options) {
    try {
      if (this.#disposed) throw new Error('terminal registry disposed')
      let handle
      try {
        const env = this.#sanitizeEnv(options.env)
        if (options.sessionId !== undefined) env.DSH_SESSION_ID = options.sessionId
        const hasEnv = Object.keys(env).length > 0
        handle = await this.#subprocess.spawnTerminal({
          argv: options.argv,
          cwd: options.cwd,
          cols: options.cols,
          rows: options.rows,
          terminalType: TERMINAL_TYPE,
          ...(hasEnv ? { env } : {}),
          shellActivity: false,
          graceMs: GRACE_MS,
          signal: options.signal,
        })
      } catch (error) {
        this.#logger?.warn?.(`[dsh-live-terminal] failed to spawn terminal: ${error instanceof Error ? error.message : String(error)}`)
        throw error
      }
      const id = randomUUID()
      try {
        const session = new TerminalPanelSession({
          id,
          title: options.title,
          kind: options.kind,
          owner: options.owner,
          sessionId: options.sessionId,
          agentId: options.agentId,
          command: options.command,
          handle,
          cwd: options.cwd,
          cols: options.cols,
          rows: options.rows,
          scrollback: this.#scrollback(),
          maxOutputBytes: this.#maxOutputBytes(),
          shellKind: options.shellKind,
          sandbox: options.sandbox,
          keepOpen: options.commandMeta?.keepOpen === true,
          portDetection: this.#portDetection(),
          onFirstOutput: (firstSession) => this.#onFirstOutput(firstSession),
          onPort: (ports) => this.#onPorts(id, ports),
          onChange: () => this.#emitSessions(),
          onExit: () => this.#handleExit(id),
        })
        this.#sessions.set(id, session)
        if (options.startingDefault === true) this.#startingDefaults.add(id)
        if (options.commandMeta !== undefined) this.#commandMeta.set(id, options.commandMeta)
        // Fast intercepted commands are hidden until the shell is ready and the
        // command has run for the visibility threshold; failures still surface
        // through a notice (see #handleExit).
        if (typeof options.hideForMs === 'number' && options.hideForMs > 0) {
          this.#hidden.add(id)
          this.#scheduleVisibilityFallback(id)
        }
        this.#emitSessions()
        if (session.firstOutputAt !== null) this.#onFirstOutput(session)
        return session
      } catch (error) {
        try {
          await handle.terminate()
        } catch {
          // ignore
        }
        throw error
      }
    } finally {
      // Release the slot reserved by createCommandSession/createInteractive now
      // that the spawn settled (success, spawn failure or constructor failure).
      this.#releaseSlot(options.sessionId)
    }
  }

  /**
   * Handle a command/interactive process exit: history, visibility and
   * auto-close bookkeeping.
   *
   * @param {string} id session id.
   * @returns {void}
   */
  #handleExit(id) {
    const session = this.#sessions.get(id)
    if (session === undefined) return
    if (session.agentId !== undefined && this.#agentTerminals.get(session.agentId) === id) {
      this.#agentTerminals.delete(session.agentId)
    }
    if (session.kind !== 'command') return
    const meta = this.#commandMeta.get(id) ?? { origin: 'tool', keepOpen: false }
    const failed = isFailedCommand(session)
    // The outcome survives the terminal in the bounded history even if the
    // terminal itself is later auto-closed.
    this.#recordHistory(session, failed ? 'failed' : 'closed')
    if (this.#hidden.has(id)) {
      // The command finished before it ever became visible: there is no tab and
      // the filtered session list did not change, so remove it immediately
      // (suppressing the no-op `sessions` event). A failure still surfaces
      // through a notice (and so does success when autoCloseNotice is 'all').
      this.#hidden.delete(id)
      this.#clearVisibilityTimer(id)
      this.#clearVisibilityFallback(id)
      this.#commandMeta.delete(id)
      const mode = this.#noticeMode()
      if (mode === 'all' || (failed && mode === 'failed')) {
        this.#emitAutoCloseNotice(session, failed ? 'failed' : 'succeeded')
      }
      void this.close(id, { reason: 'auto-close' }).catch(() => {})
      return
    }
    const delayMs = session.pinned || session.autoClosePaused ? undefined : this.#autoCloseDelayMs(meta, failed)
    if (delayMs !== undefined) {
      this.#scheduleAutoClose(id, delayMs)
    } else {
      // Non-auto-close exits (kept, paused, or auto-close disabled) still report
      // command-finished so the client can update its history/keep badge.
      this.#emitCommandFinished(session, meta.keepOpen === true || session.pinned)
    }
    void this.#pruneRetainedCommands()
  }

  /**
   * Feed one new port to the global SSE subscribers.
   *
   * @param {string} id terminal id.
   * @param {import('./session.js').PortInfo[]} ports new ports.
   * @returns {void}
   */
  #onPorts(id, ports) {
    const session = this.#sessions.get(id)
    if (session === undefined) return
    for (const port of ports) {
      this.#emitEvent('notice', {
        type: 'port',
        terminalId: id,
        url: port.url,
        port: port.port,
        host: port.host,
      })
    }
    this.#emitSessions()
  }

  /**
   * Shell-ready visibility: the reveal timer starts on the first output chunk.
   *
   * @param {TerminalPanelSession} session session that produced output.
   * @returns {void}
   */
  #onFirstOutput(session) {
    if (this.#disposed) return
    const id = session.id
    if (!this.#hidden.has(id)) return
    if (this.#visibilityTimers.has(id)) return
    this.#clearVisibilityFallback(id)
    this.#scheduleReveal(id, this.#interceptMinVisibleMs())
  }

  /**
   * Reveal a hidden session after `delayMs`.
   * @param {string} id session id.
   * @param {number} delayMs delay in milliseconds.
   * @returns {void}
   */
  #scheduleReveal(id, delayMs) {
    this.#clearVisibilityTimer(id)
    const timer = setTimeout(() => {
      this.#visibilityTimers.delete(id)
      if (!this.#hidden.delete(id)) return
      this.#emitSessions()
    }, Math.max(0, delayMs))
    timer.unref?.()
    this.#visibilityTimers.set(id, timer)
  }

  /**
   * Spawn-based fallback for a silent shell: after 4s without output, measure
   * the visibility threshold from creation instead of waiting for first output.
   *
   * @param {string} id session id.
   * @returns {void}
   */
  #scheduleVisibilityFallback(id) {
    this.#clearVisibilityFallback(id)
    const timer = setTimeout(() => {
      this.#visibilityFallbackTimers.delete(id)
      if (!this.#hidden.has(id)) return
      if (this.#visibilityTimers.has(id)) return
      const remaining = Math.max(0, this.#interceptMinVisibleMs() - VISIBILITY_FALLBACK_MS)
      this.#scheduleReveal(id, remaining)
    }, VISIBILITY_FALLBACK_MS)
    timer.unref?.()
    this.#visibilityFallbackTimers.set(id, timer)
  }

  /**
   * @param {string} id session id.
   * @returns {void}
   */
  #clearVisibilityTimer(id) {
    const timer = this.#visibilityTimers.get(id)
    if (timer === undefined) return
    this.#visibilityTimers.delete(id)
    clearTimeout(timer)
  }

  /**
   * @param {string} id session id.
   * @returns {void}
   */
  #clearVisibilityFallback(id) {
    const timer = this.#visibilityFallbackTimers.get(id)
    if (timer === undefined) return
    this.#visibilityFallbackTimers.delete(id)
    clearTimeout(timer)
  }

  /**
   * Schedule the automatic close of a finished command terminal.
   * @param {string} id session id.
   * @param {number} delayMs delay before closing (0 = next tick).
   * @returns {void}
   */
  #scheduleAutoClose(id, delayMs) {
    this.#clearAutoCloseTimer(id)
    const session = this.#sessions.get(id)
    if (session === undefined || session.pinned) return
    session.setAutoClosePaused(false)
    session.setAutoCloseAt(Date.now() + Math.max(0, delayMs))
    const timer = setTimeout(() => {
      this.#autoCloseTimers.delete(id)
      this.#autoCloseCommand(id)
    }, Math.max(0, delayMs))
    timer.unref?.()
    this.#autoCloseTimers.set(id, timer)
    this.#emitSessions()
  }

  /**
   * @param {string} id session id.
   * @returns {void}
   */
  #clearAutoCloseTimer(id) {
    const timer = this.#autoCloseTimers.get(id)
    if (timer === undefined) return
    this.#autoCloseTimers.delete(id)
    clearTimeout(timer)
  }

  /**
   * Emit the optional notice for a command terminal and close it.
   * @param {string} id session id.
   * @returns {void}
   */
  #autoCloseCommand(id) {
    const session = this.#sessions.get(id)
    if (session === undefined) return
    if (session.pinned || session.autoClosePaused) return
    this.#commandMeta.delete(id)
    const failed = isFailedCommand(session)
    const mode = this.#noticeMode()
    if (mode === 'all' || (failed && mode === 'failed')) {
      this.#emitAutoCloseNotice(session, failed ? 'failed' : 'succeeded')
    }
    void this.close(id, { reason: 'auto-close' }).catch(() => {})
  }

  /**
   * Broadcast one `auto-close` notice to the global SSE subscribers.
   * @param {TerminalPanelSession} session closed command session.
   * @param {'failed' | 'succeeded'} reason auto-close reason.
   * @returns {void}
   */
  #emitAutoCloseNotice(session, reason) {
    this.#emitEvent('notice', {
      type: 'auto-close',
      reason,
      terminalId: session.id,
      historyId: session.id,
      title: session.title,
      exitCode: session.exitCode,
      signal: session.signal,
      excerpt: commandExcerpt(session, this.#maxOutputBytes()),
      durationMs: session.durationMs ?? 0,
    })
  }

  /**
   * Broadcast one `command-finished` notice (a terminal that will stay open).
   *
   * @param {TerminalPanelSession} session finished command session.
   * @param {boolean} keepOpen whether the terminal was kept open.
   * @returns {void}
   */
  #emitCommandFinished(session, keepOpen) {
    this.#emitEvent('notice', {
      type: 'command-finished',
      terminalId: session.id,
      title: session.title,
      exitCode: session.exitCode,
      signal: session.signal,
      durationMs: session.durationMs ?? 0,
      keepOpen: keepOpen === true,
    })
  }

  /**
   * Record one closed command terminal in the bounded history.
   *
   * @param {TerminalPanelSession} session command session.
   * @param {'auto-close' | 'closed' | 'failed'} reason close reason.
   * @returns {import('./history.js').HistoryEntry} history entry.
   */
  #recordHistory(session, reason) {
    const tail = session.plainTail(Math.min(HISTORY_TEXT_BYTES, this.#maxOutputBytes()))
    return this.#history.add({
      id: session.id,
      title: session.title,
      command: session.command ?? '',
      cwd: session.cwd,
      kind: 'command',
      exitCode: session.exitCode,
      signal: session.signal,
      startedAt: session.startedAt,
      endedAt: session.endedAt ?? Date.now(),
      durationMs: session.durationMs ?? Math.max(0, (session.endedAt ?? Date.now()) - session.startedAt),
      cols: session.cols,
      rows: session.rows,
      reason,
      text: tail.text,
      truncated: tail.truncated,
      ports: [...session.ports.values()].map((port) => ({ ...port })),
      sandbox: { ...session.sandbox },
      ...(session.agentId === undefined ? {} : { agentId: session.agentId }),
      ...(session.sessionId === undefined ? {} : { sessionId: session.sessionId }),
      owner: session.owner,
    })
  }

  async #pruneRetainedCommands() {
    const exited = [...this.#sessions.values()]
      .filter((session) => session.kind === 'command' && session.state !== 'running' && !session.pinned)
      .sort((left, right) => left.updatedAt - right.updatedAt)
    while (exited.length > this.#retainExited()) {
      const oldest = exited.shift()
      if (oldest === undefined) break
      await this.close(oldest.id, { reason: 'closed' }).catch(() => {})
    }
  }

  /**
   * How many capacity slots are in use: live/retained sessions plus in-flight
   * creations that already reserved a slot.
   * @returns {number} used slots.
   */
  #usedSlots() {
    return this.#sessions.size + this.#pending
  }

  /**
   * @param {string | undefined} sessionId DSH session id.
   * @returns {number} used slots for that session (sessions + pending).
   */
  #perSessionUsed(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return 0
    return this.perSessionCount(sessionId) + (this.#pendingBySession.get(sessionId) ?? 0)
  }

  /**
   * Reserve one session slot. `#ensureCapacity` may await closing sessions, so
   * the final check-and-increment below is synchronous: two concurrent creators
   * can never both observe the same free slot.
   *
   * @param {string | undefined} sessionId DSH session id for per-session quota.
   * @returns {Promise<void>} after the slot was reserved.
   */
  async #reserveSlot(sessionId) {
    await this.#ensureCapacity(sessionId)
    const limit = this.#maxSessions()
    if (this.#usedSlots() >= limit) {
      throw new Error(`terminal session limit reached (maxSessions=${limit})`)
    }
    const perLimit = this.#perSessionMaxSessions()
    if (typeof sessionId === 'string' && sessionId.length > 0 && this.#perSessionUsed(sessionId) >= perLimit) {
      throw new Error(`terminal session limit reached (perSessionMaxSessions=${perLimit})`)
    }
    this.#pending += 1
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      this.#pendingBySession.set(sessionId, (this.#pendingBySession.get(sessionId) ?? 0) + 1)
    }
  }

  /**
   * Release one slot reserved by {@link #reserveSlot}.
   *
   * @param {string | undefined} sessionId DSH session id.
   * @returns {void}
   */
  #releaseSlot(sessionId) {
    if (this.#pending > 0) this.#pending -= 1
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      const next = (this.#pendingBySession.get(sessionId) ?? 0) - 1
      if (next > 0) this.#pendingBySession.set(sessionId, next)
      else this.#pendingBySession.delete(sessionId)
    }
  }

  /**
   * Whether an interactive session may be reclaimed under capacity pressure.
   * Only agent-owned, non-default interactive sessions are candidates: the
   * user's own terminals, each agent's default interactive terminal and any
   * default terminal still in its startup window must stay alive.
   * @param {TerminalPanelSession} session session candidate.
   * @returns {boolean} whether the session may be auto-closed.
   */
  #isReclaimableInteractive(session) {
    if (session.kind !== 'interactive' || session.owner !== 'agent') return false
    if (session.pinned) return false
    if (this.#startingDefaults.has(session.id)) return false
    if (session.agentId !== undefined && this.#agentTerminals.get(session.agentId) === session.id) return false
    return true
  }

  /**
   * Reclaim exited command terminals (optionally only those of one DSH session).
   *
   * @param {string | undefined} sessionId DSH session id filter.
   * @param {() => boolean} stillOver whether more capacity is still needed.
   * @returns {Promise<void>} after reclaiming.
   */
  async #reclaimExitedCommands(sessionId, stillOver) {
    const candidates = [...this.#sessions.values()]
      .filter(
        (session) =>
          session.kind === 'command' &&
          session.state !== 'running' &&
          !session.pinned &&
          (sessionId === undefined || session.sessionId === sessionId),
      )
      .sort((left, right) => left.updatedAt - right.updatedAt)
    for (const session of candidates) {
      if (!stillOver()) return
      await this.close(session.id, { reason: 'closed' }).catch(() => {})
    }
  }

  /**
   * Reclaim agent-owned non-default interactive terminals.
   *
   * @param {string | undefined} sessionId DSH session id filter.
   * @param {() => boolean} stillOver whether more capacity is still needed.
   * @returns {Promise<void>} after reclaiming.
   */
  async #reclaimAgentInteractives(sessionId, stillOver) {
    const candidates = [...this.#sessions.values()]
      .filter(
        (session) =>
          this.#isReclaimableInteractive(session) && (sessionId === undefined || session.sessionId === sessionId),
      )
      .sort((left, right) => left.updatedAt - right.updatedAt)
    for (const session of candidates) {
      if (!stillOver()) return
      await this.close(session.id, { reason: 'closed' }).catch(() => {})
    }
  }

  /**
   * Enforce the global and per-DSH-session caps before reserving a slot.
   *
   * @param {string | undefined} sessionId DSH session id for per-session quota.
   * @returns {Promise<void>} after making room (or rejecting).
   */
  async #ensureCapacity(sessionId) {
    const limit = this.#maxSessions()
    const perLimit = this.#perSessionMaxSessions()
    const overGlobal = () => this.#usedSlots() >= limit
    const overSession = () =>
      typeof sessionId === 'string' && sessionId.length > 0 && this.#perSessionUsed(sessionId) >= perLimit
    if (overSession()) await this.#reclaimExitedCommands(sessionId, overSession)
    if (overGlobal()) await this.#reclaimExitedCommands(undefined, overGlobal)
    if (overGlobal()) await this.#reclaimAgentInteractives(undefined, overGlobal)
    if (overSession()) await this.#reclaimAgentInteractives(sessionId, overSession)
    if (overGlobal()) {
      throw new Error(`terminal session limit reached (maxSessions=${limit}); close a terminal or raise the limit`)
    }
    if (overSession()) {
      throw new Error(
        `terminal session limit reached (perSessionMaxSessions=${perLimit}); close another terminal of this DSH session`,
      )
    }
  }

  async #resolveCwd({ agent, cwd, signal }) {
    let base
    if (agent !== undefined && agent !== null && this.#workingDirectory?.ensure !== undefined) {
      base = await this.#workingDirectory.ensure(agent, signal)
    } else if (typeof this.#workingDirectory?.defaultDirectory === 'string') {
      base = this.#workingDirectory.defaultDirectory
    } else {
      base = process.cwd()
    }
    if (typeof cwd === 'string' && cwd.length > 0) {
      return isAbsolute(cwd) ? cwd : resolvePath(base, cwd)
    }
    return base
  }

  /**
   * Resolve the shell once per shell-kind hint ('' = no hint). Interactive and
   * hint-less callers share the historical hint-less entry, so their behavior
   * is unchanged.
   * @param {AbortSignal} [signal] allocation cancellation.
   * @param {string} [kindHint] requested shell kind (`pwsh` | `bash`).
   * @returns {Promise<{ path: string, kind: string }>} resolved shell profile.
   */
  async #shell(signal, kindHint) {
    const hint = typeof kindHint === 'string' && kindHint.trim().length > 0 ? kindHint.trim() : ''
    const cached = this.#shellPromises.get(hint)
    if (cached !== undefined) return cached
    const promise = resolveShell({
      subprocess: this.#subprocess,
      shellPath: this.#configString('shellPath'),
      signal,
      kindHint: hint.length === 0 ? undefined : hint,
    }).then(
      (shell) => shell,
      (error) => {
        if (this.#shellPromises.get(hint) === promise) this.#shellPromises.delete(hint)
        throw error
      },
    )
    this.#shellPromises.set(hint, promise)
    return promise
  }

  /**
   * Read or compute the sandbox metadata for one agent.
   *
   * The PTY itself is never confined in 1.2.1 (`confined: false`); this method
   * reports the harness policy truthfully and, with `requireSandbox`, makes the
   * creation paths refuse to run when the policy is not `danger-full-access`.
   *
   * @param {any} agent owning agent (optional).
   * @param {boolean} [requiredOverride] force the `required` flag.
   * @returns {SandboxInfo} sandbox metadata.
   */
  #sandboxFor(agent, requiredOverride) {
    const required = requiredOverride === undefined ? this.#requireSandbox() : requiredOverride === true
    const fallback = { mode: 'danger-full-access', confined: false, required }
    if (this.#resolveSandboxPolicy === undefined) {
      // Without a policy resolver we cannot prove the mode; when confinement is
      // required the creation paths must fail closed instead of assuming
      // danger-full-access.
      return required ? { mode: 'unknown', confined: false, required } : fallback
    }
    try {
      const policy = this.#resolveSandboxPolicy(agent)
      if (policy === null || policy === undefined || typeof policy !== 'object') return fallback
      if (typeof policy.then === 'function') {
        this.#logger?.warn?.('[dsh-live-terminal] resolveSandboxPolicy must be synchronous; assuming danger-full-access')
        return required ? { mode: 'unknown', confined: false, required } : fallback
      }
      // `available: false` means the harness policy service could not prove a
      // mode (index.js returns this fail-safe shape). It is harmless for the
      // informational badge, but it must fail closed when confinement matters.
      if (policy.available === false && (required || this.#allowUnconfined() === false)) {
        return { mode: 'unknown', confined: false, required }
      }
      const mode = typeof policy.mode === 'string' && policy.mode.length > 0 ? policy.mode : fallback.mode
      return {
        mode,
        confined: policy.confined === true,
        required: policy.required === undefined ? required : policy.required === true,
      }
    } catch (error) {
      this.#logger?.warn?.(
        `[dsh-live-terminal] failed to resolve the sandbox policy: ${error instanceof Error ? error.message : String(error)}`,
      )
      return required ? { mode: 'unknown', confined: false, required } : fallback
    }
  }

  /**
   * Validate and bound a caller-provided environment patch.
   *
   * @param {unknown} env candidate environment map.
   * @returns {Record<string, string>} sanitized environment (may be empty).
   */
  #sanitizeEnv(env) {
    if (env === null || typeof env !== 'object' || Array.isArray(env)) return {}
    /** @type {Record<string, string>} */
    const out = {}
    let total = 0
    let count = 0
    for (const [key, value] of Object.entries(env)) {
      if (count >= 64) break
      if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(key)) continue
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue
      const text = String(value)
      if (text.length > 4096) continue
      total += key.length + text.length
      if (total > 32 * 1024) break
      out[key] = text
      count += 1
    }
    return out
  }

  #emitSessions() {
    const sessions = this.list()
    // Suppress no-op events: a hidden command that never became visible must
    // not notify clients (no tab, no auto-open), and an identical list carries
    // no information for any subscriber. Track the signature even while nobody
    // is subscribed: a session created before the first SSE client connects must
    // still be reported as removed when it later closes.
    const signature = JSON.stringify(sessions)
    const changed = signature !== this.#lastSessionsSignature
    this.#lastSessionsSignature = signature
    if (!changed || this.#eventSubscribers.size === 0) return
    this.#emitEvent('sessions', { sessions })
  }

  /**
   * Broadcast one event to the global SSE subscribers.
   * @param {string} name event name (`sessions` | `notice`).
   * @param {any} data event payload.
   * @returns {void}
   */
  #emitEvent(name, data) {
    for (const listener of this.#eventSubscribers) {
      try {
        listener(name, data)
      } catch {
        // A broken SSE writer must not break session bookkeeping.
      }
    }
  }

  /**
   * Decide how long a finished command terminal should stay visible.
   *
   * @param {{ origin: 'intercept' | 'tool', keepOpen: boolean }} meta command metadata.
   * @param {boolean} failed whether the command failed.
   * @returns {number | undefined} delay in ms, or `undefined` to keep the terminal.
   */
  #autoCloseDelayMs(meta, failed) {
    if (meta.keepOpen === true) return undefined
    if (meta.origin === 'tool' && this.#autoCloseToolTerminals() === false) return undefined
    const fallback = failed ? 30_000 : 8000
    const configured = this.#configInteger(
      failed ? 'autoCloseFailedDelayMs' : 'autoCloseCommandDelayMs',
      fallback,
      -1,
      600_000,
    )
    return configured >= 0 ? configured : undefined
  }

  /** @returns {number} configured visibility threshold (0 disables hiding). */
  #interceptMinVisibleMs() {
    return this.#configInteger('interceptMinVisibleMs', 1500, 0, 60_000)
  }

  /** @returns {boolean} whether auto-close applies to tool-created terminals. */
  #autoCloseToolTerminals() {
    return this.#configFlag('autoCloseToolTerminals', true)
  }

  /** @returns {'failed' | 'all' | 'none'} auto-close notice mode. */
  #noticeMode() {
    const value = this.#configString('autoCloseNotice')
    return value === 'failed' || value === 'none' ? value : 'all'
  }

  /** @returns {boolean} whether the plugin requires harness confinement. */
  #requireSandbox() {
    return this.#configFlag('requireSandbox', false)
  }

  /** @returns {boolean} whether harness confinement is allowed to be absent. */
  #allowUnconfined() {
    return this.#configFlag('allowUnconfined', true)
  }

  /** @returns {boolean} whether localhost port detection is enabled. */
  #portDetection() {
    return this.#configFlag('portDetection', true)
  }

  /** @returns {number} global session cap. */
  #maxSessions() {
    return this.#configInteger('maxSessions', 16, 1, 128)
  }

  /** @returns {number} per-DSH-session cap. */
  #perSessionMaxSessions() {
    return this.#configInteger('perSessionMaxSessions', 8, 1, 128)
  }

  /** @returns {number} retained exited command terminals. */
  #retainExited() {
    return this.#configInteger('retainExited', 10, 0, 128)
  }

  /** @returns {number} retained output byte budget. */
  #maxOutputBytes() {
    return this.#configInteger('maxOutputBytes', 262_144, 1024, 16 * 1024 * 1024)
  }

  /** @returns {number} scrollback rows for the headless mirror. */
  #scrollback() {
    return this.#configInteger('scrollback', 2000, 0, 100_000)
  }

  /**
   * @param {string} key config key.
   * @returns {string | undefined} trimmed string value.
   */
  #configString(key) {
    const value = this.#config?.[key]
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
  }

  /**
   * @param {string} key config key.
   * @param {boolean} fallback default.
   * @returns {boolean} flag value.
   */
  #configFlag(key, fallback) {
    const value = this.#config?.[key]
    return value === undefined ? fallback : value === true
  }

  /**
   * @param {string} key config key.
   * @param {number} fallback default.
   * @param {number} min lower bound.
   * @param {number} max upper bound.
   * @returns {number} integer value.
   */
  #configInteger(key, fallback, min, max) {
    const value = this.#config?.[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, Math.floor(value)))
  }

  /**
   * Build the `waitForExit` outcome from the current session state.
   *
   * @param {TerminalPanelSession} session terminal session.
   * @param {boolean} timedOut whether the wait budget expired.
   * @param {boolean} matched whether the pattern matched.
   * @param {string} reason machine-readable outcome reason.
   * @returns {{ terminalId: string, state: string, exitCode: number | null, signal: string | null, durationMs: number | null, timedOut: boolean, matched: boolean, text: string, truncated: boolean, reason: string }} outcome.
   */
  #waitOutcome(session, timedOut, matched, reason) {
    const tail = session.plainTail(WAIT_TEXT_BYTES)
    const durationMs =
      session.durationMs === null && (timedOut || matched)
        ? Math.max(0, Date.now() - session.startedAt)
        : session.durationMs
    return {
      terminalId: session.id,
      state: session.state,
      exitCode: session.exitCode,
      signal: session.signal,
      durationMs,
      timedOut,
      matched,
      text: tail.text,
      truncated: tail.truncated,
      reason,
    }
  }
}

/**
 * @param {SandboxInfo} sandbox current sandbox metadata.
 * @returns {Error & { code: string, sandbox: SandboxInfo }} structured error.
 */
function sandboxRequiredError(sandbox) {
  const error = new Error(
    `SANDBOX_REQUIRED: this terminal would run unsandboxed, but requireSandbox is enabled and the session sandbox mode is ${JSON.stringify(sandbox.mode)}`,
  )
  return Object.assign(error, { code: 'SANDBOX_REQUIRED', sandbox: { ...sandbox } })
}

/**
 * Session id spellings to try: the GUI and bare-id callers use the optional
 * `session-` prefix interchangeably.
 * @param {string} sessionId requested session id.
 * @returns {string[]} candidate ids.
 */
function sessionIdCandidates(sessionId) {
  return [sessionId, sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : `session-${sessionId}`]
}

/**
 * Find a live Session by id, tolerating the optional `session-` prefix that
 * the GUI and the bare-id spellings use interchangeably.
 * @param {any} store `ctx.sessions` service.
 * @param {string} sessionId requested session id.
 * @returns {any | undefined} the live session, when present.
 */
function findLiveSession(store, sessionId) {
  const candidates = sessionIdCandidates(sessionId)
  for (const candidate of candidates) {
    if (typeof store.get === 'function') {
      try {
        const session = store.get(candidate)
        if (session !== undefined && session !== null) return session
      } catch {
        // try the list fallback / next candidate
      }
    }
    if (typeof store.list === 'function') {
      try {
        const entries = store.list()
        if (Array.isArray(entries)) {
          const found = entries.find((entry) => entry?.id === candidate)
          if (found !== undefined) return found
        }
      } catch {
        // unknown store shape: treat as unresolved
      }
    }
  }
  return undefined
}

/**
 * First absolute `header.cwd` from session-query records.
 * @param {any[] | undefined} records session-query records.
 * @returns {string | undefined} absolute cwd.
 */
function headerCwdOf(records) {
  if (!Array.isArray(records)) return undefined
  for (const record of records) {
    const cwd = record?.header?.cwd
    if (typeof cwd === 'string' && isAbsolute(cwd) && cwd.length > 0) return cwd
  }
  return undefined
}

/**
 * Race a session exit against a timeout and an abort signal.
 * @param {TerminalPanelSession} session session to observe.
 * @param {number} timeoutMs timeout in milliseconds.
 * @param {AbortSignal} [signal] cancellation signal.
 * @returns {Promise<{ kind: 'exit' | 'timeout' | 'aborted' }>} race outcome.
 */
async function waitForExit(session, timeoutMs, signal) {
  if (session.state !== 'running') return { kind: 'exit' }
  if (signal?.aborted === true) return { kind: 'aborted' }
  return new Promise((resolve) => {
    let settled = false
    const finish = (kind) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ kind })
    }
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    timer.unref?.()
    const onAbort = () => finish('aborted')
    signal?.addEventListener('abort', onAbort, { once: true })
    session.whenExited.then(
      () => finish('exit'),
      () => finish('exit'),
    )
  })
}

/**
 * @param {TerminalPanelSession} session session.
 * @param {number} ms grace period.
 * @returns {Promise<void>} resolves when the session exited or the grace expired.
 */
async function settleWithGrace(session, ms) {
  await Promise.race([session.whenExited, sleep(ms)])
}

/**
 * Whether a finished command session counts as failed for auto-close purposes.
 * @param {any} session command session.
 * @returns {boolean} whether the command failed/timed out/was aborted.
 */
function isFailedCommand(session) {
  if (session.state === 'failed') return true
  if (session.signal !== null && session.signal !== undefined) return true
  return typeof session.exitCode === 'number' && session.exitCode !== 0
}

/**
 * Last non-empty plain-text line of a command session, bounded for a notice
 * (ANSI is already stripped by `plainTail`).
 * @param {any} session command session.
 * @param {number} maxBytes retained tail byte budget.
 * @returns {string} excerpt of at most 160 characters.
 */
function commandExcerpt(session, maxBytes) {
  let text = ''
  try {
    text = session.plainTail(Math.min(maxBytes, 64 * 1024)).text
  } catch {
    return ''
  }
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const last = lines.length > 0 ? lines[lines.length - 1] : ''
  return last.length > 160 ? `${last.slice(0, 159)}…` : last
}

/**
 * @param {unknown} value candidate timeout.
 * @param {number} fallback fallback timeout.
 * @returns {number} positive integer timeout.
 */
function positiveInteger(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  return fallback
}

/**
 * Human title for an interactive shell session.
 * @param {string} kind shell kind.
 * @returns {string} display title.
 */
function defaultShellTitle(kind) {
  if (kind === 'pwsh' || kind === 'powershell') return 'PowerShell'
  if (kind === 'cmd') return 'cmd'
  if (kind === 'bash' || kind === 'zsh' || kind === 'sh') return kind
  return '终端'
}
