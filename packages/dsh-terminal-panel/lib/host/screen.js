/**
 * Headless xterm.js mirror of one PTY screen.
 *
 * `@xterm/headless` and `@xterm/addon-serialize` are CommonJS packages that
 * live in this plugin package's `node_modules`; they are loaded lazily through
 * `createRequire(import.meta.url)` so the host half never has to resolve
 * `@deepseek-ai/*` modules at runtime and pays nothing until a terminal opens.
 */

import { createRequire } from 'node:module'
import { trimLineEnds } from './ansi.js'

const requireFromHere = createRequire(import.meta.url)

/** @type {{ Terminal: any, SerializeAddon: any } | undefined} */
let modules

/**
 * Load the CJS xterm packages once.
 * @returns {{ Terminal: any, SerializeAddon: any }} constructors.
 */
export function loadXtermModules() {
  if (modules !== undefined) return modules
  const headless = requireFromHere('@xterm/headless')
  const serialize = requireFromHere('@xterm/addon-serialize')
  const Terminal = headless?.Terminal ?? headless?.default?.Terminal
  const SerializeAddon = serialize?.SerializeAddon ?? serialize?.default?.SerializeAddon
  if (typeof Terminal !== 'function' || typeof SerializeAddon !== 'function') {
    throw new Error('dsh-terminal-panel: @xterm/headless or @xterm/addon-serialize is not usable')
  }
  modules = { Terminal, SerializeAddon }
  return modules
}

/**
 * One headless terminal mirror: write raw PTY text, read the visible screen,
 * the retained buffer and an ANSI serialization for restoring a browser xterm.
 */
export class ScreenMirror {
  /** @type {any} */
  #terminal
  /** @type {any} */
  #serializer
  /** @type {number} */
  #cols
  /** @type {number} */
  #rows
  /** @type {boolean} */
  #disposed = false

  /**
   * @param {{ cols: number, rows: number, scrollback: number }} options initial dimensions.
   */
  constructor({ cols, rows, scrollback }) {
    const { Terminal, SerializeAddon } = loadXtermModules()
    this.#terminal = new Terminal({ cols, rows, scrollback, allowProposedApi: true })
    this.#serializer = new SerializeAddon()
    this.#terminal.loadAddon(this.#serializer)
    this.#cols = cols
    this.#rows = rows
  }

  /** Current column count. */
  get cols() {
    return this.#cols
  }

  /** Current row count. */
  get rows() {
    return this.#rows
  }

  /** Whether the mirror has been disposed. */
  get disposed() {
    return this.#disposed
  }

  /**
   * Feed raw terminal text into the emulator and wait until it was parsed.
   * @param {string} data raw UTF-8 text from the PTY.
   * @returns {Promise<void>} resolves after the emulator processed the chunk.
   */
  write(data) {
    if (this.#disposed) return Promise.reject(new Error('terminal screen mirror disposed'))
    return new Promise((resolve, reject) => {
      try {
        this.#terminal.write(data, resolve)
      } catch (error) {
        reject(error)
      }
    })
  }

  /**
   * Resize the emulator grid.
   * @param {number} cols new column count.
   * @param {number} rows new row count.
   * @returns {void}
   */
  resize(cols, rows) {
    if (this.#disposed) return
    this.#terminal.resize(cols, rows)
    this.#cols = cols
    this.#rows = rows
  }

  /**
   * Visible screen text: the viewport rows, right-trimmed, with trailing blank
   * lines removed. This is the "screenshot" the model reads.
   * @returns {string} visible screen text.
   */
  visibleText() {
    return this.#bufferText(this.#viewportStart(), this.#rows)
  }

  /**
   * Whole retained buffer text (scrollback + viewport).
   * @returns {string} retained buffer text.
   */
  fullText() {
    return this.#bufferText(0, this.#retainedLines())
  }

  /**
   * Cursor position relative to the viewport.
   * @returns {{ x: number, y: number }} zero-based cursor cell.
   */
  cursor() {
    if (this.#disposed) return { x: 0, y: 0 }
    const buffer = this.#terminal.buffer.active
    return { x: buffer.cursorX, y: buffer.cursorY }
  }

  /**
   * ANSI serialization that restores this screen (including scrollback) when
   * written into another xterm of the same size.
   * @param {{ scrollback?: number }} [options] serialization options.
   * @returns {string} serialized ANSI screen.
   */
  serialize(options) {
    if (this.#disposed) return ''
    try {
      return this.#serializer.serialize(options)
    } catch {
      return ''
    }
  }

  /** Release the emulator. */
  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    try {
      this.#terminal.dispose()
    } catch {
      // already gone
    }
  }

  #viewportStart() {
    const buffer = this.#terminal.buffer.active
    // `baseY` is the first line of the viewport inside the retained buffer;
    // `0` would be scrollback when the terminal has scrolled past its height.
    if (typeof buffer.baseY === 'number' && buffer.baseY > 0) {
      return Math.max(0, Math.min(buffer.baseY, this.#terminal.buffer.active.length - this.#rows))
    }
    return 0
  }

  #retainedLines() {
    const length = this.#terminal.buffer.active.length
    const viewportStart = this.#viewportStart()
    return Math.max(0, Math.min(length, viewportStart + this.#rows) )
  }

  #bufferText(start, count) {
    if (this.#disposed) return ''
    const lines = []
    for (let index = start; index < start + count; index += 1) {
      const line = this.#terminal.buffer.active.getLine(index)
      if (line === undefined) break
      lines.push(line.translateToString(true))
    }
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
    return trimLineEnds(lines.join('\n'))
  }
}
