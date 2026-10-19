/**
 * The xterm.js screen for one PTY session.
 *
 * Lifecycle:
 *  - mount:      create `Terminal` + `FitAddon`, open it, wire input/resize.
 *  - subscribe:  `GET /events?id=` streams `snapshot` 鈫?`output` 鈫?`state`.
 *  - fallback:   if the stream never delivers a snapshot (route missing or
 *                first frame lost), `GET /snapshot?id=` seeds the screen.
 *
 * The component is intentionally dumb about the session list: the panel owns
 * selection, this file only renders and reports.
 */

import { useEffect, useLayoutEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

import { fetchSnapshot, openSessionStream, sendInput, resizeSession } from './api'
import { observeTheme, readTerminalTheme } from './theme'
import type {
  ExitFrame,
  SessionInfo,
  SessionInfoPatch,
  SnapshotFrame,
} from './types'

/** Imperative screen handle used by the panel toolbar (screenshot/focus/fit). */
export interface TerminalController {
  getVisibleText(): string
  getDimensions(): { cols: number; rows: number }
  focus(): void
  fit(): void
}

export interface TerminalViewProps {
  sessionId: string
  reconnectToken: number
  onConnectionChange?: (connected: boolean) => void
  onInfo?: (patch: SessionInfo | SessionInfoPatch) => void
  onExit?: (exit: ExitFrame) => void
  onError?: (message: string | null) => void
  onController?: (controller: TerminalController | null) => void
}

interface PendingChunk {
  seq: number | null
  chunk: string
}

const SNAPSHOT_FALLBACK_MS = 1500
const FORCE_FLUSH_MS = 4000
const PENDING_LIMIT = 4000

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

export function TerminalView(props: TerminalViewProps) {
  const { sessionId, reconnectToken } = props
  const hostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const callbacksRef = useRef(props)
  callbacksRef.current = props

  const suppressResizeRef = useRef(true)
  const postedSizeRef = useRef({ cols: 0, rows: 0 })
  const scheduleFitRef = useRef<() => void>(() => {})
  const readyRef = useRef(false)
  const pendingRef = useRef<PendingChunk[]>([])
  const lastSeqRef = useRef(-1)
  const lastInfoRef = useRef<SessionInfoPatch | null>(null)

  /* ---------------------------------------------------------------- */
  /* Terminal instance                                                 */
  /* ---------------------------------------------------------------- */
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const theme = readTerminalTheme()
    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: theme.fontFamily,
      fontSize: theme.fontSize,
      lineHeight: 1.15,
      minimumContrastRatio: 4.5,
      scrollback: 2000,
      theme: theme.xterm,
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(host)
    terminalRef.current = terminal
    fitRef.current = fitAddon
    suppressResizeRef.current = true
    postedSizeRef.current = { cols: 0, rows: 0 }
    readyRef.current = false
    pendingRef.current = []
    lastSeqRef.current = -1
    lastInfoRef.current = null

    const dataSubscription = terminal.onData((data) => {
      void sendInput(sessionId, data).catch(() => {
        // The connection overlay / status line owns user-visible errors.
      })
    })
    const resizeSubscription = terminal.onResize(({ cols, rows }) => {
      if (suppressResizeRef.current) return
      const posted = postedSizeRef.current
      if (posted.cols === cols && posted.rows === rows) return
      postedSizeRef.current = { cols, rows }
      void resizeSession(sessionId, cols, rows).catch(() => {
        // Resize failures are recoverable; the next fit retries.
      })
    })

    const doFit = (): void => {
      const current = terminalRef.current
      const element = hostRef.current
      if (!current || !element) return
      if (element.clientWidth < 24 || element.clientHeight < 24) return
      try {
        fitAddon.fit()
      } catch (error) {
        console.warn('[dsh-terminal-panel] fit failed', error)
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
      current.options.theme = next.xterm
      let fontChanged = false
      if (current.options.fontFamily !== next.fontFamily) {
        current.options.fontFamily = next.fontFamily
        fontChanged = true
      }
      if (current.options.fontSize !== next.fontSize) {
        current.options.fontSize = next.fontSize
        fontChanged = true
      }
      // Cell metrics changed: re-measure and report the new grid size.
      if (fontChanged) scheduleFit()
    })

    callbacksRef.current.onController?.({
      getVisibleText: () => visibleText(terminal),
      getDimensions: () => ({ cols: terminal.cols, rows: terminal.rows }),
      focus: () => terminal.focus(),
      fit: doFit,
    })

    return () => {
      window.clearTimeout(initialTimer)
      if (frame !== 0) cancelAnimationFrame(frame)
      observer.disconnect()
      stopThemeObserver()
      dataSubscription.dispose()
      resizeSubscription.dispose()
      callbacksRef.current.onController?.(null)
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [sessionId])

  /* ---------------------------------------------------------------- */
  /* Session stream                                                    */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    let disposed = false
    let gotSnapshot = false
    readyRef.current = false
    pendingRef.current = []
    lastSeqRef.current = -1
    lastInfoRef.current = null

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
      })
      callbacksRef.current.onError?.(null)
    }

    let snapshotTimer = 0
    let forceTimer = 0

    const unsubscribe = openSessionStream(sessionId, {
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
    })

    // The SSE route should emit a snapshot immediately; if it does not (or the
    // route is not implemented yet), seed the screen over REST.
    snapshotTimer = window.setTimeout(() => {
      if (disposed || gotSnapshot) return
      void fetchSnapshot(sessionId)
        .then((snapshot) => {
          if (!disposed && !gotSnapshot) applySnapshot(snapshot)
        })
        .catch(() => {
          // Output frames stay buffered until the force-flush below.
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
  }, [sessionId, reconnectToken])

  return <div className="dshtp-screen" ref={hostRef} data-dsh-tp-screen />
}
