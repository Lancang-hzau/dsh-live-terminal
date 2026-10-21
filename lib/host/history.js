/**
 * Bounded, persisted history of closed command terminals.
 *
 * The registry writes one {@link HistoryEntry} whenever a command session exits
 * or is closed, so the model and the panel can still inspect the outcome after
 * the terminal is gone. History is an LRU list (newest first) capped by
 * `historySize`; on disk it is a single JSON document written with
 * `tmp + rename` so a crash between writes cannot truncate the previous file.
 *
 * Persistence is best-effort: a corrupt file, a permission failure or a missing
 * directory is logged and ignored — the in-memory history keeps working.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** On-disk format version. */
const FORMAT_VERSION = 1

/** Maximum text tail persisted per entry (UTF-8 bytes). */
const MAX_TEXT_BYTES = 64 * 1024

/** Debounce before writing the history file (ms). */
const SAVE_DEBOUNCE_MS = 500

/**
 * Keep at most `maxBytes` UTF-8 bytes from the tail of `text`, never splitting a
 * multi-byte code point.
 *
 * @param {string} text source text.
 * @param {number} maxBytes byte bound.
 * @returns {{ text: string, truncated: boolean }} bounded tail.
 */
function tailByBytes(text, maxBytes) {
  const value = typeof text === 'string' ? text : ''
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return { text: value, truncated: false }
  let start = bytes.length - maxBytes
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1
  return { text: bytes.subarray(start).toString('utf8'), truncated: true }
}

/**
 * @typedef {object} HistoryEntry
 * @property {string} id record id (the original terminal id).
 * @property {string} title display title.
 * @property {string} command command text.
 * @property {string} cwd working directory.
 * @property {'command'} kind always `'command'`.
 * @property {number | null} exitCode process exit code.
 * @property {string | null} signal terminating signal.
 * @property {number} startedAt epoch ms.
 * @property {number} endedAt epoch ms.
 * @property {number} durationMs wall-clock duration.
 * @property {number} cols terminal columns.
 * @property {number} rows terminal rows.
 * @property {'auto-close' | 'closed' | 'failed'} reason close reason.
 * @property {string} text trailing plain text (≤64KB).
 * @property {boolean} truncated whether `text` was truncated.
 * @property {import('./ports.js').PortInfo[]} ports detected ports.
 * @property {import('./session.js').SandboxInfo} sandbox sandbox metadata.
 */

/**
 * @typedef {object} CommandHistoryOptions
 * @property {number} [size] LRU capacity (default 20).
 * @property {string} [file] JSON file path; empty/undefined disables disk writes.
 * @property {{ warn?: (message: string) => void }} [logger] logger for best-effort failures.
 * @property {boolean} [persist] whether disk persistence is enabled (default true).
 */

export class CommandHistory {
  /** @type {HistoryEntry[]} newest first. */
  #entries = []
  /** @type {number} */
  #size
  /** @type {string | undefined} */
  #file
  /** @type {{ warn?: (message: string) => void } | undefined} */
  #logger
  /** @type {boolean} */
  #persist
  /** @type {NodeJS.Timeout | undefined} */
  #saveTimer
  /** @type {boolean} */
  #dirty = false
  /** @type {boolean} */
  #disposed = false

  /**
   * @param {CommandHistoryOptions} [options] history options.
   */
  constructor(options = {}) {
    const requestedSize = Number.isSafeInteger(options.size) && options.size >= 0 ? options.size : 20
    this.#size = requestedSize
    this.#file = typeof options.file === 'string' && options.file.trim().length > 0 ? options.file.trim() : undefined
    this.#logger = options.logger
    this.#persist = options.persist !== false && this.#file !== undefined
    this.load()
  }

  /** Number of retained entries. */
  get size() {
    return this.#entries.length
  }

  /** Whether disk persistence is active. */
  get persistent() {
    return this.#persist
  }

  /** Configured history file path (when persistence is active). */
  get file() {
    return this.#file
  }

  /**
   * Add or replace one entry. The newest entry is first; a repeated id replaces
   * the older record (a session may be recorded on exit and again on close).
   *
   * @param {HistoryEntry} entry entry from the registry.
   * @returns {HistoryEntry} normalized entry.
   */
  add(entry) {
    const normalized = this.#normalize(entry)
    if (normalized === undefined) throw new Error('history entry requires an id')
    const existing = this.#entries.findIndex((item) => item.id === normalized.id)
    if (existing >= 0) this.#entries.splice(existing, 1)
    this.#entries.unshift(normalized)
    if (this.#entries.length > this.#size) this.#entries.length = this.#size
    this.#markDirty()
    return normalized
  }

  /**
   * List entries, newest first.
   *
   * @param {{ limit?: number, terminalId?: string }} [options] filters.
   * @returns {HistoryEntry[]} matching entries.
   */
  list(options = {}) {
    const requestedLimit = Number.isSafeInteger(options.limit) && options.limit >= 0 ? options.limit : 50
    const limit = Math.min(requestedLimit, this.#entries.length)
    const terminalId = typeof options.terminalId === 'string' && options.terminalId.length > 0 ? options.terminalId : undefined
    const source = terminalId === undefined ? this.#entries : this.#entries.filter((entry) => entry.id === terminalId)
    return source.slice(0, limit).map((entry) => structuredClone(entry))
  }

  /**
   * @param {string} id record id.
   * @returns {HistoryEntry | undefined} a deep copy of the record.
   */
  get(id) {
    if (typeof id !== 'string' || id.length === 0) return undefined
    const entry = this.#entries.find((item) => item.id === id)
    return entry === undefined ? undefined : structuredClone(entry)
  }

  /**
   * Load the history file. Missing files are normal; corrupt files are logged
   * and replaced on the next save.
   *
   * @returns {void}
   */
  load() {
    if (!this.#persist || this.#file === undefined) return
    if (!existsSync(this.#file)) return
    try {
      const raw = readFileSync(this.#file, 'utf8')
      if (raw.trim().length === 0) return
      const parsed = JSON.parse(raw)
      const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : undefined
      if (entries === undefined) throw new Error('history file has no entries array')
      const normalized = []
      for (const entry of entries) {
        const item = this.#normalize(entry)
        if (item !== undefined) normalized.push(item)
      }
      this.#entries = normalized.slice(0, this.#size)
    } catch (error) {
      this.#warn(`failed to load terminal history from ${this.#file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Persist now (used by tests and by `dispose`); scheduled saves are cancelled.
   *
   * @returns {void}
   */
  save() {
    if (!this.#persist || this.#file === undefined || this.#disposed) return
    if (this.#saveTimer !== undefined) {
      clearTimeout(this.#saveTimer)
      this.#saveTimer = undefined
    }
    this.#dirty = false
    const tmp = `${this.#file}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 })
      // Terminal output can contain secrets: keep the file owner-only where the
      // platform honours POSIX modes (Windows inherits the profile ACL).
      writeFileSync(tmp, JSON.stringify({ version: FORMAT_VERSION, entries: this.#entries }), { encoding: 'utf8', mode: 0o600 })
      renameOver(tmp, this.#file)
    } catch (error) {
      this.#warn(`failed to save terminal history to ${this.#file}: ${error instanceof Error ? error.message : String(error)}`)
      try {
        rmSync(tmp, { force: true })
      } catch {
        // best effort
      }
    }
  }

  /**
   * Schedule a debounced save (500ms). Idempotent while a save is pending.
   *
   * @returns {void}
   */
  #markDirty() {
    if (!this.#persist || this.#disposed) return
    this.#dirty = true
    if (this.#saveTimer !== undefined) return
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined
      if (this.#dirty) this.save()
    }, SAVE_DEBOUNCE_MS)
    this.#saveTimer.unref?.()
  }

  /**
   * Flush pending changes and stop accepting new writes.
   *
   * @returns {void}
   */
  dispose() {
    if (this.#disposed) return
    if (this.#dirty) this.save()
    this.#disposed = true
    if (this.#saveTimer !== undefined) {
      clearTimeout(this.#saveTimer)
      this.#saveTimer = undefined
    }
  }

  /**
   * Normalize one entry and bound its text tail.
   *
   * @param {unknown} entry candidate entry.
   * @returns {HistoryEntry | undefined} normalized entry.
   */
  #normalize(entry) {
    if (entry === null || typeof entry !== 'object') return undefined
    const source = /** @type {Record<string, any>} */ (entry)
    if (typeof source.id !== 'string' || source.id.length === 0) return undefined
    const text = tailByBytes(typeof source.text === 'string' ? source.text : '', MAX_TEXT_BYTES)
    const startedAt = numberOr(source.startedAt, 0)
    const endedAt = numberOr(source.endedAt, startedAt)
    const durationMs = numberOr(source.durationMs, Math.max(0, endedAt - startedAt))
    const reason = source.reason === 'auto-close' || source.reason === 'failed' ? source.reason : 'closed'
    return {
      id: source.id,
      title: typeof source.title === 'string' ? source.title : source.id,
      command: typeof source.command === 'string' ? source.command : '',
      cwd: typeof source.cwd === 'string' ? source.cwd : '',
      kind: 'command',
      exitCode: typeof source.exitCode === 'number' ? source.exitCode : null,
      signal: typeof source.signal === 'string' ? source.signal : null,
      startedAt,
      endedAt,
      durationMs,
      cols: Number.isSafeInteger(source.cols) ? source.cols : 80,
      rows: Number.isSafeInteger(source.rows) ? source.rows : 24,
      reason,
      text: text.text,
      truncated: text.truncated || source.truncated === true,
      ports: Array.isArray(source.ports) ? source.ports.filter((port) => port !== null && typeof port === 'object').map((port) => ({ ...port })) : [],
      sandbox:
        source.sandbox !== null && typeof source.sandbox === 'object'
          ? { ...source.sandbox }
          : { mode: 'danger-full-access', confined: false, required: false },
      // Ownership is optional for backward compatibility with pre-1.2.1
      // history files; agent-facing history tools only expose entries whose
      // agentId matches the calling agent.
      ...(typeof source.agentId === 'string' && source.agentId.length > 0 ? { agentId: source.agentId } : {}),
      ...(typeof source.sessionId === 'string' && source.sessionId.length > 0 ? { sessionId: source.sessionId } : {}),
      owner: source.owner === 'user' ? 'user' : 'agent',
    }
  }

  /**
   * @param {string} message diagnostic message.
   * @returns {void}
   */
  #warn(message) {
    try {
      this.#logger?.warn?.(`[dsh-live-terminal] ${message}`)
    } catch {
      // logging must never break history bookkeeping
    }
  }
}

/**
 * @param {unknown} value candidate number.
 * @param {number} fallback default.
 * @returns {number} finite number.
 */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Rename a temp file over the target, tolerating Windows' refusal to replace an
 * existing destination.
 *
 * @param {string} tmp temp file path.
 * @param {string} target destination path.
 * @returns {void}
 */
function renameOver(tmp, target) {
  try {
    renameSync(tmp, target)
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code
    if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') throw error
    rmSync(target, { force: true })
    renameSync(tmp, target)
  }
}

/**
 * Join a directory and a history file name (exported for registries/tests).
 *
 * @param {string} directory directory.
 * @param {string} [name] file name.
 * @returns {string} absolute-ish path.
 */
export function historyFilePath(directory, name = 'history.json') {
  return join(directory, name)
}
