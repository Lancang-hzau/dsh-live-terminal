/**
 * One visible PTY session: process handle + headless screen mirror + bounded
 * output tail + subscribers.
 *
 * All mutations of the mirror, the tail, the state and the broadcast order go
 * through one promise queue so that output chunks, user input and resizes are
 * serialised; a snapshot taken at any point therefore reflects a consistent
 * screen and sequence number.
 *
 * v1.2.1 additions: lifecycle timestamps (`startedAt`/`endedAt`/`durationMs`),
 * exit `signal`, shell/sandbox metadata, detected localhost ports, a bounded
 * output-frame ring for replay, a multi-client writer lease, auto-close
 * countdown state, and a client capture round-trip for PNG screenshots.
 */

import { randomUUID } from 'node:crypto'
import { commandOutputText, normalizeTerminalText } from './ansi.js'
import { extractPorts } from './ports.js'
import { ByteTail, tailByBytes } from './ring.js'
import { ScreenMirror } from './screen.js'

/** Parser poll interval for marker-wrapped commands. */
export const POLL_INTERVAL_MS = 25

const TERMINAL_TYPE = 'xterm-256color'

/** Maximum bytes retained by the replay frame ring (per session). */
const MAX_FRAME_BYTES = 4 * 1024 * 1024

/** Maximum number of localhost ports tracked per session. */
const MAX_PORTS = 32

/** Default sandbox metadata when the registry does not provide one. */
const DEFAULT_SANDBOX = Object.freeze({ mode: 'danger-full-access', confined: false, required: false })

/** Default capture wait budget (ms). */
const DEFAULT_CAPTURE_TIMEOUT_MS = 3000

/** Smallest capture wait budget (ms). */
const MIN_CAPTURE_TIMEOUT_MS = 50

/** Largest capture wait budget (ms). */
const MAX_CAPTURE_TIMEOUT_MS = 30_000

/**
 * @typedef {object} PortInfo
 * @property {string} url normalized URL.
 * @property {number} port TCP port.
 * @property {string} host host name.
 * @property {number} firstSeenAt epoch ms of first sighting.
 * @property {number} lastSeenAt epoch ms of the latest sighting.
 */

/**
 * @typedef {object} SandboxInfo
 * @property {string} mode session sandbox mode reported by the harness.
 * @property {boolean} confined whether the PTY was actually confined (always false in 1.2.1).
 * @property {boolean} required whether the plugin requires confinement.
 */

/**
 * Shared `SessionInfo` shape (host and client, see docs/impl-1.2.1-contract.md §2).
 *
 * @typedef {object} SessionInfo
 * @property {string} id session id.
 * @property {string} title display title.
 * @property {'command' | 'interactive'} kind session kind.
 * @property {'agent' | 'user'} owner session owner.
 * @property {string} [sessionId] DSH session id when known.
 * @property {string} [agentId] owning agent id when known.
 * @property {string} [command] command text of a command session.
 * @property {string} cwd working directory.
 * @property {number} cols terminal width.
 * @property {number} rows terminal height.
 * @property {'running' | 'exited' | 'failed'} state lifecycle state.
 * @property {number | null} exitCode process exit code.
 * @property {string | null} signal terminating signal.
 * @property {number} startedAt creation timestamp.
 * @property {number | null} endedAt exit timestamp.
 * @property {number | null} durationMs wall-clock duration (`null` while running).
 * @property {string} shellKind resolved shell kind (`pwsh`, `bash`, ...).
 * @property {PortInfo[]} ports detected localhost ports.
 * @property {SandboxInfo} sandbox sandbox metadata.
 * @property {number | null} autoCloseAt epoch ms of the scheduled auto-close.
 * @property {boolean} autoClosePaused whether the auto-close countdown is paused.
 * @property {boolean} pinned whether the user kept this terminal open.
 * @property {string} [error] failure message for failed sessions.
 * @property {number} createdAt creation timestamp.
 * @property {number} updatedAt last mutation timestamp.
 */

export class TerminalPanelSession {
  /** @type {string} */
  id
  /** @type {string} */
  title
  /** @type {'command' | 'interactive'} */
  kind
  /** @type {'agent' | 'user'} */
  owner
  /** @type {string | undefined} */
  sessionId
  /** @type {string | undefined} */
  agentId
  /** @type {string | undefined} */
  command
  /** @type {string} */
  cwd
  /** @type {number} */
  cols
  /** @type {number} */
  rows
  /** @type {'running' | 'exited' | 'failed'} */
  state = 'running'
  /** @type {number | null} */
  exitCode = null
  /** @type {string | null} */
  signal = null
  /** @type {number} */
  startedAt
  /** @type {number | null} */
  endedAt = null
  /** @type {number | null} */
  durationMs = null
  /** @type {string} */
  shellKind
  /** @type {SandboxInfo} */
  sandbox
  /** @type {boolean} */
  keepOpen = false
  /** @type {Map<string, PortInfo>} */
  ports = new Map()
  /** @type {string | null} */
  writerClientId = null
  /** @type {number | null} */
  autoCloseAt = null
  /** @type {boolean} */
  autoClosePaused = false
  /** @type {boolean} */
  pinned = false
  /** @type {number | null} epoch ms of the first output chunk. */
  firstOutputAt = null
  /** @type {string | undefined} */
  error
  /** @type {number} */
  createdAt
  /** @type {number} */
  updatedAt
  /** @type {number} */
  seq = 0

  /** @type {any} */
  #handle
  /** @type {ScreenMirror} */
  #screen
  /** @type {ByteTail} */
  #raw
  /** @type {Set<(name: string, data: any) => void>} */
  #subscribers = new Set()
  /** @type {TextDecoder} */
  #decoder = new TextDecoder('utf-8', { ignoreBOM: true })
  /** @type {Promise<void>} */
  #queue = Promise.resolve()
  /** @type {boolean} */
  #consuming = true
  /** @type {boolean} */
  #closing = false
  /** @type {Promise<void> | undefined} */
  #termination
  /** @type {Promise<void> | undefined} */
  #disposed
  /** @type {((info: SessionInfo) => void) | undefined} */
  #onExit
  /** @type {(() => void) | undefined} */
  #onChange
  /** @type {((session: TerminalPanelSession) => void) | undefined} */
  #onFirstOutput
  /** @type {((ports: PortInfo[]) => void) | undefined} */
  #onPort
  /** @type {boolean} */
  #portDetection
  /** @type {string} */
  #portTail = ''
  /** @type {{ seq: number, chunk: string }[]} */
  #frames = []
  /** @type {number} */
  #frameBytes = 0
  /** @type {Set<string>} attached browser clients. */
  #clients = new Set()
  /** @type {Map<string, { resolve: (value: { buffer: Buffer, width: number, height: number }) => void, reject: (error: unknown) => void, timer: NodeJS.Timeout }>} */
  #captures = new Map()
  /** @type {{ resolve: (value: { exitCode: number | null, signal: string | null }) => void, reject: (error: unknown) => void, promise: Promise<{ exitCode: number | null, signal: string | null }> }} */
  #exited

  /**
   * @param {object} options session creation options.
   * @param {string} options.id session id.
   * @param {string} options.title display title.
   * @param {'command' | 'interactive'} options.kind session kind.
   * @param {'agent' | 'user'} options.owner owner kind.
   * @param {any} options.handle `ctx.subprocess.spawnTerminal` handle.
   * @param {string} options.cwd working directory.
   * @param {number} options.cols initial columns.
   * @param {number} options.rows initial rows.
   * @param {number} options.scrollback retained scrollback rows for the mirror.
   * @param {number} options.maxOutputBytes retained plain/raw tail byte budget.
   * @param {string} [options.sessionId] DSH session id.
   * @param {string} [options.agentId] owning agent id.
   * @param {string} [options.command] command text.
   * @param {string} [options.shellKind] resolved shell kind.
   * @param {Partial<SandboxInfo>} [options.sandbox] sandbox metadata.
   * @param {boolean} [options.keepOpen] keep the terminal after exit.
   * @param {boolean} [options.portDetection] scan output for localhost ports (default true).
   * @param {(session: TerminalPanelSession) => void} [options.onFirstOutput] first output hook.
   * @param {(ports: PortInfo[]) => void} [options.onPort] new-port hook.
   * @param {(info: SessionInfo) => void} [options.onExit] registry exit hook.
   * @param {() => void} [options.onChange] registry change hook.
   */
  constructor(options) {
    this.id = options.id
    this.title = options.title
    this.kind = options.kind
    this.owner = options.owner
    this.sessionId = options.sessionId
    this.agentId = options.agentId
    this.command = options.command
    this.cwd = options.cwd
    this.cols = options.cols
    this.rows = options.rows
    this.shellKind = typeof options.shellKind === 'string' && options.shellKind.length > 0 ? options.shellKind : 'unknown'
    this.sandbox = normalizeSandbox(options.sandbox)
    this.keepOpen = options.keepOpen === true
    this.#portDetection = options.portDetection !== false
    this.createdAt = Date.now()
    this.startedAt = this.createdAt
    this.updatedAt = this.createdAt
    this.#handle = options.handle
    this.#raw = new ByteTail(options.maxOutputBytes)
    this.#onExit = options.onExit
    this.#onChange = options.onChange
    this.#onFirstOutput = options.onFirstOutput
    this.#onPort = options.onPort
    this.#screen = new ScreenMirror({ cols: options.cols, rows: options.rows, scrollback: options.scrollback })
    this.#exited = Promise.withResolvers()
    this.#consume().catch(() => {})
  }

  /** Whether the process is still running. */
  get running() {
    return this.state === 'running'
  }

  /** Plain SessionInfo snapshot shared with the browser. */
  get info() {
    /** @type {SessionInfo} */
    const info = {
      id: this.id,
      title: this.title,
      kind: this.kind,
      owner: this.owner,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      state: this.state,
      exitCode: this.exitCode,
      signal: this.signal,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      durationMs: this.durationMs,
      shellKind: this.shellKind,
      ports: [...this.ports.values()].map((port) => ({ ...port })),
      sandbox: { ...this.sandbox },
      autoCloseAt: this.autoCloseAt,
      autoClosePaused: this.autoClosePaused,
      pinned: this.pinned,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    }
    if (this.sessionId !== undefined) info.sessionId = this.sessionId
    if (this.agentId !== undefined) info.agentId = this.agentId
    if (this.command !== undefined) info.command = this.command
    if (this.error !== undefined) info.error = this.error
    return info
  }

  /**
   * Resolves once the process reports its outcome (after the final output was
   * flushed and the state was broadcast).
   * @returns {Promise<{ exitCode: number | null, signal: string | null }>} exit outcome.
   */
  get whenExited() {
    return this.#exited.promise
  }

  /**
   * The current screen: ANSI serialization, visible text, cursor and info.
   * @param {{ scrollback?: number }} [options] ANSI snapshot options; omit to serialize the whole retained buffer (tool screenshots keep that behavior).
   * @returns {{ info: SessionInfo, screen: string, text: string, cursor: { x: number, y: number }, seq: number, writerClientId: string | null }} snapshot.
   */
  snapshot(options = {}) {
    return {
      info: this.info,
      screen: this.#screen.serialize(options),
      text: this.#screen.visibleText(),
      cursor: this.#screen.cursor(),
      seq: this.seq,
      writerClientId: this.writerClientId,
    }
  }

  /**
   * Plain (ANSI-stripped) tail of the raw output.
   * @returns {string} normalized tail text.
   */
  plainText() {
    return normalizeTerminalText(this.#raw.text())
  }

  /**
   * Model-facing tail of the plain output.
   * @param {number} [maxBytes] byte bound for the returned text.
   * @returns {{ text: string, truncated: boolean }} output tail.
   */
  plainTail(maxBytes = this.#raw.maxBytes) {
    const normalized = this.plainText()
    const bounded = tailByBytes(normalized, maxBytes)
    return { text: commandOutputText(bounded.text), truncated: bounded.truncated }
  }

  /**
   * Visible screen text (for screenshots).
   * @returns {string} visible screen text.
   */
  visibleText() {
    return this.#screen.visibleText()
  }

  /**
   * Full retained buffer text, scrollback included.
   * @returns {string} retained buffer text.
   */
  fullText() {
    return this.#screen.fullText()
  }

  /**
   * ANSI serialization of the screen (`scrollback` rows included by default).
   * @param {{ scrollback?: number }} [options] serialization options.
   * @returns {string} serialized screen.
   */
  serialize(options) {
    return this.#screen.serialize(options)
  }

  /**
   * Read a line window from the retained plain text.
   *
   * `offset` is newest-relative: `0` means the most recent line; a window of
   * `lines` ends `offset` lines before the newest one. Line numbers in the
   * result are 1-based; `endLine` is inclusive.
   *
   * @param {{ offset?: number, lines?: number }} [options] window options.
   * @returns {{ text: string, startLine: number, endLine: number, totalLines: number, truncated: boolean }} window.
   */
  readLines(options = {}) {
    const lines = clampInteger(options.lines, 50, 1, 500)
    const offset = clampInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER)
    const all = splitLines(commandOutputText(this.plainText()))
    const total = all.length
    const endExclusive = Math.max(0, total - offset)
    const start = Math.max(0, endExclusive - lines)
    return {
      text: all.slice(start, endExclusive).join('\n'),
      startLine: total === 0 || endExclusive === 0 ? 0 : start + 1,
      endLine: endExclusive,
      totalLines: total,
      truncated: start > 0 || endExclusive < total,
    }
  }

  /**
   * Search the retained output (or just the visible screen).
   *
   * @param {{ pattern?: string, regex?: boolean, scope?: 'visible' | 'scrollback' | 'all', maxResults?: number, contextLines?: number }} options search options.
   * @returns {{ matches: { line: number, text: string, before?: string[], after?: string[] }[], truncated: boolean, totalLines: number }} matches.
   */
  search(options = {}) {
    const pattern = typeof options.pattern === 'string' ? options.pattern : ''
    if (pattern.length === 0) throw new Error('pattern must be a non-empty string')
    if (pattern.length > 500) throw new Error('pattern must be at most 500 characters')
    const maxResults = clampInteger(options.maxResults, 50, 1, 500)
    const contextLines = clampInteger(options.contextLines, 0, 0, 5)
    const useRegex = options.regex === true
    let matcher
    if (useRegex) {
      try {
        matcher = new RegExp(pattern)
      } catch (error) {
        throw new Error(`invalid regular expression: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const visible = options.scope === 'visible'
    const source = splitLines(visible ? this.visibleText() : commandOutputText(this.plainText()))
    /** @type {{ line: number, text: string, before?: string[], after?: string[] }[]} */
    const matches = []
    let truncated = false
    for (let index = 0; index < source.length; index += 1) {
      const line = source[index]
      const hit = matcher === undefined ? line.includes(pattern) : matcher.test(line)
      if (!hit) continue
      if (matches.length >= maxResults) {
        truncated = true
        break
      }
      /** @type {{ line: number, text: string, before?: string[], after?: string[] }} */
      const match = { line: index + 1, text: line }
      if (contextLines > 0) {
        match.before = source.slice(Math.max(0, index - contextLines), index)
        match.after = source.slice(index + 1, index + 1 + contextLines)
      }
      matches.push(match)
    }
    return { matches, truncated, totalLines: source.length }
  }

  /**
   * Output frames newer than `seq` (for SSE replay/export).
   *
   * @param {number} [seq] exclusive lower bound; `0` returns the retained ring.
   * @returns {{ seq: number, chunk: string }[]} retained frames.
   */
  framesSince(seq = 0) {
    const from = Number.isSafeInteger(seq) && seq >= 0 ? seq : 0
    return this.#frames.filter((frame) => frame.seq > from).map((frame) => ({ seq: frame.seq, chunk: frame.chunk }))
  }

  /**
   * Export the retained content as plain text or ANSI.
   *
   * @param {'text' | 'ansi'} [format] export format.
   * @returns {{ text: string, bytes: number, truncated: boolean }} export payload.
   */
  exportText(format = 'text') {
    const text = format === 'ansi' ? this.serialize() : commandOutputText(this.plainText())
    return { text, bytes: Buffer.byteLength(text, 'utf8'), truncated: false }
  }

  /**
   * Rename the terminal.
   *
   * @param {string} title new display title.
   * @returns {SessionInfo} updated info.
   */
  setTitle(title) {
    const value = typeof title === 'string' ? title.trim() : ''
    if (value.length === 0) throw new Error('title must be a non-empty string')
    this.title = value.slice(0, 200)
    this.updatedAt = Date.now()
    this.#onChange?.()
    this.#broadcastState()
    return this.info
  }

  /**
   * @param {boolean} value whether the terminal should be kept after exit.
   * @returns {void}
   */
  setKeepOpen(value) {
    this.keepOpen = value === true
  }

  /**
   * Pin/unpin the terminal (pin also cancels auto-close in the registry).
   *
   * @param {boolean} value pinned flag.
   * @returns {SessionInfo} updated info.
   */
  setPinned(value) {
    this.pinned = value === true
    this.updatedAt = Date.now()
    this.#broadcastState()
    return this.info
  }

  /**
   * Set (or clear) the scheduled auto-close timestamp; registry-owned.
   *
   * @param {number | null} at epoch ms, or `null` to clear.
   * @returns {void}
   */
  setAutoCloseAt(at) {
    this.autoCloseAt = typeof at === 'number' && Number.isFinite(at) ? at : null
    this.updatedAt = Date.now()
    this.#broadcastState()
  }

  /**
   * Set the auto-close paused flag without changing the remaining countdown.
   *
   * @param {boolean} value paused flag.
   * @returns {void}
   */
  setAutoClosePaused(value) {
    const next = value === true
    if (this.autoClosePaused === next) return
    this.autoClosePaused = next
    this.updatedAt = Date.now()
    this.#broadcastState()
  }

  /**
   * Pause the auto-close countdown (registry clears its timer separately).
   *
   * @param {string} [reason] optional pause reason for diagnostics.
   * @returns {SessionInfo} updated info.
   */
  pauseAutoClose(reason) {
    if (!this.autoClosePaused) {
      this.autoClosePaused = true
      this.updatedAt = Date.now()
    }
    this.#broadcastState()
    return this.info
  }

  /**
   * Resume the auto-close countdown; the registry re-schedules the timer.
   *
   * @returns {SessionInfo} updated info.
   */
  resumeAutoClose() {
    if (this.autoClosePaused) {
      this.autoClosePaused = false
      this.updatedAt = Date.now()
    }
    this.#broadcastState()
    return this.info
  }

  /**
   * Deliver one signal to the session.
   *
   * `SIGINT` is written as ETX (`\x03`) so the PTY line discipline delivers it
   * to the foreground process; every other accepted name terminates the whole
   * process tree. (Named `sendSignal` because the `signal` field already stores
   * the terminating signal; the contract's `signal(name)` method is exposed as
   * `TerminalRegistry.signal`.)
   *
   * @param {string} name signal name.
   * @returns {Promise<{ delivered: string }>} delivery acknowledgement.
   */
  async sendSignal(name) {
    const upper = typeof name === 'string' ? name.trim().toUpperCase() : ''
    if (upper === 'SIGINT') {
      if (this.state !== 'running') throw new Error(`terminal ${this.id} is not running`)
      await this.write('\x03')
      return { delivered: 'SIGINT' }
    }
    const allowed = new Set(['SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGTSTP'])
    if (!allowed.has(upper)) {
      throw new Error(`unsupported signal ${JSON.stringify(name)}; allowed: SIGINT, SIGTERM, SIGKILL, SIGHUP, SIGTSTP`)
    }
    await this.terminate()
    return { delivered: upper }
  }

  /**
   * Write raw input text into the PTY.
   * @param {string} data raw UTF-8 input (may contain control characters).
   * @returns {Promise<void>} after the handle accepted the write.
   */
  write(data) {
    if (typeof data !== 'string' || data.length === 0) return Promise.resolve()
    return this.#enqueue(async () => {
      if (this.state !== 'running') throw new Error(`terminal ${this.id} is not running`)
      await this.#handle.write(data)
      this.updatedAt = Date.now()
    })
  }

  /**
   * Resize the PTY and the screen mirror.
   * @param {number} cols new columns.
   * @param {number} rows new rows.
   * @returns {Promise<void>} after the resize was applied.
   */
  resize(cols, rows) {
    return this.#enqueue(async () => {
      if (this.state !== 'running') throw new Error(`terminal ${this.id} is not running`)
      await this.#handle.resize(cols, rows)
      this.#screen.resize(cols, rows)
      this.cols = cols
      this.rows = rows
      this.updatedAt = Date.now()
      this.#broadcastState()
      this.#onChange?.()
    })
  }

  /**
   * Attach a browser client; the first client claims the input lease.
   *
   * @param {string} clientId stable browser client id.
   * @returns {{ writerClientId: string | null }} lease state.
   */
  attachClient(clientId) {
    assertClientId(clientId)
    this.#clients.add(clientId)
    if (this.writerClientId === null) this.writerClientId = clientId
    this.#broadcastState()
    return { writerClientId: this.writerClientId }
  }

  /**
   * Detach a browser client; the lease is released (or promoted) when its owner
   * leaves.
   *
   * @param {string} clientId stable browser client id.
   * @returns {{ writerClientId: string | null }} lease state.
   */
  detachClient(clientId) {
    if (typeof clientId !== 'string' || clientId.length === 0) return { writerClientId: this.writerClientId }
    this.#clients.delete(clientId)
    if (this.writerClientId === clientId) {
      const next = this.#clients.values().next()
      this.writerClientId = next.done === true ? null : next.value
    }
    this.#broadcastState()
    return { writerClientId: this.writerClientId }
  }

  /**
   * Make one attached client the writer.
   *
   * @param {string} clientId stable browser client id.
   * @returns {{ writerClientId: string | null }} lease state.
   */
  takeControl(clientId) {
    assertClientId(clientId)
    this.#clients.add(clientId)
    this.writerClientId = clientId
    this.#broadcastState()
    return { writerClientId: this.writerClientId }
  }

  /**
   * @param {string | undefined} clientId stable browser client id.
   * @returns {boolean} whether the client may write.
   */
  isWritable(clientId) {
    if (this.writerClientId === null) return true
    return typeof clientId === 'string' && clientId === this.writerClientId
  }

  /**
   * Ask the connected browser to render the screen to a PNG and POST it back.
   *
   * @param {{ timeoutMs?: number }} [options] wait options.
   * @returns {Promise<{ buffer: Buffer, width: number, height: number }>} captured PNG.
   */
  requestCapture(options = {}) {
    if (this.#disposed !== undefined) return Promise.reject(new Error('terminal screen mirror disposed'))
    const timeoutMs = clampInteger(options.timeoutMs, DEFAULT_CAPTURE_TIMEOUT_MS, MIN_CAPTURE_TIMEOUT_MS, MAX_CAPTURE_TIMEOUT_MS)
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#captures.get(requestId)
        if (pending === undefined) return
        this.#captures.delete(requestId)
        reject(Object.assign(new Error('capture request timed out'), { code: 'CAPTURE_TIMEOUT', requestId }))
      }, timeoutMs)
      this.#captures.set(requestId, { resolve, reject, timer })
      this.#broadcast('capture-request', { terminalId: this.id, requestId })
    })
  }

  /**
   * Resolve a pending capture request with the client-rendered PNG.
   *
   * @param {string} requestId request id echoed by the client.
   * @param {{ buffer?: Buffer | Uint8Array | string, width?: number, height?: number }} payload captured image.
   * @returns {boolean} whether the request was pending.
   */
  resolveCapture(requestId, payload) {
    if (typeof requestId !== 'string' || requestId.length === 0) throw new Error('requestId is required')
    const pending = this.#captures.get(requestId)
    if (pending === undefined) return false
    const buffer = toImageBuffer(payload?.buffer)
    this.#captures.delete(requestId)
    clearTimeout(pending.timer)
    if (buffer === undefined) {
      pending.reject(Object.assign(new Error('capture payload is not a PNG/JPEG buffer'), { code: 'CAPTURE_INVALID' }))
      return false
    }
    pending.resolve({
      buffer,
      width: Number.isSafeInteger(payload?.width) ? payload.width : 0,
      height: Number.isSafeInteger(payload?.height) ? payload.height : 0,
    })
    return true
  }

  /**
   * Wait until shell startup output has been quiet for a short while, so the
   * first marker-wrapped command is not typed into a half-initialised shell.
   * @param {{ quietMs?: number, timeoutMs?: number, signal?: AbortSignal }} [options] wait tuning.
   * @returns {Promise<void>} resolves on quiet/timeout/exit.
   */
  async waitReady(options = {}) {
    const quietMs = options.quietMs ?? 120
    const timeoutMs = options.timeoutMs ?? 3000
    const startedAt = Date.now()
    let lastBytes = this.#raw.byteLength
    let quietSince = Date.now()
    while (this.state === 'running') {
      if (options.signal?.aborted === true) return
      await sleep(POLL_INTERVAL_MS)
      const bytes = this.#raw.byteLength
      if (bytes !== lastBytes) {
        lastBytes = bytes
        quietSince = Date.now()
        continue
      }
      if (Date.now() - quietSince >= quietMs) return
      if (Date.now() - startedAt >= timeoutMs) return
    }
  }

  /**
   * Subscribe to session events (`output`, `state`, `exit`, `capture-request`).
   * @param {(name: string, data: any) => void} listener event listener.
   * @returns {() => void} disposer.
   */
  subscribe(listener) {
    this.#subscribers.add(listener)
    return () => {
      this.#subscribers.delete(listener)
    }
  }

  /**
   * Terminate the process range. Idempotent.
   * @returns {Promise<void>} after the process tree settled.
   */
  terminate() {
    if (this.#termination !== undefined) return this.#termination
    this.#closing = true
    this.#termination = (async () => {
      try {
        if (typeof this.#handle.terminate === 'function') await this.#handle.terminate()
      } catch {
        // The process may have exited between the state check and terminate.
      }
    })()
    return this.#termination
  }

  /**
   * Terminate and release the headless mirror. Only valid once the session is
   * removed from the registry (retained exited sessions keep their screen).
   * @returns {Promise<void>} after cleanup.
   */
  dispose() {
    if (this.#disposed !== undefined) return this.#disposed
    this.#disposed = (async () => {
      for (const [requestId, pending] of this.#captures) {
        clearTimeout(pending.timer)
        pending.reject(Object.assign(new Error('terminal disposed before the capture arrived'), { code: 'TERMINAL_DISPOSED', requestId }))
      }
      this.#captures.clear()
      this.#clients.clear()
      await this.terminate()
      this.#subscribers.clear()
      this.#screen.dispose()
    })()
    return this.#disposed
  }

  /**
   * Append one decoded output chunk: mirror it, retain it, then broadcast.
   * @param {string} data decoded text.
   * @returns {Promise<void>} after the broadcast.
   */
  #output(data) {
    if (data.length === 0) return Promise.resolve()
    return this.#enqueue(async () => {
      await this.#screen.write(data)
      this.#raw.append(data)
      this.seq += 1
      this.updatedAt = Date.now()
      this.#recordFrame(this.seq, data)
      if (this.firstOutputAt === null) {
        this.firstOutputAt = this.updatedAt
        try {
          this.#onFirstOutput?.(this)
        } catch {
          // first-output hooks must never break output consumption
        }
      }
      this.#detectPorts(data)
      this.#broadcast('output', { id: this.id, seq: this.seq, chunk: data })
    })
  }

  /**
   * Feed one chunk through localhost-port detection.
   *
   * A tiny rolling tail joins split URL fragments across chunks; new ports are
   * reported through the registry hook and persisted on the session info.
   *
   * @param {string} data decoded output chunk.
   * @returns {void}
   */
  #detectPorts(data) {
    if (!this.#portDetection) return
    let cleaned
    try {
      cleaned = normalizeTerminalText(data)
    } catch {
      return
    }
    const combined = this.#portTail + cleaned
    this.#portTail = combined.length > 512 ? combined.slice(-512) : combined
    let found
    try {
      found = extractPorts(combined)
    } catch {
      return
    }
    if (found.length === 0) return
    /** @type {PortInfo[]} */
    const added = []
    for (const port of found) {
      const existing = this.ports.get(port.url)
      if (existing !== undefined) {
        existing.lastSeenAt = port.lastSeenAt
        continue
      }
      if (this.ports.size >= MAX_PORTS) {
        const oldest = [...this.ports.values()].sort((left, right) => left.firstSeenAt - right.firstSeenAt)[0]
        if (oldest !== undefined) this.ports.delete(oldest.url)
      }
      this.ports.set(port.url, port)
      added.push(port)
    }
    if (added.length === 0) return
    try {
      this.#onPort?.(added)
    } catch {
      // port hooks must never break output consumption
    }
  }

  /**
   * Retain one output frame in the bounded replay ring.
   *
   * @param {number} seq frame sequence number.
   * @param {string} chunk output chunk.
   * @returns {void}
   */
  #recordFrame(seq, chunk) {
    this.#frames.push({ seq, chunk })
    this.#frameBytes += Buffer.byteLength(chunk, 'utf8')
    while (this.#frameBytes > MAX_FRAME_BYTES && this.#frames.length > 1) {
      const dropped = this.#frames.shift()
      if (dropped === undefined) break
      this.#frameBytes -= Buffer.byteLength(dropped.chunk, 'utf8')
    }
  }

  /** Broadcast a state frame carrying the writer lease. */
  #broadcastState() {
    this.#broadcast('state', { info: this.info, writerClientId: this.writerClientId })
  }

  async #consume() {
    const outcome = this.#handle.done.then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    )
    try {
      for await (const chunk of this.#handle.output) {
        const data = this.#decoder.decode(chunk, { stream: true })
        await this.#output(data)
      }
      const flushed = this.#decoder.decode()
      await this.#output(flushed)
      const result = await outcome
      if (!result.ok) throw result.error
      const value = result.value ?? {}
      this.#finish({ state: 'exited', exitCode: value.exitCode ?? null, signal: value.signal ?? null })
    } catch (error) {
      // The PTY stream/session errored: kill the process tree as well, otherwise
      // the failed session would leave an orphan shell behind. Fire-and-forget:
      // terminating may itself await the provider and must not delay the state
      // transition or reject this consumer.
      void this.terminate().catch(() => {})
      this.#finish({
        state: 'failed',
        exitCode: null,
        signal: null,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.#consuming = false
    }
  }

  /**
   * Publish the terminal outcome once.
   * @param {{ state: 'exited' | 'failed', exitCode: number | null, signal: string | null, error?: string }} outcome terminal outcome.
   * @returns {void}
   */
  #finish(outcome) {
    if (this.state !== 'running') return
    this.state = outcome.state
    this.exitCode = outcome.exitCode
    this.signal = outcome.signal
    this.endedAt = Date.now()
    this.durationMs = Math.max(0, this.endedAt - this.startedAt)
    if (outcome.error !== undefined) this.error = outcome.error
    this.updatedAt = this.endedAt
    this.#exited.resolve({ exitCode: this.exitCode, signal: this.signal })
    this.#broadcastState()
    this.#broadcast('exit', { id: this.id, exitCode: this.exitCode, signal: this.signal, durationMs: this.durationMs })
    this.#onChange?.()
    try {
      this.#onExit?.(this.info)
    } catch {
      // Registry hooks must never break output consumption.
    }
  }

  #enqueue(operation) {
    const run = this.#queue.then(operation, operation)
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  #broadcast(name, data) {
    for (const listener of this.#subscribers) {
      try {
        listener(name, data)
      } catch {
        // A broken SSE writer must not stop the PTY consumer.
      }
    }
  }
}

/**
 * @param {number} ms milliseconds.
 * @returns {Promise<void>} timer promise.
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Clamp one integer option into a range.
 *
 * @param {unknown} value candidate number.
 * @param {number} fallback default when the value is not an integer.
 * @param {number} min lower bound.
 * @param {number} max upper bound.
 * @returns {number} clamped integer.
 */
function clampInteger(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/**
 * @param {string} text plain text.
 * @returns {string[]} line list.
 */
function splitLines(text) {
  const value = typeof text === 'string' ? text : ''
  if (value.length === 0) return []
  return value.split('\n')
}

/**
 * Normalize sandbox metadata from the registry.
 *
 * @param {Partial<SandboxInfo> | undefined} sandbox candidate metadata.
 * @returns {SandboxInfo} complete metadata.
 */
function normalizeSandbox(sandbox) {
  if (sandbox === null || sandbox === undefined || typeof sandbox !== 'object') return { ...DEFAULT_SANDBOX }
  return {
    mode: typeof sandbox.mode === 'string' && sandbox.mode.length > 0 ? sandbox.mode : DEFAULT_SANDBOX.mode,
    confined: sandbox.confined === true,
    required: sandbox.required === true,
  }
}

/**
 * @param {string} clientId candidate client id.
 * @returns {void}
 */
function assertClientId(clientId) {
  if (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > 200) {
    throw new Error('clientId must be a non-empty string (max 200 chars)')
  }
}

/**
 * Decode an image payload from a route/client into a Buffer.
 *
 * Accepts a Buffer, a Uint8Array or a `data:image/...;base64,...` string; only
 * PNG/JPEG/WebP signatures are accepted because the attachment service only
 * stores those media types.
 *
 * @param {unknown} value candidate payload.
 * @returns {Buffer | undefined} image bytes.
 */
function toImageBuffer(value) {
  let buffer
  if (Buffer.isBuffer(value)) buffer = value
  else if (value instanceof Uint8Array) buffer = Buffer.from(value)
  else if (typeof value === 'string' && value.length > 0) {
    const comma = value.indexOf(',')
    const base64 = value.startsWith('data:') && comma >= 0 ? value.slice(comma + 1) : value
    try {
      buffer = Buffer.from(base64, 'base64')
    } catch {
      return undefined
    }
  } else return undefined
  if (buffer.length < 8) return undefined
  const png = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8
  const webp = buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  if (!png && !jpeg && !webp) return undefined
  return buffer
}

export { TERMINAL_TYPE }
