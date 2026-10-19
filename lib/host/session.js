/**
 * One visible PTY session: process handle + headless screen mirror + bounded
 * output tail + subscribers.
 *
 * All mutations of the mirror, the tail, the state and the broadcast order go
 * through one promise queue so that output chunks, user input and resizes are
 * serialised; a snapshot taken at any point therefore reflects a consistent
 * screen and sequence number.
 */

import { commandOutputText, normalizeTerminalText } from './ansi.js'
import { ByteTail, tailByBytes } from './ring.js'
import { ScreenMirror } from './screen.js'

/** Parser poll interval for marker-wrapped commands. */
export const POLL_INTERVAL_MS = 25

const TERMINAL_TYPE = 'xterm-256color'

/**
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
    this.createdAt = Date.now()
    this.updatedAt = this.createdAt
    this.#handle = options.handle
    this.#raw = new ByteTail(options.maxOutputBytes)
    this.#onExit = options.onExit
    this.#onChange = options.onChange
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
   * @returns {{ info: SessionInfo, screen: string, text: string, cursor: { x: number, y: number }, seq: number }} snapshot.
   */
  snapshot() {
    return {
      info: this.info,
      screen: this.#screen.serialize(),
      text: this.#screen.visibleText(),
      cursor: this.#screen.cursor(),
      seq: this.seq,
    }
  }

  /**
   * Plain (ANSI-stripped) tail of the raw output, as used by the marker parser.
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
      this.#broadcast('state', { info: this.info })
      this.#onChange?.()
    })
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
   * Subscribe to session events (`output`, `state`, `exit`).
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
      this.#broadcast('output', { id: this.id, seq: this.seq, chunk: data })
    })
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
    if (outcome.error !== undefined) this.error = outcome.error
    this.updatedAt = Date.now()
    this.#exited.resolve({ exitCode: this.exitCode, signal: this.signal })
    this.#broadcast('state', { info: this.info })
    this.#broadcast('exit', { id: this.id, exitCode: this.exitCode, signal: this.signal })
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
