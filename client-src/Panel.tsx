/**
 * Full terminal panel body (1.2.1 compact chrome).
 *
 * The panel is mounted once per right-sidebar tab occurrence. It owns:
 *  - the session list (REST seed + global SSE updates, polling fallback),
 *  - the selected session / history view,
 *  - compact chrome (new / session strip / more menu / follow toggle),
 *  - auto-close countdown + pause / keep, rename, config & shortcut help,
 *  - keyboard commands forwarded by index.tsx via a window CustomEvent.
 *
 * The host half may be older than the client; every request failure becomes a
 * retryable banner instead of a crash, and unparsable fields fall back to safe
 * defaults (types.ts parsers).
 */

import { createPortal } from 'react-dom'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'

import {
  ApiError,
  closeSession,
  createSession,
  exportUrl,
  fetchConfig,
  fetchHistory,
  getClientId,
  keepSession,
  listSessions,
  openSessionsStream,
  renameSession,
  setAutoClosePaused,
  takeControl,
} from './api'
import {
  IconClipboard,
  IconClose,
  IconExport,
  IconHistory,
  IconKeyboard,
  IconMore,
  IconPause,
  IconPin,
  IconPlay,
  IconPlus,
  IconReconnect,
  IconRename,
  IconSandbox,
  IconSearch,
  IconSettings,
  IconTerminal,
  IconWarning,
} from './icons'
import { TerminalView, type TerminalController } from './TerminalView'
import {
  isFullSessionInfo,
  stripUndefined,
  type ConfigInfo,
  type HistoryEntry,
  type Notice,
  type SessionInfo,
  type SessionInfoPatch,
} from './types'

export interface PanelProps {
  /** Locale-bound translator provided by the slot runtime. */
  t?: (key: string, params?: Record<string, unknown>) => string
  /** Conversation session id injected by the slot runtime (grouping/cwd). */
  sessionId?: string
  /** Slot hook supplied by the sidebar; kept for parity with official bodies. */
  useTabInfo?: () => unknown
}

type ListPhase = 'loading' | 'ready' | 'error'
type ConnectionState = 'connecting' | 'connected' | 'disconnected'
type DialogKind = 'config' | 'shortcuts' | 'history' | 'rename' | null
type ViewState = { mode: 'terminal' } | { mode: 'history'; entry: HistoryEntry }

interface ListError {
  message: string
  missingService: boolean
}

interface ToastAction {
  label: string
  onClick: () => void
}

interface ToastState {
  text: string
  kind: 'info' | 'error'
  duration: number
  actions: ToastAction[]
}

interface TabBadge {
  kind: 'running' | 'shell' | 'sandbox' | 'countdown' | 'unread' | 'error'
  text: string
  title?: string
}

const DEFAULT_SIZE = { cols: 100, rows: 30 }
const SESSION_POLL_MS = 5000
const TOAST_MS = 2200
const NOTICE_TOAST_MS = 6000
const COUNTDOWN_TICK_MS = 500
const FOLLOW_STORAGE_KEY = 'dsh-live-terminal.follow'
const GROUP_STORAGE_KEY = 'dsh-live-terminal.only-this-session'
const SANDBOX_DISMISS_STORAGE_KEY = 'dsh-live-terminal.sandbox-dismissed'

/** The most recently mounted panel wins keyboard commands (multi-panel guard). */
const activePanel = { root: null as HTMLElement | null }

/** Cross-module registry so index.tsx can tell whether a panel is mounted. */
const panelMountRegistry: Set<object> = (() => {
  const record = globalThis as Record<string, unknown>
  const existing = record.__DSH_TP_PANELS__
  if (existing instanceof Set) return existing as Set<object>
  const created = new Set<object>()
  record.__DSH_TP_PANELS__ = created
  return created
})()

const SEPARATOR = ' \u00b7 '

function fallbackTranslate(key: string): string {
  return key
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
  try {
    const value = globalThis.localStorage?.getItem(key)
    if (value === '1' || value === 'true') return true
    if (value === '0' || value === 'false') return false
  } catch {
    // storage unavailable: use the default
  }
  return fallback
}

function storeBoolean(key: string, value: boolean): void {
  try {
    globalThis.localStorage?.setItem(key, value ? '1' : '0')
  } catch {
    // ignore
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function describeListError(error: unknown): ListError {
  if (error instanceof ApiError) {
    return { message: error.message, missingService: error.status === 404 || error.status === 503 }
  }
  const message = errorMessage(error)
  const networkish = error instanceof TypeError || /fetch|network|load failed/iu.test(message)
  return { message, missingService: networkish }
}

function sortByRecency(list: SessionInfo[]): SessionInfo[] {
  return [...list].sort((left, right) => {
    const leftTime = left.createdAt || left.updatedAt
    const rightTime = right.createdAt || right.updatedAt
    return rightTime - leftTime
  })
}

function pickPreferred(list: SessionInfo[]): SessionInfo | undefined {
  const ordered = sortByRecency(list)
  return (
    ordered.find((session) => session.state === 'running' && session.kind === 'command') ??
    ordered.find((session) => session.state === 'running') ??
    ordered[0]
  )
}

function truncateLine(text: string, max: number): string {
  const line = (text.split(/\r?\n/u)[0] ?? '').trim()
  return line.length > max ? `${line.slice(0, max - 1)}\u2026` : line
}

function sessionTitle(
  session: SessionInfo,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  const title = session.title.trim()
  if (title !== '' && title !== session.id) return title
  if (session.kind === 'command' && session.command) return truncateLine(session.command, 80)
  if (session.shellKind !== '') return session.shellKind
  return t(session.kind === 'command' ? 'commandSession' : 'interactiveSession')
}

function stateLabel(
  session: SessionInfo,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  if (session.state === 'running') return t('running')
  const code = session.exitCode === null ? '\u2014' : String(session.exitCode)
  if (session.state === 'failed') return `${t('failed')}: ${code}`
  return t('exitedShort', { code })
}

function formatDuration(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return '\u2014'
  if (value < 1000) return `${Math.round(value)}ms`
  const seconds = value / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${Math.round(seconds - minutes * 60)}s`
}

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '\u2014'
  try {
    return new Date(value).toLocaleTimeString()
  } catch {
    return '\u2014'
  }
}

function isSandboxed(session: SessionInfo | null | undefined): boolean {
  return session === null || session === undefined || session.sandbox.mode === 'danger-full-access'
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

function downloadText(filename: string, text: string): void {
  try {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 2000)
  } catch {
    // Download blocked: caller may show a toast.
  }
}

function isMacPlatform(): boolean {
  const source =
    typeof navigator === 'undefined'
      ? ''
      : `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`
  return /mac/iu.test(source)
}

function primaryLabel(): string {
  return isMacPlatform() ? '\u2318' : 'Ctrl'
}

interface ShortcutRow {
  label: string
  keys: string
}

function shortcutRows(
  t: (key: string, params?: Record<string, unknown>) => string,
): ShortcutRow[] {
  const primary = primaryLabel()
  return [
    { label: t('title'), keys: `${primary}+Shift+\`` },
    { label: t('newTerminal'), keys: `${primary}+Alt+T` },
    { label: t('closeSession'), keys: `${primary}+Alt+W` },
    { label: t('nextTab'), keys: `${primary}+Alt+\u2192` },
    { label: t('prevTab'), keys: `${primary}+Alt+\u2190` },
    { label: t('followLatest'), keys: `${primary}+Alt+F` },
    { label: t('search'), keys: `${primary}+F` },
    { label: t('copySelection'), keys: `${primary}+Shift+C` },
    { label: t('paste'), keys: `${primary}+Shift+V` },
  ]
}

function configSnippet(config: ConfigInfo): string {
  const entries: Array<[string, unknown]> = [
    ['interceptShellTools', config.config.interceptShellTools],
    ['interceptMinVisibleMs', config.config.interceptMinVisibleMs],
    ['autoCloseCommandDelayMs', config.config.autoCloseCommandDelayMs],
    ['autoCloseFailedDelayMs', config.config.autoCloseFailedDelayMs],
    ['autoCloseToolTerminals', config.config.autoCloseToolTerminals],
    ['autoCloseNotice', config.config.autoCloseNotice],
    ['historySize', config.config.historySize],
    ['maxSessions', config.config.maxSessions],
    ['perSessionMaxSessions', config.config.perSessionMaxSessions],
    ['scrollback', config.config.scrollback],
    ['shellPath', config.config.shellPath],
  ]
  const lines = entries.map(
    ([key, value]) => `    ${key}: ${value === null ? 'null' : String(value)}`,
  )
  return ['- id: dsh-live-terminal', '  name: dsh-live-terminal', '  config:', ...lines].join('\n')
}

/** Stable id for the tabpanel/aria wiring (React 18 `useId` equivalent). */
function useStableId(prefix: string): string {
  const [id] = useState(() => `${prefix}-${Math.random().toString(36).slice(2, 10)}`)
  return id
}

export function Panel(props: PanelProps) {
  const t = props.t ?? fallbackTranslate
  const conversationSessionId =
    typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : undefined
  const clientId = getClientId()

  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [phase, setPhase] = useState<ListPhase>('loading')
  const [listError, setListError] = useState<ListError | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [view, setView] = useState<ViewState>({ mode: 'terminal' })
  const [creating, setCreating] = useState(false)
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [streamConnected, setStreamConnected] = useState(false)
  const [reconnectToken, setReconnectToken] = useState(0)
  const [termError, setTermError] = useState<string | null>(null)
  const [, setTermReady] = useState(false)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [streamEnabled, setStreamEnabled] = useState(false)
  const [follow, setFollow] = useState<boolean>(() => readStoredBoolean(FOLLOW_STORAGE_KEY, true))
  const [onlyThisSession, setOnlyThisSession] = useState<boolean>(() =>
    readStoredBoolean(GROUP_STORAGE_KEY, true),
  )
  const [unread, setUnread] = useState<Set<string>>(() => new Set())
  const [menuOpen, setMenuOpen] = useState(false)
  const [dialog, setDialog] = useState<DialogKind>(null)
  const [renameTarget, setRenameTarget] = useState<SessionInfo | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [config, setConfig] = useState<ConfigInfo | null>(null)
  const [configLoading, setConfigLoading] = useState(false)
  const [configError, setConfigError] = useState<string | null>(null)
  const [hovered, setHovered] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [hasSelection, setHasSelection] = useState(false)
  const [sandboxDismissed, setSandboxDismissed] = useState<boolean>(() =>
    readStoredBoolean(SANDBOX_DISMISS_STORAGE_KEY, false),
  )

  const rootRef = useRef<HTMLElement | null>(null)
  const selectedIdRef = useRef<string | null>(null)
  selectedIdRef.current = selectedId
  const followRef = useRef(follow)
  followRef.current = follow
  const sessionsRef = useRef<SessionInfo[]>([])
  sessionsRef.current = sessions
  const knownIdsRef = useRef<Set<string>>(new Set())
  const initializedRef = useRef(false)
  const controllerRef = useRef<TerminalController | null>(null)
  const lastSizeRef = useRef({ ...DEFAULT_SIZE })
  const creatingRef = useRef(false)
  const conversationSessionIdRef = useRef<string | undefined>(conversationSessionId)
  conversationSessionIdRef.current = conversationSessionId
  const pauseRequestsRef = useRef<Set<string>>(new Set())
  const manualSelectionRef = useRef<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const tabRefs = useRef(new Map<string, HTMLDivElement>())
  const tabPanelId = useStableId('dshtp-panel')

  /* ---------------------------------------------------------------- */
  /* Toasts / session updates                                          */
  /* ---------------------------------------------------------------- */
  const showToast = useCallback(
    (
      text: string,
      kind: 'info' | 'error' = 'info',
      duration: number = TOAST_MS,
      actions: ToastAction[] = [],
    ): void => {
      setToast({ text, kind, duration, actions })
    },
    [],
  )

  const updateSession = useCallback(
    (id: string, patch: Omit<SessionInfoPatch, 'id'>): void => {
      setSessions((previous) => {
        const index = previous.findIndex((session) => session.id === id)
        if (index === -1) return previous
        const next = previous.slice()
        next[index] = {
          ...previous[index],
          ...stripUndefined({ ...patch, id } as SessionInfoPatch),
        } as SessionInfo
        return next
      })
    },
    [],
  )

  /* ---------------------------------------------------------------- */
  /* Session list                                                      */
  /* ---------------------------------------------------------------- */
  const loadSessions = useCallback(async (options?: { silent?: boolean }): Promise<boolean> => {
    try {
      const next = await listSessions()
      setSessions(next)
      setPhase('ready')
      setListError(null)
      setStreamEnabled(true)
      return true
    } catch (error) {
      if (!options?.silent) {
        setPhase('error')
        setListError(describeListError(error))
      }
      return false
    }
  }, [])

  useEffect(() => {
    void loadSessions()
  }, [loadSessions])

  const retryList = useCallback((): void => {
    setPhase('loading')
    setListError(null)
    void loadSessions()
  }, [loadSessions])

  const applySessions = useCallback((payload: SessionInfo[] | SessionInfo): void => {
    setPhase('ready')
    setListError(null)
    if (Array.isArray(payload)) {
      setSessions(payload)
      return
    }
    setSessions((previous) => {
      const index = previous.findIndex((session) => session.id === payload.id)
      if (index === -1) return [...previous, payload]
      const next = previous.slice()
      next[index] = { ...previous[index], ...payload }
      return next
    })
  }, [])

  /* ---------------------------------------------------------------- */
  /* Selection                                                         */
  /* ---------------------------------------------------------------- */
  const focusTerminalSurface = useCallback((): void => {
    // Two frames: the first lets the freshly selected TerminalView mount, the
    // second focuses the controller it reported.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        try {
          controllerRef.current?.focus()
        } catch {
          // terminal may have unmounted between frames
        }
      })
    })
  }, [])

  const selectSession = useCallback(
    (id: string): void => {
      // A user-initiated selection pauses that terminal's auto-close; the
      // follow-latest auto-selection must NOT pause, otherwise every agent
      // command would stay open forever.
      manualSelectionRef.current = id
      setSelectedId(id)
      setFollow(false)
      storeBoolean(FOLLOW_STORAGE_KEY, false)
      setUnread((previous) => {
        if (!previous.has(id)) return previous
        const next = new Set(previous)
        next.delete(id)
        return next
      })
      setView({ mode: 'terminal' })
      focusTerminalSurface()
    },
    [focusTerminalSurface],
  )

  // Auto-select new sessions when following; otherwise mark them unread.
  useEffect(() => {
    const known = knownIdsRef.current
    const fresh = sessions.filter((session) => !known.has(session.id))
    for (const session of sessions) known.add(session.id)
    if (!initializedRef.current) {
      initializedRef.current = true
      if (selectedIdRef.current === null) {
        const preferred = pickPreferred(sessions)
        if (preferred) setSelectedId(preferred.id)
      }
      return
    }
    if (fresh.length === 0) return
    if (followRef.current) {
      const preferred = pickPreferred(fresh)
      if (preferred && preferred.id !== selectedIdRef.current) setSelectedId(preferred.id)
      return
    }
    setUnread((previous) => {
      const next = new Set(previous)
      for (const session of fresh) {
        if (session.id !== selectedIdRef.current) next.add(session.id)
      }
      return next
    })
  }, [sessions])

  useEffect(() => {
    if (sessions.length === 0) {
      if (selectedId !== null) setSelectedId(null)
      return
    }
    if (selectedId !== null && sessions.some((session) => session.id === selectedId)) return
    const preferred = pickPreferred(sessions)
    setSelectedId(preferred ? preferred.id : null)
  }, [sessions, selectedId])

  useEffect(() => {
    setConnection('connecting')
    setTermError(null)
    setTermReady(false)
  }, [selectedId, reconnectToken])

  /* ---------------------------------------------------------------- */
  /* Session info merging (from the session SSE stream)                */
  /* ---------------------------------------------------------------- */
  const updateInfo = useCallback((patch: SessionInfo | SessionInfoPatch): void => {
    setSessions((previous) => {
      const index = previous.findIndex((session) => session.id === patch.id)
      if (index === -1) return isFullSessionInfo(patch) ? [...previous, patch] : previous
      const next = previous.slice()
      next[index] = { ...previous[index], ...stripUndefined(patch) }
      return next
    })
  }, [])

  const handleConnectionChange = useCallback((connected: boolean): void => {
    setConnection(connected ? 'connected' : 'disconnected')
  }, [])

  const handleController = useCallback((controller: TerminalController | null): void => {
    controllerRef.current = controller
    if (controller) {
      try {
        lastSizeRef.current = controller.getDimensions()
      } catch {
        // ignore
      }
    }
  }, [])

  /* ---------------------------------------------------------------- */
  /* Derived selection + auto-close countdown                          */
  /* ---------------------------------------------------------------- */
  const selectedSession = useMemo(() => {
    const fromList = sessions.find((session) => session.id === selectedId) ?? null
    if (fromList) return fromList
    if (sessions.length === 0) return null
    return pickPreferred(sessions) ?? null
  }, [sessions, selectedId])

  const hasAnyCountdown = useMemo(
    () =>
      sessions.some(
        (session) =>
          session.autoCloseAt !== null && !session.autoClosePaused && !session.pinned,
      ),
    [sessions],
  )

  useEffect(() => {
    if (!hasAnyCountdown) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS)
    return () => window.clearInterval(timer)
  }, [hasAnyCountdown])

  const secondsFor = useCallback(
    (session: SessionInfo): number =>
      session.autoCloseAt === null
        ? 0
        : Math.max(0, Math.ceil((session.autoCloseAt - now) / 1000)),
    [now],
  )

  const countdownSession =
    selectedSession !== null &&
    selectedSession.autoCloseAt !== null &&
    !selectedSession.autoClosePaused &&
    !selectedSession.pinned
      ? selectedSession
      : null
  const countdownSeconds = countdownSession ? secondsFor(countdownSession) : 0

  const pauseAutoClose = useCallback(
    (session: SessionInfo | null | undefined, reason: string): void => {
      if (!session) return
      if (session.autoCloseAt === null || session.autoClosePaused || session.pinned) return
      if (pauseRequestsRef.current.has(session.id)) return
      pauseRequestsRef.current.add(session.id)
      updateSession(session.id, { autoClosePaused: true })
      void setAutoClosePaused(session.id, true, reason)
        .then((info) => {
          if (info) updateInfo(info)
        })
        .catch(() => {
          // 404: the host already closed it; the sessions event catches up.
        })
        .finally(() => pauseRequestsRef.current.delete(session.id))
    },
    [updateInfo, updateSession],
  )

  // Hovering the screen/row pauses via the handlers. A *manual* selection keeps
  // pausing whenever that session enters its auto-close window (auto-follow
  // selection intentionally never pauses, or nothing would ever close).
  useEffect(() => {
    if (!selectedSession) return
    if (manualSelectionRef.current !== selectedSession.id) return
    pauseAutoClose(selectedSession, 'selection')
  }, [selectedSession, pauseAutoClose])

  const keepTerminal = useCallback(
    (session: SessionInfo | null | undefined): void => {
      if (!session) return
      updateSession(session.id, { pinned: true, autoCloseAt: null, autoClosePaused: true })
      void keepSession(session.id)
        .then((info) => {
          if (info) updateInfo(info)
          showToast(t('pinned'), 'info')
        })
        .catch((error: unknown) =>
          showToast(`${t('keepOpen')}: ${errorMessage(error)}`, 'error'),
        )
    },
    [showToast, t, updateInfo, updateSession],
  )

  /* ---------------------------------------------------------------- */
  /* Global SSE (session list + notices)                               */
  /* ---------------------------------------------------------------- */
  const openHistory = useCallback(async (terminalId?: string): Promise<void> => {
    setDialog('history')
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      let entries = await fetchHistory({ limit: 30 })
      if (terminalId !== undefined && terminalId !== '') {
        const match = entries.find((entry) => entry.id === terminalId)
        if (match === undefined) {
          const specific = await fetchHistory({ limit: 1, terminalId })
          entries = [...specific, ...entries]
        }
      }
      setHistoryEntries(entries)
    } catch (error) {
      setHistoryError(errorMessage(error))
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  const focusTerminal = useCallback(
    (terminalId: string): void => {
      if (sessionsRef.current.some((session) => session.id === terminalId)) {
        selectSession(terminalId)
        return
      }
      void openHistory(terminalId)
    },
    [openHistory, selectSession],
  )

  const handleNotice = useCallback(
    (notice: Notice): void => {
      if (notice.type === 'auto-close') {
        const code = notice.exitCode ?? notice.signal ?? '\u2014'
        const text =
          notice.reason === 'failed'
            ? t('autoClosedFailed', { code: String(code), title: notice.title })
            : t('autoClosedSucceeded', { title: notice.title })
        showToast(text, notice.reason === 'failed' ? 'error' : 'info', NOTICE_TOAST_MS, [
          { label: t('viewHistory'), onClick: () => void openHistory(notice.terminalId) },
        ])
        return
      }
      if (notice.type === 'command-finished') {
        if (notice.terminalId !== selectedIdRef.current) {
          setUnread((previous) => {
            if (previous.has(notice.terminalId)) return previous
            const next = new Set(previous)
            next.add(notice.terminalId)
            return next
          })
        }
        if (notice.exitCode !== null && notice.exitCode !== 0) {
          showToast(
            t('failedCommand', { code: String(notice.exitCode) }),
            'error',
            NOTICE_TOAST_MS,
            [{ label: t('viewTerminal'), onClick: () => focusTerminal(notice.terminalId) }],
          )
        }
        return
      }
      // `port` and `capture-request` are handled elsewhere (links / TerminalView).
    },
    [focusTerminal, openHistory, showToast, t],
  )

  const handleNoticeRef = useRef(handleNotice)
  handleNoticeRef.current = handleNotice

  useEffect(() => {
    if (!streamEnabled) return
    let disposed = false
    let pollTimer: number | undefined
    const unsubscribe = openSessionsStream({
      onOpen: () => {
        if (disposed) return
        setStreamConnected(true)
        if (pollTimer !== undefined) {
          window.clearInterval(pollTimer)
          pollTimer = undefined
        }
      },
      onError: () => {
        if (disposed) return
        setStreamConnected(false)
        if (pollTimer === undefined) {
          pollTimer = window.setInterval(() => {
            void loadSessions({ silent: true })
          }, SESSION_POLL_MS)
        }
      },
      onSessions: (payload) => {
        if (!disposed) applySessions(payload)
      },
      onNotice: (notice) => {
        if (!disposed) handleNoticeRef.current(notice)
      },
    })
    return () => {
      disposed = true
      unsubscribe()
      if (pollTimer !== undefined) window.clearInterval(pollTimer)
    }
  }, [streamEnabled, applySessions, loadSessions])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), toast.duration)
    return () => window.clearTimeout(timer)
  }, [toast])

  /* ---------------------------------------------------------------- */
  /* Actions                                                           */
  /* ---------------------------------------------------------------- */
  const createTerminal = useCallback(async (): Promise<void> => {
    if (creatingRef.current) return
    creatingRef.current = true
    setCreating(true)
    try {
      const dimensions = controllerRef.current?.getDimensions() ?? lastSizeRef.current
      const info = await createSession({
        cols: Math.max(2, dimensions.cols),
        rows: Math.max(1, dimensions.rows),
        sessionId: conversationSessionIdRef.current,
      })
      knownIdsRef.current.add(info.id)
      setPhase('ready')
      setListError(null)
      setSessions((previous) =>
        previous.some((session) => session.id === info.id) ? previous : [...previous, info],
      )
      selectSession(info.id)
      window.setTimeout(() => {
        try {
          controllerRef.current?.fit()
          controllerRef.current?.focus()
        } catch {
          // ignore
        }
      }, 120)
    } catch (error) {
      showToast(`${t('createFailed')}: ${errorMessage(error)}`, 'error')
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }, [selectSession, showToast, t])

  const closeTerminal = useCallback(
    async (id?: string): Promise<void> => {
      const target = id ?? selectedIdRef.current
      if (!target) return
      setSessions((previous) => previous.filter((session) => session.id !== target))
      if (selectedIdRef.current === target) {
        setSelectedId(null)
        setTermError(null)
      }
      setUnread((previous) => {
        if (!previous.has(target)) return previous
        const next = new Set(previous)
        next.delete(target)
        return next
      })
      try {
        await closeSession(target)
      } catch (error) {
        // 404 means it was already closed (auto-close race): that is the intent.
        if (!(error instanceof ApiError && error.status === 404)) {
          showToast(`${t('closeFailed')}: ${errorMessage(error)}`, 'error')
        }
      }
      focusTerminalSurface()
    },
    [focusTerminalSurface, showToast, t],
  )

  const closeMany = useCallback(async (ids: string[]): Promise<void> => {
    if (ids.length === 0) return
    setSessions((previous) => previous.filter((session) => !ids.includes(session.id)))
    if (selectedIdRef.current !== null && ids.includes(selectedIdRef.current)) {
      setSelectedId(null)
    }
    await Promise.allSettled(ids.map((id) => closeSession(id)))
  }, [])

  const reconnect = useCallback((): void => {
    setTermError(null)
    setConnection('connecting')
    setReconnectToken((value) => value + 1)
    void loadSessions({ silent: true })
  }, [loadSessions])

  const resync = useCallback((): void => {
    void loadSessions()
    setReconnectToken((value) => value + 1)
  }, [loadSessions])

  const copyScreen = useCallback(async (): Promise<void> => {
    const text = controllerRef.current?.getVisibleText() ?? ''
    if (text.trim() === '') {
      showToast(t('copyFailed'), 'error')
      return
    }
    const copied = await writeClipboard(text)
    showToast(copied ? t('copied') : t('copyFailed'), copied ? 'info' : 'error')
  }, [showToast, t])

  const copySelection = useCallback(async (): Promise<void> => {
    try {
      const copied = await controllerRef.current?.copySelection()
      if (copied === false) showToast(t('copySelection'), 'info')
    } catch (error) {
      showToast(errorMessage(error), 'error')
    }
  }, [showToast, t])

  const handleTakeControl = useCallback(async (): Promise<void> => {
    const session = selectedSession
    if (!session) return
    updateSession(session.id, { writerClientId: clientId })
    try {
      await takeControl(session.id, clientId)
      showToast(t('takeControl'), 'info')
      focusTerminalSurface()
    } catch (error) {
      showToast(errorMessage(error), 'error')
    }
  }, [clientId, focusTerminalSurface, selectedSession, showToast, t, updateSession])

  const handleExport = useCallback((): void => {
    if (!selectedSession) return
    try {
      const link = document.createElement('a')
      link.href = exportUrl(selectedSession.id, 'text')
      link.rel = 'noopener'
      document.body.appendChild(link)
      link.click()
      link.remove()
    } catch (error) {
      showToast(errorMessage(error), 'error')
    }
  }, [selectedSession, showToast])

  const handleSavePng = useCallback((): void => {
    const dataUrl = controllerRef.current?.savePng(true) ?? null
    showToast(
      dataUrl === null ? t('copyFailed') : t('screenshot'),
      dataUrl === null ? 'error' : 'info',
    )
  }, [showToast, t])

  const openRename = useCallback((session: SessionInfo): void => {
    setRenameTarget(session)
    setRenameValue(session.title)
    setDialog('rename')
  }, [])

  const submitRename = useCallback(async (): Promise<void> => {
    const target = renameTarget
    const title = renameValue.trim()
    if (!target || title === '') {
      setDialog(null)
      return
    }
    updateSession(target.id, { title })
    setDialog(null)
    try {
      const info = await renameSession(target.id, title)
      if (info) updateInfo(info)
    } catch (error) {
      showToast(`${t('rename')}: ${errorMessage(error)}`, 'error')
    }
  }, [renameTarget, renameValue, showToast, t, updateInfo, updateSession])

  const toggleFollow = useCallback((): void => {
    setFollow((previous) => {
      const next = !previous
      storeBoolean(FOLLOW_STORAGE_KEY, next)
      if (next) {
        const preferred = pickPreferred(sessionsRef.current)
        if (preferred) setSelectedId(preferred.id)
        setUnread(new Set())
      }
      return next
    })
  }, [])

  const toggleOnlyThisSession = useCallback((): void => {
    setOnlyThisSession((previous) => {
      const next = !previous
      storeBoolean(GROUP_STORAGE_KEY, next)
      return next
    })
  }, [])

  const openConfig = useCallback((): void => {
    setDialog('config')
    if (config !== null) return
    setConfigLoading(true)
    setConfigError(null)
    void fetchConfig()
      .then((info) => setConfig(info))
      .catch((error: unknown) => setConfigError(errorMessage(error)))
      .finally(() => setConfigLoading(false))
  }, [config])

  const copyConfig = useCallback(async (): Promise<void> => {
    if (!config) return
    const copied = await writeClipboard(configSnippet(config))
    showToast(copied ? t('configCopied') : t('copyFailed'), copied ? 'info' : 'error')
  }, [config, showToast, t])

  /* ---------------------------------------------------------------- */
  /* Session strip                                                     */
  /* ---------------------------------------------------------------- */
  const orderedSessions = useMemo(() => sortByRecency(sessions), [sessions])

  const scopedSessions = useMemo(() => {
    if (!onlyThisSession || conversationSessionId === undefined) return orderedSessions
    const filtered = orderedSessions.filter(
      (session) => session.sessionId === undefined || session.sessionId === conversationSessionId,
    )
    return filtered.length > 0 ? filtered : orderedSessions
  }, [conversationSessionId, onlyThisSession, orderedSessions])

  const canGroup = useMemo(
    () =>
      conversationSessionId !== undefined &&
      sessions.some((session) => session.sessionId === conversationSessionId),
    [conversationSessionId, sessions],
  )

  const selectedTabId = selectedSession
    ? `${tabPanelId}-tab-${selectedSession.id}`
    : undefined

  useEffect(() => {
    if (!selectedSession) return
    const element = tabRefs.current.get(selectedSession.id)
    try {
      element?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    } catch {
      // older browsers: ignore
    }
  }, [selectedSession])

  const cycleTab = useCallback(
    (delta: number): void => {
      const list = scopedSessions
      if (list.length === 0) return
      const currentIndex = list.findIndex((session) => session.id === selectedSession?.id)
      const base = currentIndex < 0 ? 0 : currentIndex
      const next = list[(base + delta + list.length) % list.length]
      if (next) selectSession(next.id)
    },
    [scopedSessions, selectSession, selectedSession],
  )

  const handleTabListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    event.preventDefault()
    cycleTab(event.key === 'ArrowRight' ? 1 : -1)
  }

  const tabKeyDown =
    (session: SessionInfo) =>
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (event.target !== event.currentTarget) return
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        selectSession(session.id)
        return
      }
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault()
        cycleTab(event.key === 'ArrowRight' ? 1 : -1)
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        void closeTerminal(session.id)
        return
      }
      if (event.key === 'F2') {
        event.preventDefault()
        openRename(session)
      }
    }

  /* ---------------------------------------------------------------- */
  /* index.tsx shortcut/command bridge                                 */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    activePanel.root = rootRef.current
    const node = rootRef.current
    const mountToken = {}
    panelMountRegistry.add(mountToken)
    const onCommand = (event: Event): void => {
      if (activePanel.root !== node) return
      const detail = (event as CustomEvent<{ command?: string }>).detail
      const command = detail?.command
      if (command === undefined) return
      if (command === 'new') void createTerminal()
      else if (command === 'close') {
        const current = sessionsRef.current.find(
          (session) => session.id === selectedIdRef.current,
        )
        if (current) void closeTerminal(current.id)
      } else if (command === 'next-tab') cycleTab(1)
      else if (command === 'prev-tab') cycleTab(-1)
      else if (command === 'follow') toggleFollow()
      else if (command === 'history') void openHistory()
      else if (command === 'open' || command === 'focus') focusTerminalSurface()
    }
    window.addEventListener('dsh-live-terminal:command', onCommand)
    return () => {
      window.removeEventListener('dsh-live-terminal:command', onCommand)
      panelMountRegistry.delete(mountToken)
      if (activePanel.root === node) activePanel.root = null
    }
  }, [
    closeTerminal,
    createTerminal,
    cycleTab,
    focusTerminalSurface,
    openHistory,
    toggleFollow,
  ])

  /* Menu / dialog dismissal */
  useEffect(() => {
    if (!menuOpen) return
    const close = (): void => setMenuOpen(false)
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', close)
    }
  }, [menuOpen])

  useEffect(() => {
    if (dialog === null) return
    window.setTimeout(() => {
      if (dialog === 'rename') {
        renameInputRef.current?.focus()
        renameInputRef.current?.select()
        return
      }
      const focusable = dialogRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      focusable?.focus()
    }, 0)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setDialog(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dialog])

  /* ---------------------------------------------------------------- */
  /* Derived UI state                                                  */
  /* ---------------------------------------------------------------- */
  const selected = selectedSession
  const readOnly =
    selected !== null &&
    selected.writerClientId !== undefined &&
    selected.writerClientId !== '' &&
    selected.writerClientId !== clientId
  const sandboxWarn = selected !== null && !isSandboxed(selected) && !sandboxDismissed
  const abnormal =
    selected !== null &&
    (selected.state !== 'running' ||
      connection === 'disconnected' ||
      termError !== null ||
      readOnly ||
      countdownSession !== null)
  const statusVisible = hovered || abnormal

  const failure = listError
  const failureDetail = failure
    ? failure.missingService
      ? t('hostNotReady')
      : t('listErrorHint')
    : null
  const finishedSessions = sessions.filter((session) => session.state !== 'running')
  const otherSessions = sessions.filter((session) => session.id !== selected?.id)
  const unreadCount = unread.size
  const closeMenu = (): void => setMenuOpen(false)

  const handleDialogBackdrop = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) setDialog(null)
  }

  const tabBadges = (session: SessionInfo): TabBadge | null => {
    if (unread.has(session.id)) return { kind: 'unread', text: t('unread') }
    if (session.autoCloseAt !== null && !session.autoClosePaused && !session.pinned) {
      const seconds = secondsFor(session)
      if (seconds > 0) {
        return {
          kind: 'countdown',
          text: `${seconds}s`,
          title: t('autoCloseIn', { seconds: String(seconds) }),
        }
      }
    }
    if (session.state === 'failed') return { kind: 'error', text: '!' }
    if (session.state === 'running') {
      return { kind: 'running', text: t('runningShort'), title: t('running') }
    }
    if (session.id === selected?.id && !isSandboxed(session)) {
      return { kind: 'sandbox', text: t('sandboxBadge'), title: t('sandboxHint') }
    }
    if (session.kind === 'interactive' && session.shellKind !== '') {
      return { kind: 'shell', text: session.shellKind, title: t('shellLabel') }
    }
    return null
  }

  const renderTab = (session: SessionInfo): JSX.Element => {
    const active = session.id === selected?.id
    const title = sessionTitle(session, t)
    const stateText = stateLabel(session, t)
    const badge = tabBadges(session)
    return (
      <div
        key={session.id}
        ref={(element) => {
          if (element) tabRefs.current.set(session.id, element)
          else tabRefs.current.delete(session.id)
        }}
        className="dshtp-tab"
        role="tab"
        id={`${tabPanelId}-tab-${session.id}`}
        aria-controls={tabPanelId}
        aria-selected={active}
        aria-label={`${title}, ${stateText}${session.pinned ? `, ${t('pinned')}` : ''}${unread.has(session.id) ? `, ${t('unread')}` : ''}`}
        tabIndex={active ? 0 : -1}
        data-active={active ? 'true' : 'false'}
        data-state={session.state}
        data-pinned={session.pinned ? 'true' : 'false'}
        data-dsh-tp-session-id={session.id}
        title={`${title}${SEPARATOR}${stateText}${SEPARATOR}${session.cwd}`}
        onClick={() => selectSession(session.id)}
        onDoubleClick={() => openRename(session)}
        onAuxClick={(event) => {
          if (event.button === 1) {
            event.preventDefault()
            void closeTerminal(session.id)
          }
        }}
        onKeyDown={tabKeyDown(session)}
        onMouseEnter={() => pauseAutoClose(session, 'hover')}
      >
        <span className="dshtp-dot" data-state={session.state} />
        <span className="dshtp-tab-title">{title}</span>
        {badge ? (
          <span className="dshtp-tab-badge" data-kind={badge.kind} title={badge.title}>
            {badge.text}
          </span>
        ) : null}
        <button
          type="button"
          className="dshtp-tab-keep"
          data-active={session.pinned ? 'true' : 'false'}
          aria-pressed={session.pinned}
          aria-label={session.pinned ? t('pinned') : t('pin')}
          title={session.pinned ? t('pinned') : t('keepOpenHint')}
          onClick={(event) => {
            event.stopPropagation()
            keepTerminal(session)
          }}
        >
          <IconPin size={11} />
        </button>
        <button
          type="button"
          className="dshtp-tab-close"
          aria-label={`${t('closeSession')}: ${title}`}
          title={t('closeSession')}
          onClick={(event) => {
            event.stopPropagation()
            void closeTerminal(session.id)
          }}
        >
          <IconClose size={11} />
        </button>
      </div>
    )
  }

  const terminalNode =
    selected !== null && view.mode === 'terminal' ? (
      <TerminalView
        key={selected.id}
        sessionId={selected.id}
        clientId={clientId}
        t={t}
        writable={!readOnly}
        reconnectToken={reconnectToken}
        onConnectionChange={handleConnectionChange}
        onReady={setTermReady}
        onInfo={updateInfo}
        onError={(message) => setTermError(message)}
        onWriterChange={(writer) => {
          if (writer !== undefined) updateSession(selected.id, { writerClientId: writer })
        }}
        onInputError={(message) => showToast(`${t('inputFailed')}: ${message}`, 'error')}
        onReadOnlyInput={() => showToast(t('takeControlHint'), 'info')}
        onUserActivity={() => {
          setFollow(false)
          storeBoolean(FOLLOW_STORAGE_KEY, false)
          pauseAutoClose(selectedSession, 'activity')
        }}
        onSelectionChange={setHasSelection}
        onToast={(text, kind) => showToast(text, kind === 'error' ? 'error' : 'info')}
        onController={handleController}
      />
    ) : null

  const bannerNodes: JSX.Element[] = []
  if (termError !== null) {
    bannerNodes.push(
      <div className="dshtp-banner" data-kind="error" role="alert" key="term-error">
        <span className="dshtp-banner-text">
          {t('listError')}: {termError}
        </span>
        <span className="dshtp-banner-actions">
          <button type="button" className="dshtp-action" data-variant="primary" onClick={reconnect}>
            {t('reconnect')}
          </button>
          <button
            type="button"
            className="dshtp-banner-close"
            aria-label={t('dismiss')}
            title={t('dismiss')}
            onClick={() => setTermError(null)}
          >
            <IconClose size={12} />
          </button>
        </span>
      </div>,
    )
  }
  if (selected !== null && connection === 'disconnected') {
    bannerNodes.push(
      <div className="dshtp-banner" data-kind="warn" role="alert" key="disconnected">
        <span className="dshtp-banner-text">{t('connectionLostScreenKept')}</span>
        <span className="dshtp-banner-actions">
          <button type="button" className="dshtp-action" onClick={reconnect}>
            {t('reconnect')}
          </button>
        </span>
      </div>,
    )
  }
  if (countdownSession !== null && countdownSeconds > 0) {
    bannerNodes.push(
      <div
        className="dshtp-banner"
        data-kind="warn"
        role="status"
        key="countdown"
        data-dsh-tp-auto-close
      >
        <span className="dshtp-banner-text">
          {t('autoCloseIn', { seconds: String(countdownSeconds) })}
        </span>
        <span className="dshtp-banner-actions">
          <button
            type="button"
            className="dshtp-action"
            data-variant="primary"
            onClick={() => keepTerminal(countdownSession)}
          >
            {t('keepOpen')}
          </button>
          <button
            type="button"
            className="dshtp-action"
            onClick={() => void closeTerminal(countdownSession.id)}
          >
            {t('autoCloseNow')}
          </button>
        </span>
      </div>,
    )
  }
  if (readOnly) {
    bannerNodes.push(
      <div className="dshtp-banner" data-kind="readonly" role="status" key="readonly">
        <span className="dshtp-banner-text">
          {t('readonlyBadge')}: {t('takeControlHint')}
        </span>
        <span className="dshtp-banner-actions">
          <button
            type="button"
            className="dshtp-action"
            data-variant="primary"
            onClick={() => void handleTakeControl()}
          >
            {t('takeControl')}
          </button>
        </span>
      </div>,
    )
  }
  if (sandboxWarn) {
    bannerNodes.push(
      <div className="dshtp-banner" data-kind="warn" role="status" key="sandbox">
        <span className="dshtp-banner-text">
          <strong>{t('notSandboxedTitle')}</strong> {t('notSandboxedBody')}
        </span>
        <span className="dshtp-banner-actions">
          <button
            type="button"
            className="dshtp-banner-close"
            aria-label={t('dismiss')}
            title={t('dismiss')}
            onClick={() => {
              setSandboxDismissed(true)
              storeBoolean(SANDBOX_DISMISS_STORAGE_KEY, true)
            }}
          >
            <IconClose size={12} />
          </button>
        </span>
      </div>,
    )
  }

  const historyView =
    view.mode === 'history' ? (
      <div
        className="dshtp-history-view"
        data-dsh-tp-history
        style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
      >
        <div className="dshtp-banner" data-kind="warn" role="status">
          <span className="dshtp-banner-text">
            {view.entry.title}
            {SEPARATOR}
            {view.entry.command || t('commandSession')}
            {SEPARATOR}
            {t('exitedShort', {
              code: view.entry.exitCode === null ? '\u2014' : String(view.entry.exitCode),
            })}
            {SEPARATOR}
            {formatDuration(view.entry.durationMs)}
            {SEPARATOR}
            {formatTime(view.entry.endedAt)}
          </span>
          <span className="dshtp-banner-actions">
            <button
              type="button"
              className="dshtp-action"
              onClick={() => {
                void writeClipboard(view.entry.text).then((copied) => {
                  showToast(copied ? t('copied') : t('copyFailed'), copied ? 'info' : 'error')
                })
              }}
            >
              {t('copySelection')}
            </button>
            <button
              type="button"
              className="dshtp-action"
              onClick={() => downloadText(`terminal-${view.entry.id}.txt`, view.entry.text)}
            >
              {t('exportText')}
            </button>
            <button
              type="button"
              className="dshtp-action"
              data-variant="primary"
              onClick={() => setView({ mode: 'terminal' })}
            >
              {t('viewTerminal')}
            </button>
          </span>
        </div>
        <pre className="dshtp-history-preview" style={{ margin: 0, flex: 1, overflow: 'auto' }}>
          {view.entry.text}
        </pre>
      </div>
    ) : null

  const historyDialogBody = (
    <div className="dshtp-history-list">
      {historyLoading ? (
        <div className="dshtp-history-empty">{t('loading')}</div>
      ) : historyError !== null ? (
        <div className="dshtp-error">
          <span className="dshtp-error-detail">{historyError}</span>
          <span className="dshtp-error-actions">
            <button type="button" className="dshtp-action" onClick={() => void openHistory()}>
              {t('retry')}
            </button>
          </span>
        </div>
      ) : historyEntries.length === 0 ? (
        <div className="dshtp-history-empty">
          <div>{t('historyEmpty')}</div>
          <div className="dshtp-dialog-hint">{t('historyHint')}</div>
        </div>
      ) : (
        historyEntries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="dshtp-history-item"
            onClick={() => {
              setDialog(null)
              setView({ mode: 'history', entry })
            }}
          >
            <span className="dshtp-history-title">{entry.title}</span>
            <span className="dshtp-history-meta">
              {entry.exitCode === null ? '\u2014' : `exit ${entry.exitCode}`}
              {SEPARATOR}
              {formatDuration(entry.durationMs)}
              {SEPARATOR}
              {formatTime(entry.endedAt)}
            </span>
            <span className="dshtp-history-cwd">{entry.cwd}</span>
            <span className="dshtp-history-preview">
              {entry.text.split(/\r?\n/u).slice(-2).join(' ').slice(0, 160)}
            </span>
            <span className="dshtp-history-badge" data-reason={entry.reason}>
              {entry.reason}
            </span>
          </button>
        ))
      )}
    </div>
  )

  const configField = (label: string, value: string): JSX.Element => (
    <div className="dshtp-dialog-field" key={label}>
      <label>{label}</label>
      <span>{value}</span>
    </div>
  )

  const configDialogBody = (
    <div>
      {configLoading ? (
        <div className="dshtp-dialog-hint">{t('loading')}</div>
      ) : configError !== null ? (
        <div className="dshtp-error">
          <span className="dshtp-error-detail">{configError}</span>
          <span className="dshtp-error-actions">
            <button
              type="button"
              className="dshtp-action"
              onClick={() => {
                setConfig(null)
                openConfig()
              }}
            >
              {t('retry')}
            </button>
          </span>
        </div>
      ) : config !== null ? (
        <>
          <p className="dshtp-dialog-hint">{t('configHint')}</p>
          {configField('interceptShellTools', String(config.config.interceptShellTools))}
          {configField('interceptMinVisibleMs', `${config.config.interceptMinVisibleMs} ms`)}
          {configField('autoCloseCommandDelayMs', `${config.config.autoCloseCommandDelayMs} ms`)}
          {configField('autoCloseFailedDelayMs', `${config.config.autoCloseFailedDelayMs} ms`)}
          {configField('autoCloseToolTerminals', String(config.config.autoCloseToolTerminals))}
          {configField('autoCloseNotice', config.config.autoCloseNotice)}
          {configField('historySize', String(config.config.historySize))}
          {configField('maxSessions', String(config.config.maxSessions))}
          {configField('perSessionMaxSessions', String(config.config.perSessionMaxSessions))}
          {configField('scrollback', String(config.config.scrollback))}
          {configField(
            t('shellLabel'),
            config.shell.path ?? config.shell.kind ?? '\u2014',
          )}
          {configField('sandbox', config.sandbox.mode)}
        </>
      ) : null}
    </div>
  )

  const shortcutDialogBody = (
    <div>
      <p className="dshtp-dialog-hint">{t('shortcutHelp')}</p>
      {shortcutRows(t).map((row) => (
        <div className="dshtp-dialog-field" key={row.label}>
          <label>{row.label}</label>
          <kbd>{row.keys}</kbd>
        </div>
      ))}
    </div>
  )

  const dialogTitle =
    dialog === 'config'
      ? t('configTitle')
      : dialog === 'history'
        ? t('history')
        : dialog === 'rename'
          ? t('rename')
          : t('shortcutHelp')

  const dialogElement =
    dialog !== null
      ? createPortal(
          <div
            className="dshtp-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={dialogTitle}
            onPointerDown={handleDialogBackdrop}
          >
            <div
              className="dshtp-dialog-card"
              ref={dialogRef}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div className="dshtp-dialog-header">
                <span className="dshtp-dialog-title">{dialogTitle}</span>
                <button
                  type="button"
                  className="dshtp-dialog-close"
                  aria-label={t('dismiss')}
                  title={t('dismiss')}
                  onClick={() => setDialog(null)}
                >
                  <IconClose size={12} />
                </button>
              </div>
              <div className="dshtp-dialog-body">
                {dialog === 'config'
                  ? configDialogBody
                  : dialog === 'history'
                    ? historyDialogBody
                    : dialog === 'rename'
                      ? (
                          <div className="dshtp-dialog-field">
                            <label>{t('renamePrompt')}</label>
                            <input
                              ref={renameInputRef}
                              className="dshtp-dialog-input"
                              type="text"
                              value={renameValue}
                              onChange={(event) => setRenameValue(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                                  event.preventDefault()
                                  void submitRename()
                                }
                              }}
                            />
                          </div>
                        )
                      : shortcutDialogBody}
              </div>
              <div className="dshtp-dialog-footer">
                <span className="dshtp-dialog-hint">
                  {dialog === 'rename'
                    ? t('renamePrompt')
                    : dialog === 'history'
                      ? t('historyHint')
                      : dialog === 'config'
                        ? t('configHint')
                        : ''}
                </span>
                <span className="dshtp-dialog-actions">
                  {dialog === 'config' ? (
                    <button
                      type="button"
                      className="dshtp-action"
                      onClick={() => void copyConfig()}
                      disabled={config === null}
                    >
                      {t('configCopy')}
                    </button>
                  ) : null}
                  {dialog === 'rename' ? (
                    <button
                      type="button"
                      className="dshtp-action"
                      data-variant="primary"
                      onClick={() => void submitRename()}
                    >
                      {t('rename')}
                    </button>
                  ) : null}
                  <button type="button" className="dshtp-action" onClick={() => setDialog(null)}>
                    {t('dismiss')}
                  </button>
                </span>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null

  const menuElement = menuOpen ? (
    <div
      className="dshtp-menu"
      role="menu"
      aria-label={t('more')}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        className="dshtp-menu-item"
        onClick={() => {
          closeMenu()
          void createTerminal()
        }}
      >
        <IconPlus size={13} /> {t('newTerminal')} <kbd>{primaryLabel()}+Alt+T</kbd>
      </button>
      <div className="dshtp-menu-sep" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="dshtp-menu-item"
        disabled={selected === null}
        onClick={() => {
          closeMenu()
          if (selected) openRename(selected)
        }}
      >
        <IconRename size={13} /> {t('rename')}
      </button>
      <button
        type="button"
        role="menuitem"
        className="dshtp-menu-item"
        disabled={selected === null}
        onClick={() => {
          closeMenu()
          keepTerminal(selectedSession)
        }}
      >
        <IconPin size={13} /> {t('keepOpen')}
      </button>
      <button
        type="button"
        role="menuitem"
        className="dshtp-menu-item"
        disabled={selected === null}
        onClick={() => {
          closeMenu()
          void copyScreen()
        }}
      >
        <IconClipboard size={13} /> {t('copyScreen')}
      </button>
      <button
        type="button"
        role="menuitem"
        className="dshtp-menu-item"
        disabled={selected === null || !hasSelection}
        onClick={() => {
          closeMenu()
          void copySelection()
        }}
      >
        <IconClipboard size={13} /> {t('copySelection')} <kbd>{primaryLabel()}+Shift+C</kbd>
      </button>
      <button
        type="button"
        role="menuitem"
        className="dshtp-menu-item"
        disabled={selected === null}
        onClick={() => {
          closeMenu()
          controllerRef.current?.openSearch()
        }}
      >
        <IconSearch size={13} /> {t('search')} <kbd>{primaryLabel()}+F</kbd>
      </button>
      <button
        type="button"
        role="menuitem"
        className="dshtp-menu-item"
        disabled={selected === null}
        onClick={() => {
          closeMenu()
          handleSavePng()
        }}
      >
        <IconExport size={13} /> {t('screenshot')} PNG
      </button>
      <button
        type="button"
        role="menuitem"
        className="dshtp-menu-item"
        disabled={selected === null}
        onClick={() => {
          closeMenu()
          handleExport()
        }}
      >
        <IconExport size={13} /> {t('exportText')}
      </button>
      <div className="dshtp-menu-sep" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="dshtp-menu-item"
        onClick={() => {
          closeMenu()
          void openHistory()
        }}
      >
        <IconHistory size={13} /> {t('history')}
        {unreadCount > 0 ? (
          <span className="dshtp-tab-badge" data-kind="unread">
            {unreadCount}
          </span>
        ) : null}
      </button>
      {canGroup ? (
        <button
          type="button"
          role="menuitem"
          className="dshtp-menu-item"
          onClick={() => {
            closeMenu()
            toggleOnlyThisSession()
          }}
        >
          {onlyThisSession ? <span aria-hidden="true">{'\u2713'}</span> : null} {t('title')}
        </button>
      ) : null}
      <button
        type="button"
        role="menuitem"
        className="dshtp-menu-item"
        disabled={finishedSessions.length === 0}
        onClick={() => {
          closeMenu()
          void closeMany(finishedSessions.map((session) => session.id))
        }}
      >
        {t('closeAllExited')}
      </button>
      <button
        type="button"
        role="menuitem"
        className="dshtp-menu-item"
        disabled={otherSessions.length === 0}
        onClick={() => {
          closeMenu()
          void closeMany(otherSessions.map((session) => session.id))
        }}
      >
        {t('closeOthers')}
      </button>
      <div className="dshtp-menu-sep" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="dshtp-menu-item"
        onClick={() => {
          closeMenu()
          resync()
        }}
      >
        <IconReconnect size={13} /> {t('reconnect')}
      </button>
      <button
        type="button"
        role="menuitem"
        className="dshtp-menu-item"
        onClick={() => {
          closeMenu()
          openConfig()
        }}
      >
        <IconSettings size={13} /> {t('config')}
      </button>
      <button
        type="button"
        role="menuitem"
        className="dshtp-menu-item"
        onClick={() => {
          closeMenu()
          setDialog('shortcuts')
        }}
      >
        <IconKeyboard size={13} /> {t('shortcuts')}
      </button>
    </div>
  ) : null

  const toastElement = toast ? (
    <div className="dshtp-toast" role="status" aria-live="polite" aria-atomic="true">
      <span className="dshtp-toast-text">{toast.text}</span>
      {toast.actions.length > 0 ? (
        <span className="dshtp-toast-actions">
          {toast.actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className="dshtp-action"
              onClick={() => {
                setToast(null)
                action.onClick()
              }}
            >
              {action.label}
            </button>
          ))}
        </span>
      ) : null}
      <button
        type="button"
        className="dshtp-toast-close"
        aria-label={t('dismiss')}
        title={t('dismiss')}
        onClick={() => setToast(null)}
      >
        <IconClose size={11} />
      </button>
    </div>
  ) : null

  const emptyState = (
    <div className="dshtp-empty" data-dsh-tp-state="empty">
      <span className="dshtp-empty-icon">
        <IconTerminal size={26} />
      </span>
      <span className="dshtp-empty-title">{t('empty')}</span>
      <span className="dshtp-empty-hint">{t('emptyHint')}</span>
      <span className="dshtp-empty-actions">
        <button
          type="button"
          className="dshtp-action"
          data-variant="primary"
          data-dsh-tp-action="create-empty"
          onClick={() => void createTerminal()}
        >
          <IconPlus size={13} /> {t('newTerminal')}
        </button>
        <button type="button" className="dshtp-action" onClick={() => void openHistory()}>
          <IconHistory size={13} /> {t('history')}
        </button>
      </span>
    </div>
  )

  const errorState = (
    <div className="dshtp-error" data-dsh-tp-state="error">
      <span className="dshtp-error-icon">
        <IconWarning size={24} />
      </span>
      <span className="dshtp-error-title">{t('listError')}</span>
      {failureDetail ? <span className="dshtp-error-detail">{failureDetail}</span> : null}
      {failure ? <span className="dshtp-error-detail">{failure.message}</span> : null}
      <span className="dshtp-error-actions">
        <button
          type="button"
          className="dshtp-action"
          data-variant="primary"
          data-dsh-tp-action="retry"
          onClick={retryList}
        >
          {t('retry')}
        </button>
      </span>
    </div>
  )

  const loadingState = (
    <div className="dshtp-skeleton" data-size="block" aria-busy="true">
      <div className="dshtp-skeleton" data-size="title" />
      <div className="dshtp-skeleton" data-size="line" />
      <div className="dshtp-skeleton" data-size="line" />
      <div className="dshtp-skeleton" data-size="line" />
    </div>
  )

  return (
    <section
      className="dshtp-root"
      ref={rootRef}
      data-dsh-terminal-panel="body"
      data-dsh-tp-phase={phase}
      data-dsh-tp-selected={selected?.id ?? ''}
      onMouseEnter={() => {
        setHovered(true)
        activePanel.root = rootRef.current
      }}
      onFocusCapture={() => {
        activePanel.root = rootRef.current
      }}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="dshtp-chrome">
        <button
          type="button"
          className="dshtp-new"
          data-action="create"
          data-dsh-tp-action="create"
          aria-label={creating ? t('creating') : t('newTerminal')}
          aria-busy={creating}
          title={
            creating
              ? t('creating')
              : `${t('newTerminal')} (${primaryLabel()}+Alt+T)`
          }
          onClick={() => void createTerminal()}
          disabled={creating}
        >
          <IconPlus size={14} />
        </button>
        <div
          className="dshtp-session-strip"
          role="tablist"
          aria-label={t('title')}
          data-dsh-tp-sessions
          onKeyDown={handleTabListKeyDown}
        >
          {scopedSessions.map(renderTab)}
        </div>
        <button
          type="button"
          className="dshtp-more"
          aria-label={t('more')}
          title={t('more')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          data-dsh-tp-action="more"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setMenuOpen((previous) => !previous)}
        >
          <IconMore size={14} />
        </button>
        <button
          type="button"
          className="dshtp-follow"
          data-follow={follow ? 'true' : 'false'}
          aria-pressed={follow}
          aria-label={follow ? t('following') : t('followLatest')}
          title={follow ? t('following') : t('followLatest')}
          onClick={toggleFollow}
        >
          {follow ? <IconPause size={13} /> : <IconPlay size={13} />}
        </button>
        {menuElement}
      </div>

      <div
        className="dshtp-body"
        id={tabPanelId}
        role="tabpanel"
        aria-labelledby={selectedTabId}
        data-dsh-tp-body
        onMouseEnter={() => {
          setHovered(true)
          pauseAutoClose(selectedSession, 'hover')
        }}
      >
        {bannerNodes}
        {view.mode === 'history'
          ? historyView
          : selected !== null
            ? terminalNode
            : phase === 'loading'
              ? loadingState
              : phase === 'error'
                ? errorState
                : emptyState}
        {toastElement}
      </div>

      <div
        className="dshtp-statusbar"
        data-visible={statusVisible ? 'true' : 'false'}
        data-dsh-tp-status
      >
        <span className="dshtp-dot" data-state={selected ? selected.state : 'exited'} />
        <span className="dshtp-status-item" data-dsh-tp-status-state>
          {selected ? stateLabel(selected, t) : t('noSelection')}
        </span>
        {selected?.pinned ? (
          <span className="dshtp-status-item">
            <IconPin size={11} /> {t('pinned')}
          </span>
        ) : null}
        {selected !== null && selected.autoClosePaused && !selected.pinned ? (
          <span className="dshtp-status-item" title={t('paused')}>
            <IconPause size={11} /> {t('paused')}
          </span>
        ) : null}
        {countdownSession !== null && countdownSeconds > 0 ? (
          <span className="dshtp-status-item" data-dsh-tp-countdown>
            {t('autoCloseIn', { seconds: String(countdownSeconds) })}
          </span>
        ) : null}
        {selected !== null && !isSandboxed(selected) ? (
          <span
            className="dshtp-sandbox-badge"
            data-mode={selected.sandbox.mode}
            data-required={selected.sandbox.required ? 'true' : 'false'}
            title={t('sandboxHint')}
          >
            <IconSandbox size={11} /> {t('sandboxBadge')}
          </span>
        ) : null}
        {readOnly ? (
          <span className="dshtp-readonly-badge" title={t('takeControlHint')}>
            {t('readonlyBadge')}
          </span>
        ) : null}
        <span className="dshtp-status-spacer" />
        {selected !== null ? (
          <>
            <span className="dshtp-status-item dshtp-status-optional">
              {t('sizeLabel')} {selected.cols}x{selected.rows}
            </span>
            <span className="dshtp-status-item dshtp-status-optional">
              {t('cwdLabel')} {selected.cwd}
            </span>
            <span
              className="dshtp-status-item"
              title={streamConnected ? t('connected') : t('disconnected')}
            >
              {t('sessionCountShort', { count: String(sessions.length) })}
            </span>
          </>
        ) : null}
        {readOnly ? (
          <button
            type="button"
            className="dshtp-action"
            data-variant="primary"
            onClick={() => void handleTakeControl()}
          >
            {t('takeControl')}
          </button>
        ) : null}
        {connection === 'disconnected' ? (
          <button type="button" className="dshtp-action" onClick={reconnect}>
            {t('reconnect')}
          </button>
        ) : null}
      </div>

      {dialogElement}
    </section>
  )
}
