/**
 * Full terminal panel body: session list chips + xterm screen + toolbar.
 *
 * The panel is mounted once per right-sidebar tab occurrence. It owns:
 *  - the session list (REST seed + global SSE updates, polling fallback),
 *  - the selected session and its session-scoped SSE stream,
 *  - toolbar actions (new / refresh / reconnect / screenshot / close).
 *
 * The host half may still be missing while this bundle is developed, so every
 * request failure turns into a retryable error state instead of a crash.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

import {
  API_PREFIX,
  ApiError,
  closeSession,
  createSession,
  listSessions,
  openSessionsStream,
} from './api'
import { IconCamera, IconClose, IconPlus, IconReconnect, IconRefresh, IconTerminal, IconWarning } from './icons'
import { TerminalView, type TerminalController } from './TerminalView'
import { isFullSessionInfo, stripUndefined, type SessionInfo, type SessionInfoPatch } from './types'

export interface PanelProps {
  /** Locale-bound translator provided by the slot runtime. */
  t?: (key: string, params?: Record<string, unknown>) => string
  /** Conversation session id injected by the slot runtime (informational). */
  sessionId?: string
  /** Slot hook supplied by the sidebar; kept for parity with official bodies. */
  useTabInfo?: () => { tab?: { id?: string } } | undefined
}

type ListPhase = 'loading' | 'ready' | 'error'
type ConnectionState = 'connecting' | 'connected' | 'disconnected'

interface ListError {
  message: string
  missingService: boolean
}

const DEFAULT_SIZE = { cols: 100, rows: 30 }
const SESSION_POLL_MS = 5000
const TOAST_MS = 1800

function fallbackTranslate(key: string): string {
  return key
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function describeListError(error: unknown): ListError {
  if (error instanceof ApiError) {
    return { message: error.message, missingService: error.status === 404 }
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
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function sessionTitle(
  session: SessionInfo,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  const title = session.title.trim()
  if (title !== '' && title !== session.id) return title
  if (session.kind === 'command' && session.command) return truncateLine(session.command, 80)
  return t(session.kind === 'command' ? 'commandSession' : 'interactiveSession')
}

function stateLabel(
  session: SessionInfo,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  if (session.state === 'running') return t('running')
  if (session.state === 'failed') {
    return session.error ? `${t('failed')}: ${session.error}` : t('failed')
  }
  return session.exitCode === null
    ? t('exited')
    : t('exitedWithCode', { code: String(session.exitCode) })
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

export function Panel(props: PanelProps) {
  const t = props.t ?? fallbackTranslate
  // Conversation session identity from the slot inject (`inject: (sessionId) =>
  // ({ sessionId })`). Every create path forwards it so the host can resolve the
  // session's working directory (P2-1).
  const conversationSessionId =
    typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : undefined

  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [phase, setPhase] = useState<ListPhase>('loading')
  const [listError, setListError] = useState<ListError | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [streamConnected, setStreamConnected] = useState(false)
  const [reconnectToken, setReconnectToken] = useState(0)
  const [termError, setTermError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [streamEnabled, setStreamEnabled] = useState(false)

  const selectedIdRef = useRef<string | null>(null)
  selectedIdRef.current = selectedId
  const sessionsRef = useRef<SessionInfo[]>([])
  sessionsRef.current = sessions
  const phaseRef = useRef<ListPhase>(phase)
  phaseRef.current = phase
  const connectionRef = useRef<ConnectionState>(connection)
  connectionRef.current = connection

  const knownIdsRef = useRef<Set<string>>(new Set())
  const pinnedRef = useRef(false)
  const controllerRef = useRef<TerminalController | null>(null)
  const lastSizeRef = useRef({ ...DEFAULT_SIZE })
  const creatingRef = useRef(false)
  const conversationSessionIdRef = useRef<string | undefined>(undefined)
  conversationSessionIdRef.current = conversationSessionId

  // a11y: one panel body id per Panel occurrence, tabs point at it via
  // aria-controls / aria-labelledby (multiple panel tabs may coexist).
  const tabPanelId = useId()
  const tabRefs = useRef(new Map<string, HTMLDivElement>())
  const tabIdFor = (id: string): string => `${tabPanelId}-tab-${id}`

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
    })
    return () => {
      disposed = true
      unsubscribe()
      if (pollTimer !== undefined) window.clearInterval(pollTimer)
    }
  }, [streamEnabled, applySessions, loadSessions])

  /* ---------------------------------------------------------------- */
  /* Selection                                                         */
  /* ---------------------------------------------------------------- */
  // Follow newly created sessions (agent commands included) unless the user
  // explicitly pinned one by clicking a chip.
  useEffect(() => {
    const known = knownIdsRef.current
    const fresh = sessions.filter((session) => !known.has(session.id))
    for (const session of sessions) known.add(session.id)
    if (fresh.length === 0 || pinnedRef.current) return
    const target = pickPreferred(fresh)
    if (target) setSelectedId(target.id)
  }, [sessions])

  // Keep a valid selection whenever the list changes (close / prune / restart).
  useEffect(() => {
    if (sessions.length === 0) {
      if (selectedId !== null) setSelectedId(null)
      return
    }
    if (selectedId !== null && sessions.some((session) => session.id === selectedId)) return
    const target = pickPreferred(sessions)
    setSelectedId(target ? target.id : null)
  }, [sessions, selectedId])

  useEffect(() => {
    setConnection('connecting')
    setTermError(null)
  }, [selectedId])

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
    if (controller) lastSizeRef.current = controller.getDimensions()
  }, [])

  const handleSessionError = useCallback((message: string | null): void => {
    setTermError(message)
  }, [])

  /**
   * Pin the selection once the user actually uses the screen (typing or
   * pointerdown), so a new agent command session cannot switch away from the
   * terminal the user is working in.
   */
  const pinSelection = useCallback((): void => {
    pinnedRef.current = true
  }, [])

  const handleInputError = useCallback(
    (message: string): void => {
      setToast(`${t('inputFailed')}: ${message}`)
    },
    [t],
  )

  /* ---------------------------------------------------------------- */
  /* Toolbar actions                                                   */
  /* ---------------------------------------------------------------- */
  /**
   * Single creation path for every entry point (toolbar button, empty-state
   * button, and any reconnect fallback). The current conversation session id is
   * always attached so the host can resolve `cwd` from the session workspace.
   */
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
      pinnedRef.current = true
      setPhase('ready')
      setListError(null)
      setSessions((previous) =>
        previous.some((session) => session.id === info.id) ? previous : [...previous, info],
      )
      setSelectedId(info.id)
      window.setTimeout(() => {
        controllerRef.current?.fit()
        controllerRef.current?.focus()
      }, 120)
    } catch (error) {
      setToast(`${t('createFailed')}: ${errorMessage(error)}`)
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }, [t])

  const closeTerminal = useCallback(
    async (id?: string): Promise<void> => {
      const target = id ?? selectedIdRef.current
      if (!target) return
      setSessions((previous) => previous.filter((session) => session.id !== target))
      if (selectedIdRef.current === target) {
        setSelectedId(null)
        pinnedRef.current = false
      }
      try {
        await closeSession(target)
      } catch (error) {
        setToast(`${t('closeFailed')}: ${errorMessage(error)}`)
      }
    },
    [t],
  )

  const reconnect = useCallback((): void => {
    setTermError(null)
    setConnection('connecting')
    setReconnectToken((value) => value + 1)
    void loadSessions({ silent: true })
  }, [loadSessions])

  const refresh = useCallback((): void => {
    void loadSessions()
  }, [loadSessions])

  const copyScreen = useCallback(async (): Promise<void> => {
    const text = controllerRef.current?.getVisibleText() ?? ''
    if (text.trim() === '') {
      setToast(t('copyFailed'))
      return
    }
    const copied = await writeClipboard(text)
    setToast(copied ? t('copied') : t('copyFailed'))
  }, [t])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), TOAST_MS)
    return () => window.clearTimeout(timer)
  }, [toast])

  /* ---------------------------------------------------------------- */
  /* Debug handle for e2e tests (harmless in production)               */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    const globalRecord = globalThis as Record<string, unknown>
    globalRecord.__DSH_TERMINAL_PANEL_DEBUG__ = {
      apiPrefix: API_PREFIX,
      getPhase: () => phaseRef.current,
      getConnection: () => connectionRef.current,
      getSelectedId: () => selectedIdRef.current,
      getSessions: () => sessionsRef.current,
      getVisibleText: () => controllerRef.current?.getVisibleText() ?? '',
      getConversationSessionId: () => conversationSessionIdRef.current ?? null,
    }
    return () => {
      delete globalRecord.__DSH_TERMINAL_PANEL_DEBUG__
    }
  }, [])

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */
  const selected = sessions.find((session) => session.id === selectedId) ?? null
  const orderedSessions = sortByRecency(sessions)
  const connectionLabel =
    connection === 'connected'
      ? t('connected')
      : connection === 'disconnected'
        ? t('disconnected')
        : t('connecting')
  const failure = listError
  const failureDetail = failure
    ? failure.missingService
      ? t('hostNotReady')
      : t('listErrorHint')
    : null

  /** WAI-ARIA tabs keyboard model: roving selection with Arrow/Home/End. */
  const handleTabListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (orderedSessions.length === 0) return
    const ids = orderedSessions.map((session) => session.id)
    const currentIndex = selectedId === null ? -1 : ids.indexOf(selectedId)
    let nextIndex: number | undefined
    if (event.key === 'ArrowRight') {
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % ids.length
    } else if (event.key === 'ArrowLeft') {
      nextIndex = currentIndex <= 0 ? ids.length - 1 : currentIndex - 1
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = ids.length - 1
    }
    if (nextIndex === undefined) return
    const nextId = ids[nextIndex]
    if (nextId === undefined) return
    event.preventDefault()
    pinSelection()
    setSelectedId(nextId)
    tabRefs.current.get(nextId)?.focus()
  }

  return (
    <section
      className="dshtp-root"
      data-dsh-terminal-panel="body"
      data-dsh-tp-phase={phase}
      data-dsh-tp-selected={selectedId ?? ''}
    >
      <div className="dshtp-toolbar" data-dsh-tp-toolbar>
        <button
          type="button"
          className="dshtp-btn dshtp-btn-primary"
          data-dsh-tp-action="create"
          disabled={creating}
          title={t('newTerminal')}
          onClick={() => void createTerminal()}
        >
          <IconPlus />
          <span>{creating ? t('creating') : t('newTerminal')}</span>
        </button>
        <span className="dshtp-title">{t('title')}</span>
        <span className="dshtp-spacer" />
        <button
          type="button"
          className="dshtp-btn"
          data-dsh-tp-action="refresh"
          disabled={phase === 'loading'}
          aria-label={t('refresh')}
          title={t('refresh')}
          onClick={refresh}
        >
          <IconRefresh />
        </button>
        <button
          type="button"
          className="dshtp-btn"
          data-dsh-tp-action="reconnect"
          disabled={!selected}
          aria-label={t('reconnect')}
          title={t('reconnect')}
          onClick={reconnect}
        >
          <IconReconnect />
        </button>
        <button
          type="button"
          className="dshtp-btn"
          data-dsh-tp-action="copy"
          disabled={!selected}
          aria-label={t('copyScreen')}
          title={t('copyScreen')}
          onClick={() => void copyScreen()}
        >
          <IconCamera />
        </button>
        <button
          type="button"
          className="dshtp-btn dshtp-btn-danger"
          data-dsh-tp-action="close"
          disabled={!selected}
          aria-label={t('close')}
          title={t('close')}
          onClick={() => void closeTerminal()}
        >
          <IconClose />
        </button>
      </div>

      {sessions.length > 0 ? (
        <div
          className="dshtp-tabs"
          role="tablist"
          aria-label={t('title')}
          data-dsh-tp-sessions
          onKeyDown={handleTabListKeyDown}
        >
          {orderedSessions.map((session) => {
            const active = session.id === selectedId
            return (
              <div
                key={session.id}
                ref={(element) => {
                  if (element) tabRefs.current.set(session.id, element)
                  else tabRefs.current.delete(session.id)
                }}
                className="dshtp-tab"
                role="tab"
                id={tabIdFor(session.id)}
                aria-controls={tabPanelId}
                tabIndex={active ? 0 : -1}
                aria-selected={active}
                data-active={active ? 'true' : 'false'}
                data-dsh-tp-session-id={session.id}
                data-dsh-tp-session-state={session.state}
                title={sessionTitle(session, t)}
                onClick={() => {
                  pinSelection()
                  setSelectedId(session.id)
                }}
                onKeyDown={(event) => {
                  // Only the tab itself takes Enter/Space; the nested close
                  // button must keep its native keyboard activation.
                  if (event.target !== event.currentTarget) return
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  pinSelection()
                  setSelectedId(session.id)
                }}
              >
                <span className="dshtp-dot" data-state={session.state} />
                <span className="dshtp-tab-title">{sessionTitle(session, t)}</span>
                {session.state === 'exited' ? (
                  <span className="dshtp-tab-meta">
                    {session.exitCode === null ? '—' : String(session.exitCode)}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="dshtp-tab-close"
                  tabIndex={active ? 0 : -1}
                  aria-label={t('closeSession')}
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
          })}
        </div>
      ) : null}

      <div
        className="dshtp-body"
        id={tabPanelId}
        role="tabpanel"
        aria-labelledby={selected ? tabIdFor(selected.id) : undefined}
        data-dsh-tp-body
      >
        {selected ? (
          <TerminalView
            key={selected.id}
            sessionId={selected.id}
            reconnectToken={reconnectToken}
            onConnectionChange={handleConnectionChange}
            onInfo={updateInfo}
            onError={handleSessionError}
            onInputError={handleInputError}
            onUserActivity={pinSelection}
            onController={handleController}
          />
        ) : phase === 'loading' ? (
          <div className="dshtp-state" data-dsh-tp-state="loading">
            <p className="dshtp-state-title">{t('loading')}</p>
          </div>
        ) : phase === 'error' ? (
          <div className="dshtp-state dshtp-state-error" data-dsh-tp-state="error">
            <IconWarning size={26} />
            <p className="dshtp-state-title">{t('listError')}</p>
            {failureDetail ? <p className="dshtp-state-detail">{failureDetail}</p> : null}
            {failure ? <p className="dshtp-state-detail">{failure.message}</p> : null}
            <button
              type="button"
              className="dshtp-btn dshtp-btn-primary"
              data-dsh-tp-action="retry"
              onClick={retryList}
            >
              {t('retry')}
            </button>
          </div>
        ) : (
          <div className="dshtp-state" data-dsh-tp-state="empty">
            <IconTerminal size={28} />
            <p className="dshtp-state-title">{t('empty')}</p>
            <p className="dshtp-state-detail">{t('emptyHint')}</p>
            <button
              type="button"
              className="dshtp-btn dshtp-btn-primary"
              data-dsh-tp-action="create-empty"
              onClick={() => void createTerminal()}
            >
              <IconPlus />
              <span>{t('newTerminal')}</span>
            </button>
          </div>
        )}

        {selected && connection === 'disconnected' ? (
          <div
            className="dshtp-overlay"
            role="alert"
            aria-live="assertive"
            data-dsh-tp-state="disconnected"
          >
            <p className="dshtp-state-title">{t('disconnected')}</p>
            <button
              type="button"
              className="dshtp-btn dshtp-btn-primary"
              data-dsh-tp-action="reconnect-overlay"
              onClick={reconnect}
            >
              {t('reconnect')}
            </button>
          </div>
        ) : null}

        {selected && termError ? (
          <div
            className="dshtp-overlay"
            role="alert"
            aria-live="assertive"
            data-dsh-tp-state="session-error"
          >
            <p className="dshtp-state-title">{termError}</p>
            <button type="button" className="dshtp-btn dshtp-btn-primary" onClick={reconnect}>
              {t('reconnect')}
            </button>
          </div>
        ) : null}

        {toast ? (
          <div className="dshtp-toast" role="status" data-dsh-tp-toast>
            {toast}
          </div>
        ) : null}
      </div>

      <div className="dshtp-statusbar" data-dsh-tp-status>
        <span
          className="dshtp-dot"
          data-state={selected ? selected.state : 'exited'}
        />
        <span className="dshtp-status-item" data-dsh-tp-status-state>
          {selected ? stateLabel(selected, t) : t('noTerminal')}
        </span>
        <span className="dshtp-spacer" />
        {selected ? (
          <span className="dshtp-status-item" data-dsh-tp-status-size>
            {selected.cols}x{selected.rows}
          </span>
        ) : null}
        <span className="dshtp-status-item" data-dsh-tp-status-connection>
          {selected ? connectionLabel : t('sessionCount', { count: String(sessions.length) })}
        </span>
        <span
          className="dshtp-dot"
          data-state={streamConnected ? 'running' : 'disconnected'}
          title={streamConnected ? t('connected') : t('disconnected')}
        />
      </div>
    </section>
  )
}
