/**
 * The xterm.js screen for one PTY session (1.2.1).
 *
 * Lifecycle:
 *  - mount:      create `Terminal` + Fit/Search/WebLinks/Unicode11 addons.
 *  - subscribe:  `GET /events?id=&clientId=` streams `snapshot` -> `output`.
 *  - fallback:   if the stream never delivers a snapshot, `GET /snapshot?id=`
 *                seeds the screen.
 *  - capture:    a `capture-request` frame renders the visible buffer to a PNG
 *                canvas and POSTs the data URL back to the host.
 *
 * The component is intentionally dumb about the session list: the panel owns
 * selection, this file only renders and reports.
 */

import { createPortal } from 'react-dom'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Terminal } from '@xterm/xterm'
import type { IBufferCell, ILink, ILinkProvider, ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'

import {
  ApiError,
  fetchSnapshot,
  openSessionStream,
  postCapture,
  resizeSession,
  sendInput,
} from './api'
import { observeTheme, prefersReducedMotion, readTerminalTheme } from './theme'
import type {
  CaptureRequestFrame,
  ExitFrame,
  SessionInfo,
  SessionInfoPatch,
  SnapshotFrame,
} from './types'

/** Imperative screen handle used by the panel (toolbar, menus, shortcuts). */
export interface TerminalController {
  focus(): void
  fit(): void
  getVisibleText(): string
  getDimensions(): { cols: number; rows: number }
  getSelection(): string
  selectAll(): void
  clear(): void
  findNext(term: string): boolean
  findPrevious(term: string): boolean
  clearSearch(): void
  search(term: string): boolean
  openSearch(): void
  /** Render the visible screen to a PNG data URL (optionally download it). */
  savePng(download?: boolean): string | null
  paste(): Promise<void>
  copySelection(): Promise<boolean>
}

export interface TerminalViewProps {
  sessionId: string
  clientId: string
  t: (key: string, params?: Record<string, unknown>) => string
  /** False while another browser page owns the input lease. */
  writable: boolean
  reconnectToken: number
  onConnectionChange?: (connected: boolean) => void
  /** True once the first frame has been painted (skeleton hides). */
  onReady?: (ready: boolean) => void
  onInfo?: (patch: SessionInfo | SessionInfoPatch) => void
  /** Input-lease owner reported by snapshots (multi-page write protection). */
  onWriterChange?: (writerClientId: string | undefined) => void
  onExit?: (exit: ExitFrame) => void
  /** A real, user-actionable error (snapshot/stream/capture); null clears it. */
  onError?: (message: string | null) => void
  /** Reports a failed input POST; the Panel surfaces it as a toast. */
  onInputError?: (message: string) => void
  /** User-selected terminal font size (px); undefined follows the DSH theme. */
  fontSize?: number
  /** The user typed while another page owns the input lease. */
  onReadOnlyInput?: () => void
  /** User touched the screen (typing/pointer/wheel): pin the selection. */
  onUserActivity?: () => void
  onSelectionChange?: (hasSelection: boolean) => void
  /** Local feedback (copy/paste/search); rendered by the Panel as a toast. */
  onToast?: (text: string, kind?: 'info' | 'error') => void
  onController?: (controller: TerminalController | null) => void
}

interface PendingChunk {
  seq: number | null
  chunk: string
}

interface ContextMenuState {
  x: number
  y: number
}

const SNAPSHOT_FALLBACK_MS = 1500
const FORCE_FLUSH_MS = 4000
const PENDING_LIMIT = 4000
/** The host rejects `/input` bodies above 64KB; stay well below it. */
const INPUT_CHUNK_BYTES = 32 * 1024
/** Hard cap for the pending input queue; beyond this we drop and report. */
const INPUT_QUEUE_LIMIT = 1024 * 1024
/** Coalesce fit-driven resize POSTs while the sidebar is being dragged. */
const RESIZE_DEBOUNCE_MS = 120
/** Client-side scrollback (the host mirror is configured separately). */
const SCROLLBACK_ROWS = 2000
/** Search decoration colors (xterm requires #RRGGBB here). */
const SEARCH_DECORATIONS = {
  matchBackground: '#f5c542',
  matchOverviewRuler: '#f5c542',
  activeMatchBackground: '#ff9f1a',
  activeMatchBorder: '#ff9f1a',
  activeMatchColorOverviewRuler: '#ff9f1a',
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

const ANSI_16 = [
  '#000000',
  '#cd3131',
  '#0dbc79',
  '#e5e510',
  '#2472c8',
  '#bc3fbc',
  '#11a8cd',
  '#e5e5e5',
  '#666666',
  '#f14c4c',
  '#23d18b',
  '#f5f543',
  '#3b8eea',
  '#d670d6',
  '#29b8db',
  '#e5e5e5',
]

/** Split `text` into a UTF-8-safe prefix of at most `maxBytes` bytes. */
function splitByUtf8Bytes(text: string, maxBytes: number): [string, string] {
  if (text === '') return ['', '']
  const bytes = textEncoder.encode(text)
  if (bytes.byteLength <= maxBytes) return [text, '']
  let end = maxBytes
  // Do not cut a multi-byte code point: a continuation byte (10xxxxxx) means
  // the prefix would end mid-character.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1
  return [textDecoder.decode(bytes.subarray(0, end)), textDecoder.decode(bytes.subarray(end))]
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Shallow compare of two xterm themes so unchanged tokens cause no repaint. */
function sameTheme(left: ITheme | undefined, right: ITheme): boolean {
  if (left === undefined) return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])
  for (const key of keys) {
    if (leftRecord[key] !== rightRecord[key]) return false
  }
  return true
}

/** Text of the visible viewport, matching the host's `visibleText()` helper. */
function visibleText(terminal: Terminal): string {
  const buffer = terminal.buffer.active
  const lines: string[] = []
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row)
    lines.push(line ? line.translateToString(true) : '')
  }
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop()
  return lines.join('\n')
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall back to the legacy selection-based copy below.
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied =
      typeof document.execCommand === 'function' ? document.execCommand('copy') : false
    area.remove()
    return copied
  } catch {
    return false
  }
}

/** Read text from the clipboard (Ctrl+Shift+V / context menu). */
async function readClipboard(): Promise<string | null> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
      return await navigator.clipboard.readText()
    }
  } catch {
    // The browser may reject clipboard reads outside a user gesture.
  }
  return null
}

function toHexColor(value: number): string {
  return `#${(value & 0xffffff).toString(16).padStart(6, '0')}`
}

/** Resolve an ANSI palette index (0-255) to a CSS color. */
function paletteColor(index: number): string {
  const safe = Number.isFinite(index) ? Math.max(0, Math.min(255, Math.floor(index))) : 0
  const known = ANSI_16[safe]
  if (known !== undefined) return known
  if (safe >= 232) {
    const level = (safe - 232) * 10 + 8
    return `rgb(${level}, ${level}, ${level})`
  }
  const cube = safe - 16
  const steps = [0, 95, 135, 175, 215, 255]
  const red = steps[Math.floor(cube / 36) % 6] ?? 0
  const green = steps[Math.floor(cube / 6) % 6] ?? 0
  const blue = steps[cube % 6] ?? 0
  return `rgb(${red}, ${green}, ${blue})`
}

function cellColor(cell: IBufferCell, kind: 'fg' | 'bg', theme: ITheme): string {
  const isDefault = kind === 'fg' ? cell.isFgDefault() : cell.isBgDefault()
  if (isDefault) {
    return kind === 'fg'
      ? (theme.foreground ?? '#e6e6e6')
      : (theme.background ?? '#17191d')
  }
  const isRgb = kind === 'fg' ? cell.isFgRGB() : cell.isBgRGB()
  const color = kind === 'fg' ? cell.getFgColor() : cell.getBgColor()
  if (isRgb) return toHexColor(color)
  return paletteColor(color)
}

interface CellMetrics {
  width: number
  height: number
}

/** Measure the xterm cell grid; falls back to canvas font measurement. */
function measureCell(terminal: Terminal): CellMetrics {
  const internal = terminal as unknown as {
    _core?: {
      _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } }
    }
  }
  const cell = internal._core?._renderService?.dimensions?.css?.cell
  if (
    cell !== undefined &&
    typeof cell.width === 'number' &&
    typeof cell.height === 'number' &&
    cell.width > 0 &&
    cell.height > 0
  ) {
    return { width: cell.width, height: cell.height }
  }
  const fontSize = terminal.options.fontSize ?? 13
  const lineHeight = terminal.options.lineHeight ?? 1.15
  const family = terminal.options.fontFamily ?? 'monospace'
  let width = fontSize * 0.62
  try {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.font = `${fontSize}px ${family}`
      width = ctx.measureText('M').width
    }
  } catch {
    // keep the rough fallback
  }
  return { width: Math.max(4, width), height: Math.max(8, Math.ceil(fontSize * lineHeight)) }
}

interface RenderedCapture {
  dataUrl: string
  width: number
  height: number
}

/**
 * Render the current xterm viewport to a PNG data URL.
 *
 * Canvas drawing avoids depending on the xterm DOM renderer internals: the
 * visible buffer is re-painted cell by cell with the effective theme colors,
 * so the result matches the screen even for headless/WebGL renderers.
 */
function renderPngCapture(terminal: Terminal): RenderedCapture | null {
  if (typeof document === 'undefined') return null
  const rows = terminal.rows
  const cols = terminal.cols
  if (rows <= 0 || cols <= 0) return null
  const theme = readTerminalTheme().xterm
  const metrics = measureCell(terminal)
  const ratio = Math.min(2, Math.max(1, globalThis.devicePixelRatio ?? 1))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(metrics.width * cols * ratio))
  canvas.height = Math.max(1, Math.ceil(metrics.height * rows * ratio))
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.scale(ratio, ratio)
  ctx.fillStyle = theme.background ?? '#17191d'
  ctx.fillRect(0, 0, metrics.width * cols, metrics.height * rows)
  const buffer = terminal.buffer.active
  const fontFamily = terminal.options.fontFamily ?? 'monospace'
  const fontSize = terminal.options.fontSize ?? 13
  const baseline = (metrics.height + fontSize * 0.72) / 2
  const startY = buffer.viewportY
  for (let row = 0; row < rows; row += 1) {
    const line = buffer.getLine(startY + row)
    if (!line) continue
    let column = 0
    while (column < cols) {
      const cell = line.getCell(column)
      if (!cell) break
      const width = cell.getWidth()
      if (width === 0) {
        column += 1
        continue
      }
      const cellWidth = metrics.width * width
      const x = metrics.width * column
      const y = metrics.height * row
      const background = cellColor(cell, 'bg', theme)
      if (background !== (theme.background ?? '#17191d')) {
        ctx.fillStyle = background
        ctx.fillRect(x, y, cellWidth, metrics.height)
      }
      const chars = cell.getChars()
      if (chars !== '' && chars.trim() !== '') {
        const bold = cell.isBold() !== 0
        const italic = cell.isItalic() !== 0
        ctx.fillStyle = cellColor(cell, 'fg', theme)
        ctx.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${fontSize}px ${fontFamily}`
        ctx.textBaseline = 'alphabetic'
        ctx.fillText(chars, x, y + baseline)
        if (cell.isUnderline() !== 0) {
          ctx.fillRect(x, y + metrics.height - 1.2, cellWidth, 1.2)
        }
      }
      column += Math.max(1, width)
    }
  }
  // Cursor: a hollow block so the screenshot shows focus without hiding text.
  const cursorX = buffer.cursorX
  const cursorY = buffer.cursorY
  if (cursorX >= 0 && cursorX < cols && cursorY >= 0 && cursorY < rows) {
    ctx.strokeStyle = theme.cursor ?? '#ffffff'
    ctx.lineWidth = 1
    ctx.strokeRect(
      metrics.width * cursorX + 0.5,
      metrics.height * cursorY + 0.5,
      Math.max(2, metrics.width - 1),
      Math.max(2, metrics.height - 1),
    )
  }
  try {
    return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height }
  } catch {
    return null
  }
}

/** Download a data URL as a file (user-facing "save PNG"). */
function downloadDataUrl(dataUrl: string, filename: string): void {
  try {
    const link = document.createElement('a')
    link.href = dataUrl
    link.download = filename
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
  } catch {
    // Download blocked: the caller can still surface a toast.
  }
}

export function TerminalView(props: TerminalViewProps) {
  const { sessionId, reconnectToken } = props
  const hostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const callbacksRef = useRef(props)
  callbacksRef.current = props
  /** Font size override chosen in the panel (undefined = follow DSH theme). */
  const fontSizeOverrideRef = useRef<number | undefined>(props.fontSize)
  fontSizeOverrideRef.current = props.fontSize

  const suppressResizeRef = useRef(true)
  const postedSizeRef = useRef({ cols: 0, rows: 0 })
  const scheduleFitRef = useRef<() => void>(() => {})
  const readyRef = useRef(false)
  const pendingRef = useRef<PendingChunk[]>([])
  const lastSeqRef = useRef(-1)
  const lastInfoRef = useRef<SessionInfoPatch | null>(null)
  const inputQueueRef = useRef({ pending: '', busy: false })
  const captureRef = useRef<(() => RenderedCapture | null) | null>(null)
  const captureRequestsRef = useRef<Set<string>>(new Set())
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId

  const [connecting, setConnecting] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchCount, setSearchCount] = useState({ current: 0, total: 0 })
  const [hasSelection, setHasSelection] = useState(false)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  const openSearch = useCallback((): void => {
    setSearchOpen(true)
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    })
  }, [])

  const closeSearch = useCallback((): void => {
    setSearchOpen(false)
    searchRef.current?.clearDecorations()
    setSearchCount({ current: 0, total: 0 })
    terminalRef.current?.focus()
  }, [])

  const doFind = useCallback((direction: 'next' | 'previous', query: string): boolean => {
    const search = searchRef.current
    const terminal = terminalRef.current
    if (!search || !terminal || query === '') return false
    const options = {
      incremental: false,
      decorations: SEARCH_DECORATIONS,
    }
    const found =
      direction === 'next'
        ? search.findNext(query, options)
        : search.findPrevious(query, options)
    if (!found) setSearchCount({ current: 0, total: 0 })
    return found
  }, [])

  const copySelection = useCallback(async (): Promise<boolean> => {
    const terminal = terminalRef.current
    const selection = terminal?.getSelection() ?? ''
    if (selection === '') return false
    const copied = await writeClipboard(selection)
    if (copied) callbacksRef.current.onToast?.(callbacksRef.current.t('copied'), 'info')
    return copied
  }, [])

  const paste = useCallback(async (): Promise<void> => {
    const text = await readClipboard()
    const terminal = terminalRef.current
    if (text === null || text === '' || !terminal) {
      callbacksRef.current.onToast?.(callbacksRef.current.t('inputFailed'), 'error')
      return
    }
    terminal.paste(text)
  }, [])

  const savePng = useCallback((download = false): string | null => {
    const terminal = terminalRef.current
    if (!terminal) return null
    const rendered = renderPngCapture(terminal)
    if (rendered === null) return null
    if (download) {
      downloadDataUrl(
        rendered.dataUrl,
        `terminal-${sessionIdRef.current.slice(0, 8)}-${Date.now()}.png`,
      )
    }
    return rendered.dataUrl
  }, [])

  /* ---------------------------------------------------------------- */
  /* Terminal instance                                                 */
  /* ---------------------------------------------------------------- */
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const theme = readTerminalTheme()
    const reducedMotion = prefersReducedMotion()
    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: !reducedMotion,
      fontFamily: theme.fontFamily,
      fontSize: fontSizeOverrideRef.current ?? theme.fontSize,
      lineHeight: 1.15,
      minimumContrastRatio: 4.5,
      scrollback: SCROLLBACK_ROWS,
      theme: theme.xterm,
    })
    const fitAddon = new FitAddon()
    const searchAddon = new SearchAddon()
    const unicodeAddon = new Unicode11Addon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(searchAddon)
    terminal.loadAddon(unicodeAddon)
    try {
      terminal.unicode.activeVersion = '11'
    } catch {
      // Older xterm builds may not expose the unicode registry.
    }
    terminal.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault?.()
        window.open(uri, '_blank', 'noopener,noreferrer')
      }),
    )
    terminal.open(host)
    terminalRef.current = terminal
    fitRef.current = fitAddon
    searchRef.current = searchAddon
    suppressResizeRef.current = true
    postedSizeRef.current = { cols: 0, rows: 0 }
    readyRef.current = false
    pendingRef.current = []
    lastSeqRef.current = -1
    lastInfoRef.current = null
    inputQueueRef.current = { pending: '', busy: false }
    captureRequestsRef.current = new Set()
    try {
      terminal.textarea?.setAttribute('aria-label', callbacksRef.current.t('title'))
    } catch {
      // textarea is optional (screen-reader mode may replace it)
    }

    // Search result counts feed the search bar.
    const searchSubscription = searchAddon.onDidChangeResults((event) => {
      setSearchCount({
        current: event.resultIndex >= 0 ? event.resultIndex + 1 : 0,
        total: event.resultCount,
      })
    })

    let disposed = false
    const inputQueue = inputQueueRef.current

    // Serialise user input: xterm emits one `onData` per keystroke and fetch
    // requests carry no ordering guarantee, so sends are queued and flushed one
    // at a time (<=32KB per POST).
    const flushInput = (): void => {
      if (disposed || inputQueue.busy || inputQueue.pending === '') return
      const [chunk, rest] = splitByUtf8Bytes(inputQueue.pending, INPUT_CHUNK_BYTES)
      if (chunk === '') return
      inputQueue.pending = rest
      inputQueue.busy = true
      void sendInput(sessionId, chunk, callbacksRef.current.clientId)
        .catch((error: unknown) => {
          if (error instanceof ApiError && error.code === 'READ_ONLY') {
            callbacksRef.current.onReadOnlyInput?.()
            return
          }
          callbacksRef.current.onInputError?.(describeError(error))
        })
        .finally(() => {
          inputQueue.busy = false
          flushInput()
        })
    }

    const dataSubscription = terminal.onData((data) => {
      callbacksRef.current.onUserActivity?.()
      if (data === '') return
      if (!callbacksRef.current.writable) {
        callbacksRef.current.onReadOnlyInput?.()
        return
      }
      inputQueue.pending += data
      if (inputQueue.pending.length > INPUT_QUEUE_LIMIT) {
        inputQueue.pending = ''
        callbacksRef.current.onInputError?.('input queue overflow')
        return
      }
      queueMicrotask(flushInput)
    })

    const selectionSubscription = terminal.onSelectionChange(() => {
      const next = terminal.getSelection() !== ''
      setHasSelection(next)
      callbacksRef.current.onSelectionChange?.(next)
    })

    // Keyboard: Ctrl/Cmd+F searches; Ctrl/Cmd+Shift+C/V copy/paste; everything
    // else is forwarded to the PTY (including Ctrl+C = SIGINT).
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      const primary = event.ctrlKey || event.metaKey
      if (!primary) return true
      const key = event.key.toLowerCase()
      if (key === 'f') {
        event.preventDefault()
        openSearch()
        return false
      }
      if (key === 'c' && event.shiftKey) {
        event.preventDefault()
        void copySelection()
        return false
      }
      if (key === 'v' && event.shiftKey) {
        event.preventDefault()
        void paste()
        return false
      }
      return true
    })

    // Ports printed by dev servers: clickable even without a scheme.
    const portProvider: ILinkProvider = {
      provideLinks: (y, callback) => {
        const buffer = terminal.buffer.active
        const line = buffer.getLine(y - 1)
        if (!line) {
          callback(undefined)
          return
        }
        const text = line.translateToString(true)
        const pattern = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d{2,5})(?:\/[^\s"'<>]*)?/gu
        const links: ILink[] = []
        let match: RegExpExecArray | null
        while ((match = pattern.exec(text)) !== null) {
          const raw = match[0]
          if (raw === '') continue
          // WebLinksAddon already links full http(s) URLs; skip their host part.
          if (/(?:https?:\/\/)$/u.test(text.slice(0, match.index))) continue
          const start = match.index + 1
          const end = start + raw.length
          const url = `http://${raw}`
          links.push({
            range: { start: { x: start, y }, end: { x: end, y } },
            text: raw,
            activate: (event) => {
              event.preventDefault?.()
              window.open(url, '_blank', 'noopener,noreferrer')
            },
          })
        }
        callback(links.length > 0 ? links : undefined)
      },
    }
    const linkSubscription = terminal.registerLinkProvider(portProvider)

    let resizeTimer = 0
    const resizeSubscription = terminal.onResize(({ cols, rows }) => {
      if (suppressResizeRef.current) return
      const posted = postedSizeRef.current
      if (posted.cols === cols && posted.rows === rows) return
      postedSizeRef.current = { cols, rows }
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        void resizeSession(sessionId, cols, rows).catch(() => {
          // Reset the marker so the next fit retries the same dimensions.
          postedSizeRef.current = { cols: 0, rows: 0 }
        })
      }, RESIZE_DEBOUNCE_MS)
    })

    const doFit = (): void => {
      const current = terminalRef.current
      const element = hostRef.current
      if (!current || !element) return
      if (element.clientWidth < 24 || element.clientHeight < 24) return
      try {
        fitAddon.fit()
      } catch (error) {
        console.warn('[dsh-live-terminal] fit failed', error)
      }
    }
    let frame = 0
    const scheduleFit = (): void => {
      if (frame !== 0) return
      frame = requestAnimationFrame(() => {
        frame = 0
        doFit()
      })
    }
    scheduleFitRef.current = scheduleFit

    const observer = new ResizeObserver(scheduleFit)
    observer.observe(host)
    const initialTimer = window.setTimeout(scheduleFit, 30)

    const stopThemeObserver = observeTheme(() => {
      const current = terminalRef.current
      if (!current) return
      const next = readTerminalTheme()
      // Avoid an unconditional theme assignment: xterm treats a new theme
      // object as a full repaint even when every token is unchanged.
      if (!sameTheme(current.options.theme, next.xterm)) {
        current.options.theme = next.xterm
      }
      let fontChanged = false
      if (current.options.fontFamily !== next.fontFamily) {
        current.options.fontFamily = next.fontFamily
        fontChanged = true
      }
      if (current.options.fontSize !== (fontSizeOverrideRef.current ?? next.fontSize)) {
        current.options.fontSize = fontSizeOverrideRef.current ?? next.fontSize
        fontChanged = true
      }
      current.options.cursorBlink = !prefersReducedMotion()
      if (fontChanged) scheduleFit()
    })

    captureRef.current = () => renderPngCapture(terminal)

    const controller: TerminalController = {
      focus: () => terminal.focus(),
      fit: doFit,
      getVisibleText: () => visibleText(terminal),
      getDimensions: () => ({ cols: terminal.cols, rows: terminal.rows }),
      getSelection: () => terminal.getSelection(),
      selectAll: () => terminal.selectAll(),
      clear: () => terminal.clear(),
      findNext: (term) => doFind('next', term),
      findPrevious: (term) => doFind('previous', term),
      clearSearch: () => {
        searchAddon.clearDecorations()
        setSearchCount({ current: 0, total: 0 })
      },
      search: (term) => doFind('next', term),
      openSearch,
      savePng,
      paste,
      copySelection,
    }
    callbacksRef.current.onController?.(controller)

    return () => {
      disposed = true
      inputQueue.pending = ''
      window.clearTimeout(initialTimer)
      window.clearTimeout(resizeTimer)
      if (frame !== 0) cancelAnimationFrame(frame)
      observer.disconnect()
      stopThemeObserver()
      searchSubscription.dispose()
      dataSubscription.dispose()
      selectionSubscription.dispose()
      resizeSubscription.dispose()
      linkSubscription.dispose()
      captureRef.current = null
      callbacksRef.current.onController?.(null)
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
      searchRef.current = null
    }
    // The terminal instance is re-created only when the session identity changes.
  }, [sessionId])

  // Font-size preference changes apply live; the fit addon then recomputes the
  // PTY grid and POSTs the new dimensions.
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    const target = props.fontSize ?? readTerminalTheme().fontSize
    if (terminal.options.fontSize === target) return
    terminal.options.fontSize = target
    scheduleFitRef.current()
  }, [props.fontSize])

  /* ---------------------------------------------------------------- */
  /* Session stream                                                    */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    let disposed = false
    let gotSnapshot = false
    // A reconnect keeps the last screen visible: only the very first frame
    // shows the opaque connecting skeleton.
    const hadScreen = readyRef.current
    readyRef.current = false
    pendingRef.current = []
    lastSeqRef.current = -1
    lastInfoRef.current = null
    callbacksRef.current.onReady?.(false)
    setConnecting(!hadScreen)

    const writePending = (): void => {
      const buffered = pendingRef.current
      pendingRef.current = []
      for (const item of buffered) {
        if (item.seq !== null && item.seq <= lastSeqRef.current) continue
        terminal.write(item.chunk)
      }
    }

    const markReady = (): void => {
      if (disposed || readyRef.current) return
      readyRef.current = true
      writePending()
      suppressResizeRef.current = false
      scheduleFitRef.current()
      setConnecting(false)
      callbacksRef.current.onReady?.(true)
    }

    const applySnapshot = (snapshot: SnapshotFrame): void => {
      if (disposed) return
      gotSnapshot = true
      const info = snapshot.info
      if (info) {
        lastInfoRef.current = info
        callbacksRef.current.onInfo?.(info)
      }
      if (typeof snapshot.seq === 'number') lastSeqRef.current = snapshot.seq
      if (snapshot.writerClientId !== undefined) {
        callbacksRef.current.onWriterChange?.(snapshot.writerClientId)
      }
      readyRef.current = false
      pendingRef.current = []
      terminal.reset()
      if (info && info.cols >= 2 && info.rows >= 1) terminal.resize(info.cols, info.rows)
      terminal.write(snapshot.screen || snapshot.text || '', () => {
        if (disposed) return
        readyRef.current = true
        writePending()
        suppressResizeRef.current = false
        scheduleFitRef.current()
        setConnecting(false)
        callbacksRef.current.onReady?.(true)
      })
      callbacksRef.current.onError?.(null)
    }

    const handleCaptureRequest = (frame: CaptureRequestFrame): void => {
      if (frame.terminalId !== sessionId) return
      if (captureRequestsRef.current.has(frame.requestId)) return
      captureRequestsRef.current.add(frame.requestId)
      window.setTimeout(() => captureRequestsRef.current.delete(frame.requestId), 30_000)
      const render = captureRef.current
      const rendered = render ? render() : null
      if (rendered === null) {
        callbacksRef.current.onError?.(callbacksRef.current.t('copyFailed'))
        return
      }
      void postCapture(sessionId, frame.requestId, rendered.dataUrl, {
        width: rendered.width,
        height: rendered.height,
      }).catch((error: unknown) => {
        callbacksRef.current.onError?.(
          `${callbacksRef.current.t('copyFailed')}: ${describeError(error)}`,
        )
      })
    }

    let snapshotTimer = 0
    let forceTimer = 0

    const unsubscribe = openSessionStream(sessionId, {
      clientId: props.clientId,
      handlers: {
        onOpen: () => {
          callbacksRef.current.onConnectionChange?.(true)
        },
        onError: () => {
          callbacksRef.current.onConnectionChange?.(false)
        },
        onSnapshot: (snapshot) => {
          window.clearTimeout(snapshotTimer)
          applySnapshot(snapshot)
        },
        onOutput: (output) => {
          if (output.seq !== null) {
            if (output.seq <= lastSeqRef.current) return
            lastSeqRef.current = output.seq
          }
          if (!readyRef.current) {
            pendingRef.current.push(output)
            if (pendingRef.current.length > PENDING_LIMIT) pendingRef.current.shift()
            return
          }
          terminal.write(output.chunk)
        },
        onState: (patch) => {
          const next = { ...(lastInfoRef.current ?? { id: sessionId }), ...patch }
          lastInfoRef.current = next as SessionInfoPatch
          callbacksRef.current.onInfo?.(patch)
        },
        onExit: (exit) => {
          const patch: SessionInfoPatch = {
            id: sessionId,
            state: exit.state ?? 'exited',
            exitCode: exit.exitCode,
          }
          lastInfoRef.current = { ...(lastInfoRef.current ?? { id: sessionId }), ...patch }
          callbacksRef.current.onInfo?.(patch)
          callbacksRef.current.onExit?.(exit)
        },
        onCaptureRequest: handleCaptureRequest,
      },
    })

    // The SSE route should emit a snapshot immediately; if it does not (or the
    // route is not implemented yet), seed the screen over REST.
    snapshotTimer = window.setTimeout(() => {
      if (disposed || gotSnapshot) return
      void fetchSnapshot(sessionId)
        .then((snapshot) => {
          if (!disposed && !gotSnapshot) applySnapshot(snapshot)
        })
        .catch((error: unknown) => {
          callbacksRef.current.onError?.(
            `${callbacksRef.current.t('listError')}: ${describeError(error)}`,
          )
        })
    }, SNAPSHOT_FALLBACK_MS)

    // Never keep the screen blank forever: after the grace period render the
    // buffered deltas even without a snapshot (partial reflow is better than an
    // empty terminal while the host half is being wired up).
    forceTimer = window.setTimeout(() => {
      if (disposed) return
      markReady()
    }, FORCE_FLUSH_MS)

    return () => {
      disposed = true
      window.clearTimeout(snapshotTimer)
      window.clearTimeout(forceTimer)
      unsubscribe()
    }
    // `props.clientId`/`props.t` identity changes must not resubscribe.
  }, [sessionId, reconnectToken, props.clientId])

  /* ---------------------------------------------------------------- */
  /* Local interactions                                                */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    if (contextMenu === null) return
    const close = (): void => setContextMenu(null)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    // Bubble phase: the portal's own pointerdown handler stops the event before
    // it reaches window, so clicking a menu item does not close the menu first.
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [contextMenu])

  const submitSearch = (direction: 'next' | 'previous'): void => {
    const query = searchQuery.trim()
    if (query === '') return
    doFind(direction, query)
  }

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      submitSearch(event.shiftKey ? 'previous' : 'next')
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeSearch()
    }
  }

  const contextMenuElement =
    contextMenu !== null
      ? createPortal(
          <div
            className="dshtp-context-menu"
            role="menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              className="dshtp-context-menu-item"
              disabled={!hasSelection}
              onClick={() => {
                setContextMenu(null)
                void copySelection()
              }}
            >
              {props.t('copySelection')}
            </button>
            <button
              type="button"
              role="menuitem"
              className="dshtp-context-menu-item"
              onClick={() => {
                setContextMenu(null)
                void paste()
              }}
            >
              {props.t('paste')}
            </button>
            <button
              type="button"
              role="menuitem"
              className="dshtp-context-menu-item"
              onClick={() => {
                setContextMenu(null)
                terminalRef.current?.selectAll()
              }}
            >
              {props.t('selectAll')}
            </button>
            <button
              type="button"
              role="menuitem"
              className="dshtp-context-menu-item"
              onClick={() => {
                setContextMenu(null)
                openSearch()
              }}
            >
              {props.t('search')}
            </button>
            <button
              type="button"
              role="menuitem"
              className="dshtp-context-menu-item"
              onClick={() => {
                setContextMenu(null)
                terminalRef.current?.clear()
              }}
            >
              {props.t('clearScreen')}
            </button>
          </div>,
          document.body,
        )
      : null

  return (
    <div
      className="dshtp-screen"
      ref={hostRef}
      data-dsh-tp-screen
      onPointerDown={() => callbacksRef.current.onUserActivity?.()}
      onWheel={() => callbacksRef.current.onUserActivity?.()}
      onContextMenu={(event) => {
        event.preventDefault()
        callbacksRef.current.onUserActivity?.()
        setContextMenu({ x: event.clientX, y: event.clientY })
      }}
    >
      {connecting ? (
        <div className="dshtp-connecting" role="status" aria-live="polite">
          <span className="dshtp-connecting-spinner" aria-hidden="true" />
          <span className="dshtp-connecting-text">{props.t('connectingShell')}</span>
        </div>
      ) : null}

      {searchOpen ? (
        <div className="dshtp-search-bar" role="search">
          <input
            ref={searchInputRef}
            className="dshtp-search-input"
            type="text"
            value={searchQuery}
            placeholder={props.t('searchPlaceholder')}
            aria-label={props.t('search')}
            onChange={(event) => {
              const value = event.target.value
              setSearchQuery(value)
              if (value.trim() === '') {
                searchRef.current?.clearDecorations()
                setSearchCount({ current: 0, total: 0 })
              } else {
                doFind('next', value.trim())
              }
            }}
            onKeyDown={handleSearchKeyDown}
          />
          <span
            className="dshtp-search-count"
            data-empty={searchCount.total === 0 ? 'true' : 'false'}
            aria-live="polite"
          >
            {searchQuery.trim() === ''
              ? ''
              : searchCount.total === 0
                ? props.t('searchNoResult')
                : props.t('searchResult', {
                    current: String(searchCount.current),
                    total: String(searchCount.total),
                  })}
          </span>
          <button
            type="button"
            className="dshtp-search-action"
            aria-label={`${props.t('search')} next`}
            title={props.t('search')}
            onClick={() => submitSearch('next')}
          >
            <span aria-hidden="true">{'\u2193'}</span>
          </button>
          <button
            type="button"
            className="dshtp-search-action"
            aria-label={`${props.t('search')} previous`}
            title={props.t('search')}
            onClick={() => submitSearch('previous')}
          >
            <span aria-hidden="true">{'\u2191'}</span>
          </button>
          <button
            type="button"
            className="dshtp-search-action dshtp-search-close"
            aria-label={props.t('close')}
            title={props.t('close')}
            onClick={closeSearch}
          >
            <span aria-hidden="true">{'\u00d7'}</span>
          </button>
        </div>
      ) : null}

      {contextMenuElement}
    </div>
  )
}
