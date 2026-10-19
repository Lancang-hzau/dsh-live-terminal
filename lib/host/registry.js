/**
 * Session registry for the terminal panel.
 *
 * Owns the PTY sessions, resolves the shell once, keeps one default
 * interactive terminal per agent, and enforces the session/retention limits.
 * Visible commands run in their own one-shot `kind: 'command'` sessions; the
 * per-agent interactive terminal is only used by `live_terminal_send` /
 * `live_terminal_read`.
 *
 * HTTP routes, model-facing tools and the built-in shell interceptor all use
 * this one registry, so the panel always shows the same terminals.
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve as resolvePath } from 'node:path'
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

export class TerminalRegistry {
  /** @type {Map<string, TerminalPanelSession>} */
  #sessions = new Map()
  /** @type {Map<string, string>} agent id -> default interactive session id. */
  #agentTerminals = new Map()
  /** @type {Set<string>} in-flight default terminals protected from capacity reclamation. */
  #startingDefaults = new Set()
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
  /** @type {{ scrollback: number, maxOutputBytes: number, maxSessions: number, commandTimeoutMs: number, retainExited: number, shellPath?: string }} */
  #config
  /** @type {Map<string, Promise<{ path: string, kind: string }>>} cache per shell-kind hint ('' = no hint). */
  #shellPromises = new Map()
  /** @type {number} capacity slots reserved by in-flight creations. */
  #pending = 0
  /** @type {boolean} */
  #disposed = false

  /**
   * @param {{ subprocess: any, workingDirectory: any, sessions?: any, getSessionStore?: () => any, sessionQuery?: any, getSessionQuery?: () => any, logger?: any, config: object }} options registry services and config.
   */
  constructor({ subprocess, workingDirectory, sessions, getSessionStore, sessionQuery, getSessionQuery, logger, config }) {
    if (subprocess === undefined || subprocess === null) throw new Error('dsh-live-terminal: subprocess service is required')
    this.#subprocess = subprocess
    this.#workingDirectory = workingDirectory
    this.#sessionStore = sessions
    this.#getSessionStore = typeof getSessionStore === 'function' ? getSessionStore : undefined
    this.#sessionQuery = sessionQuery
    this.#getSessionQuery = typeof getSessionQuery === 'function' ? getSessionQuery : undefined
    this.#logger = logger
    this.#config = config
  }

  /** Number of live + retained sessions. */
  get size() {
    return this.#sessions.size
  }

  /** Resolved configuration (read-only by convention). */
  get config() {
    return this.#config
  }

  /**
   * All sessions as plain `SessionInfo` values, oldest first.
   * @returns {import('./session.js').SessionInfo[]} session infos.
   */
  list() {
    return [...this.#sessions.values()]
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
   * Resolve the most recent visible session owned by an agent, preferring a
   * command session over an interactive one. This is the default screenshot
   * target: after `live_terminal_run` the model can screenshot the command it
   * just ran without passing an id, and a finished (retained) command session
   * is still a valid screenshot target.
   * @param {any} agent owning agent.
   * @returns {TerminalPanelSession | undefined} most recent owned session.
   */
  resolveRecentForAgent(agent) {
    const agentId = agent?.id
    if (typeof agentId !== 'string' || agentId.length === 0) return undefined
    const owned = [...this.#sessions.values()]
      .map((session, index) => ({ session, index }))
      .filter((entry) => entry.session.owner === 'agent' && entry.session.agentId === agentId)
      .sort((left, right) => right.session.createdAt - left.session.createdAt || right.index - left.index)
    const commands = owned.filter((entry) => entry.session.kind === 'command')
    if (commands.length > 0) return commands[0].session
    const interactive = owned.filter((entry) => entry.session.kind === 'interactive')
    return interactive[0]?.session
  }

  /**
   * Subscribe to global session-list events (`sessions`).
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
   * @param {object} options command session options.
   * @param {string} options.command command text.
   * @param {string} [options.cwd] working directory.
   * @param {number} [options.cols] columns.
   * @param {number} [options.rows] rows.
   * @param {string} [options.shellKindHint] requested shell kind (`pwsh` | `bash`) for the command shell.
   * @param {string} [options.agentId] owning agent id.
   * @param {string} [options.sessionId] DSH session id.
   * @param {string} [options.title] display title.
   * @param {any} [options.agent] owning agent (for cwd resolution).
   * @param {AbortSignal} [options.signal] allocation cancellation.
   * @returns {Promise<TerminalPanelSession>} created session.
   */
  async createCommandSession(options) {
    const command = typeof options.command === 'string' ? options.command : ''
    if (command.trim().length === 0) throw new Error('command must be a non-empty string')
    const dimensions = normalizeDimensions(options.cols, options.rows)
    const shell = await this.#shell(options.signal, options.shellKindHint)
    const cwd = await this.#resolveCwd({ agent: options.agent, cwd: options.cwd, signal: options.signal })
    await this.#reserveSlot()
    return this.#spawn({
      argv: commandArgv(shell, command),
      kind: 'command',
      owner: options.agentId === undefined ? 'user' : 'agent',
      command,
      title: options.title ?? commandTitle(command),
      cols: dimensions.cols,
      rows: dimensions.rows,
      cwd,
      sessionId: options.sessionId,
      agentId: options.agentId,
      signal: options.signal,
    })
  }

  /**
   * Create an interactive session.
   * @param {object} options interactive session options.
   * @param {string} [options.cwd] working directory.
   * @param {number} [options.cols] columns.
   * @param {number} [options.rows] rows.
   * @param {string} [options.agentId] owning agent id.
   * @param {string} [options.sessionId] DSH session id.
   * @param {string} [options.title] display title.
   * @param {'agent' | 'user'} [options.owner] owner kind.
   * @param {any} [options.agent] owning agent (for cwd resolution).
   * @param {AbortSignal} [options.signal] allocation cancellation.
   * @param {boolean} [options.startingDefault] protect the session as an in-flight agent default terminal until `ensureAgentTerminal` finishes its readiness probe (capacity reclamation must not mistake it for an idle extra).
   * @returns {Promise<TerminalPanelSession>} created session.
   */
  async createInteractive(options = {}) {
    const dimensions = normalizeDimensions(options.cols, options.rows)
    const shell = await this.#shell(options.signal)
    const cwd = await this.#resolveCwd({ agent: options.agent, cwd: options.cwd, signal: options.signal })
    await this.#reserveSlot()
    return this.#spawn({
      argv: interactiveArgv(shell),
      kind: 'interactive',
      owner: options.owner ?? 'user',
      title: options.title ?? defaultShellTitle(shell.kind),
      cols: dimensions.cols,
      rows: dimensions.rows,
      cwd,
      sessionId: options.sessionId,
      agentId: options.agentId,
      signal: options.signal,
      startingDefault: options.startingDefault === true,
    })
  }

  /**
   * Reuse or create the agent's default interactive terminal.
   * @param {any} agent owning agent.
   * @param {{ cwd?: string, cols?: number, rows?: number, title?: string, signal?: AbortSignal }} [options] creation options.
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
        signal: options.signal,
        // Protect this session from capacity reclamation while its readiness
        // probe runs: the mapping below is only published once the shell is
        // usable, and #startingDefaults closes that window.
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
        // The session is now either registered as the default terminal or was
        // closed by close() above, so it no longer needs startup protection.
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
   * @returns {Promise<{ output: string, truncated: boolean, exitCode: number | null, signal: string | null, timedOut: boolean, aborted: boolean }>} outcome.
   */
  async waitForCommandSession(session, options = {}) {
    const timeoutMs = positiveInteger(options.timeoutMs, this.#config.commandTimeoutMs)
    const outcome = await waitForExit(session, timeoutMs, options.signal)
    if (outcome.kind !== 'exit') {
      try {
        await session.terminate()
      } catch {
        // ignore
      }
      await settleWithGrace(session, 1500)
    }
    const tail = session.plainTail(this.#config.maxOutputBytes)
    return {
      output: tail.text,
      truncated: tail.truncated,
      exitCode: outcome.kind === 'exit' ? session.exitCode : null,
      signal: outcome.kind === 'exit' ? session.signal : 'SIGTERM',
      timedOut: outcome.kind === 'timeout',
      aborted: outcome.kind === 'aborted',
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
   * Terminate and remove one session (retained exited sessions included).
   * @param {string} id session id.
   * @returns {Promise<boolean>} whether a session was removed.
   */
  async close(id) {
    const session = this.#sessions.get(id)
    if (session === undefined) return false
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
    const sessions = [...this.#sessions.values()]
    this.#sessions.clear()
    this.#agentTerminals.clear()
    this.#startingDefaults.clear()
    this.#creating.clear()
    this.#shellPromises.clear()
    this.#eventSubscribers.clear()
    await Promise.allSettled(sessions.map((session) => session.dispose()))
  }

  async #spawn(options) {
    try {
      if (this.#disposed) throw new Error('terminal registry disposed')
      let handle
      try {
        handle = await this.#subprocess.spawnTerminal({
          argv: options.argv,
          cwd: options.cwd,
          cols: options.cols,
          rows: options.rows,
          terminalType: TERMINAL_TYPE,
          ...(options.sessionId === undefined ? {} : { env: { DSH_SESSION_ID: options.sessionId } }),
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
          scrollback: this.#config.scrollback,
          maxOutputBytes: this.#config.maxOutputBytes,
          onChange: () => this.#emitSessions(),
          onExit: () => this.#handleExit(id),
        })
        this.#sessions.set(id, session)
        // A default terminal that is still in its readiness probe is protected
        // from capacity reclamation: the agent-terminal mapping below is only
        // published once waitReady finished, and without this set the session
        // would look like an idle agent extra in that window.
        if (options.startingDefault === true) this.#startingDefaults.add(id)
        this.#emitSessions()
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
      this.#releaseSlot()
    }
  }

  #handleExit(id) {
    const session = this.#sessions.get(id)
    if (session === undefined) return
    if (session.agentId !== undefined && this.#agentTerminals.get(session.agentId) === id) {
      this.#agentTerminals.delete(session.agentId)
    }
    if (session.kind === 'command') void this.#pruneRetainedCommands()
  }

  async #pruneRetainedCommands() {
    const exited = [...this.#sessions.values()]
      .filter((session) => session.kind === 'command' && session.state !== 'running')
      .sort((left, right) => left.updatedAt - right.updatedAt)
    while (exited.length > this.#config.retainExited) {
      const oldest = exited.shift()
      if (oldest === undefined) break
      await this.close(oldest.id).catch(() => {})
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
   * Reserve one session slot. `#ensureCapacity` may await closing sessions, so
   * the final check-and-increment below is synchronous: two concurrent creators
   * can never both observe the same free slot.
   * @returns {Promise<void>} after the slot was reserved.
   */
  async #reserveSlot() {
    await this.#ensureCapacity()
    if (this.#usedSlots() >= this.#config.maxSessions) {
      throw new Error(`terminal session limit reached (maxSessions=${this.#config.maxSessions})`)
    }
    this.#pending += 1
  }

  /**
   * Release one slot reserved by {@link #reserveSlot}.
   * @returns {void}
   */
  #releaseSlot() {
    if (this.#pending > 0) this.#pending -= 1
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
    if (this.#startingDefaults.has(session.id)) return false
    if (session.agentId !== undefined && this.#agentTerminals.get(session.agentId) === session.id) return false
    return true
  }

  async #ensureCapacity() {
    const limit = this.#config.maxSessions
    if (this.#usedSlots() < limit) return
    const closable = [...this.#sessions.values()]
      .filter((session) => session.state !== 'running')
      .sort((left, right) => left.updatedAt - right.updatedAt)
    for (const session of closable) {
      if (this.#usedSlots() < limit) break
      await this.close(session.id).catch(() => {})
    }
    if (this.#usedSlots() >= limit) {
      // Long-running hosts accumulate one interactive terminal per agent; reclaim
      // idle extras (oldest first) instead of failing a legitimate new terminal.
      // User terminals and each agent's default terminal are never reclaimed.
      const reclaimable = [...this.#sessions.values()]
        .filter((session) => this.#isReclaimableInteractive(session))
        .sort((left, right) => left.updatedAt - right.updatedAt)
      for (const session of reclaimable) {
        if (this.#usedSlots() < limit) break
        await this.close(session.id).catch(() => {})
      }
    }
    if (this.#usedSlots() >= limit) {
      throw new Error(`terminal session limit reached (maxSessions=${limit})`)
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
      shellPath: this.#config.shellPath,
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

  async #invalidate(session) {
    try {
      await session.terminate()
    } catch {
      // ignore
    }
    if (session.agentId !== undefined && this.#agentTerminals.get(session.agentId) === session.id) {
      this.#agentTerminals.delete(session.agentId)
    }
    await settleWithGrace(session, 1500)
  }

  #emitSessions() {
    if (this.#eventSubscribers.size === 0) return
    const payload = { sessions: this.list() }
    for (const listener of this.#eventSubscribers) {
      try {
        listener('sessions', payload)
      } catch {
        // A broken SSE writer must not break session bookkeeping.
      }
    }
  }
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
 * @param {number} ms grace period.
 * @returns {void}
 */
async function settleWithGrace(session, ms) {
  await Promise.race([session.whenExited, sleep(ms)])
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
