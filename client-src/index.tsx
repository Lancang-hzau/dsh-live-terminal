/**
 * dsh-live-terminal — browser half (esbuild bundle entry) — 1.2.2.
 *
 * Registers:
 *  - the `zh`/`en` locale namespace,
 *  - the `terminal-panel` right-sidebar tab type + guide entry,
 *  - the panel body seat (`sidebar.right.pane.tab`),
 *  - the `dsh-live-terminal.*` shortcut commands,
 *  - a root `shell.overlay` watcher that renders global failure toasts,
 *    auto-opens the panel per DSH conversation (with retries) and shows the
 *    one-time welcome.
 *
 * The file is bundled by tools/build-client.mjs into lib/client.js and wrapped
 * in the `window.__ModuleLoader__.load({ id, factory })` format expected by the
 * DSH client-modules bootstrap.
 */

import { useEffect, useRef, useState } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import xtermCss from '@xterm/xterm/css/xterm.css'

import { listSessions, openSessionsStream } from './api'
import { en, zh } from './locale'
import { Panel } from './Panel'
import { styles } from './styles'
import type { Notice, SessionInfo } from './types'

export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

const NAMESPACE = 'dshTerminalPanel'
const PLUGIN_ID = 'dsh-live-terminal'
const TAB_KIND = 'terminal-panel'
const STYLE_ATTRIBUTE = 'data-plugin'
const COMMAND_EVENT = 'dsh-live-terminal:command'
const WELCOME_STORAGE_KEY = 'dsh-live-terminal.welcome.v1'
const TOAST_TIMEOUT_MS = 8000
/** Retry delays for auto-open when the sidebar has no on-screen conversation yet. */
const OPEN_RETRY_DELAYS = [500, 1500, 3000]
/** Retry delays for the initial session baseline (host half may still boot). */
const BASELINE_RETRY_DELAYS = [500, 1500, 3000]

type Translator = (key: string, params?: Record<string, unknown>) => string

/* ------------------------------------------------------------------ */
/* Loose service surface (Cordis services are runtime objects, not    */
/* compile-time dependencies of this package).                        */
/* ------------------------------------------------------------------ */
type LooseFunction = (...args: never[]) => unknown

interface LocaleService {
  bind(namespace: string): Translator
  register(namespace: string, messages: Record<string, unknown>): () => void
}

interface SlotsService {
  inject(name: string, callback: () => (() => void) | undefined): () => void
  register(options: Record<string, unknown>, component: LooseFunction): () => void
}

interface SidebarRightTabsService {
  register(definition: Record<string, unknown>): () => void
}

interface OpenTabRecord {
  id?: string
  kind?: string
}

interface OpenTabsStore {
  getSnapshot?(): OpenTabRecord[]
  subscribe?(listener: () => void): () => void
}

interface SidebarRightService {
  openTab(kind: string, options?: Record<string, unknown>): void
  isExpanded?(): boolean
  active?(): OpenTabRecord | undefined
  openTabs?: OpenTabsStore
}

interface ClientContext {
  effect(callback: () => (() => void) | void, label?: string): void
  locale: LocaleService
  slots: SlotsService
  sidebarRight?: SidebarRightService
  sidebarRightTabs: SidebarRightTabsService
}

/* ------------------------------------------------------------------ */
/* Shared command bridge / panel presence                              */
/* ------------------------------------------------------------------ */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function isPanelMounted(): boolean {
  const record = globalThis as Record<string, unknown>
  const panels = record.__DSH_TP_PANELS__
  return panels instanceof Set && panels.size > 0
}

function dispatchCommand(command: string): void {
  try {
    window.dispatchEvent(new CustomEvent(COMMAND_EVENT, { detail: { command } }))
  } catch (error) {
    console.warn('[dsh-live-terminal] command dispatch failed', error)
  }
}

/* ------------------------------------------------------------------ */
/* Locale / welcome helpers                                            */
/* ------------------------------------------------------------------ */

function welcomeSeen(): boolean {
  try {
    return globalThis.localStorage?.getItem(WELCOME_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function markWelcomeSeen(): void {
  try {
    globalThis.localStorage?.setItem(WELCOME_STORAGE_KEY, '1')
  } catch {
    // ignore
  }
}

/* ------------------------------------------------------------------ */
/* Global notice watcher (shell.overlay)                               */
/* ------------------------------------------------------------------ */

interface GlobalToastAction {
  label: string
  command: string
}

interface GlobalToast {
  id: number
  title: string
  body?: string
  actions: GlobalToastAction[]
}

interface GlobalNoticeProps {
  t?: Translator
  openPanel?: () => boolean
  sendCommand?: (command: string) => void
  openTabs?: OpenTabsStore
}

/**
 * Headless watcher rendered in the root `shell.overlay` seat.
 *
 *  - Consumes the global SSE feed for *failure* notices even when no panel is
 *    mounted (the panel handles its own toasts while it is open).
 *  - Auto-opens the panel once per DSH conversation when an agent command
 *    starts, retrying a few times until the sidebar has an on-screen
 *    conversation; a manual close is remembered for this page.
 *  - Shows the one-time welcome (unsandboxed disclosure + how to open).
 */
function GlobalNotice(props: GlobalNoticeProps): JSX.Element {
  const t = props.t ?? ((key: string) => key)
  const openPanel = props.openPanel
  const sendCommand = props.sendCommand
  // The slot may hand a new translator identity each render; effects read the
  // latest one through this ref so they do not resubscribe the SSE feed.
  const tRef = useRef(t)
  tRef.current = t

  const [toasts, setToasts] = useState<GlobalToast[]>([])
  const [welcome, setWelcome] = useState<boolean>(() => !welcomeSeen())
  const toastIdRef = useRef(0)
  const knownIdsRef = useRef<Set<string>>(new Set())
  const baselineReadyRef = useRef(false)
  const autoOpenedRef = useRef<Set<string>>(new Set())
  const manualClosedRef = useRef<Set<string>>(new Set())
  const lastAutoKeyRef = useRef<string | null>(null)

  const pushToast = (toast: Omit<GlobalToast, 'id'>): void => {
    const id = (toastIdRef.current += 1)
    setToasts((previous) => [...previous.filter((item) => item.id !== id).slice(-2), { ...toast, id }])
    window.setTimeout(() => {
      setToasts((previous) => previous.filter((item) => item.id !== id))
    }, TOAST_TIMEOUT_MS)
  }

  /* --- auto-open + failure notifications ---------------------------- */
  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | undefined

    const attemptOpen = (key: string, attempt: number): void => {
      if (disposed) return
      if (autoOpenedRef.current.has(key) || manualClosedRef.current.has(key)) return
      let opened = false
      try {
        opened = openPanel?.() === true
      } catch (error) {
        console.warn('[dsh-live-terminal] auto-open skipped', error)
      }
      if (opened) {
        autoOpenedRef.current.add(key)
        lastAutoKeyRef.current = key
        console.log('[dsh-live-terminal] auto-opened panel for a new agent command session', key)
        return
      }
      const delay = OPEN_RETRY_DELAYS[attempt]
      if (delay === undefined) return
      window.setTimeout(() => attemptOpen(key, attempt + 1), delay)
    }

    const inspect = (payload: SessionInfo[] | SessionInfo): void => {
      if (disposed) return
      const incoming = Array.isArray(payload) ? payload : [payload]
      if (!baselineReadyRef.current) {
        for (const session of incoming) knownIdsRef.current.add(session.id)
        baselineReadyRef.current = true
        return
      }
      const known = knownIdsRef.current
      for (const session of incoming) {
        if (known.has(session.id)) continue
        known.add(session.id)
        if (session.kind !== 'command' || session.owner !== 'agent' || session.state !== 'running') {
          continue
        }
        const key = session.sessionId ?? '__page__'
        attemptOpen(key, 0)
      }
    }

    const start = async (): Promise<void> => {
      // Seed the baseline so historical sessions never trigger the auto-open.
      for (let attempt = 0; ; attempt += 1) {
        try {
          const baseline = await listSessions()
          if (disposed) return
          for (const session of baseline) knownIdsRef.current.add(session.id)
          baselineReadyRef.current = true
          break
        } catch {
          const delay = BASELINE_RETRY_DELAYS[attempt]
          if (delay === undefined) break
          await sleep(delay)
          if (disposed) return
        }
      }
      if (disposed) return
      unsubscribe = openSessionsStream({
        onSessions: inspect,
        onNotice: (notice) => {
          if (disposed) return
          // While the panel is mounted it renders its own actionable toast.
          if (isPanelMounted()) return
          const failure = describeFailure(tRef.current, notice)
          if (failure !== null) pushToast(failure)
        },
      })
    }
    void start()

    return () => {
      disposed = true
      unsubscribe?.()
    }
    // `openPanel` is stable for the lifetime of this component.
  }, [openPanel])

  /* --- remember a manual close so it is not re-opened ---------------- */
  useEffect(() => {
    const openTabs = props.openTabs
    if (openTabs === undefined) return
    if (typeof openTabs.getSnapshot !== 'function') return
    let hadTab = false
    const sync = (): void => {
      let hasTab = false
      try {
        const records = openTabs.getSnapshot?.() ?? []
        hasTab = records.some((record) => record.kind === TAB_KIND)
      } catch {
        hasTab = false
      }
      if (hadTab && !hasTab && lastAutoKeyRef.current !== null) {
        manualClosedRef.current.add(lastAutoKeyRef.current)
      }
      hadTab = hasTab
    }
    sync()
    const unsubscribe = openTabs.subscribe?.(sync)
    return () => {
      unsubscribe?.()
    }
  }, [props.openTabs])

  /* --- welcome -------------------------------------------------------- */
  useEffect(() => {
    if (!welcome) return
    const timer = window.setTimeout(() => {
      // Never nag forever: hide after a while without marking it as seen.
      setWelcome(false)
    }, TOAST_TIMEOUT_MS * 3)
    return () => window.clearTimeout(timer)
  }, [welcome])

  const dismissWelcome = (): void => {
    markWelcomeSeen()
    setWelcome(false)
  }

  return (
    <div className="dshtp-global-toast-stack">
      {welcome ? (
        <div className="dshtp-global-toast" role="status" aria-live="polite">
          <div className="dshtp-global-toast-title">{t('welcomeTitle')}</div>
          <div className="dshtp-global-toast-body">{t('welcomeBody')}</div>
          <div className="dshtp-global-toast-actions">
            <button
              type="button"
              className="dshtp-action"
              data-variant="primary"
              onClick={() => {
                dismissWelcome()
                openPanel?.()
                sendCommand?.('open')
              }}
            >
              {t('welcomeOpen')}
            </button>
            <button type="button" className="dshtp-action" onClick={dismissWelcome}>
              {t('welcomeDontShow')}
            </button>
          </div>
          <button
            type="button"
            className="dshtp-global-toast-close"
            aria-label={t('dismiss')}
            title={t('dismiss')}
            onClick={() => setWelcome(false)}
          >
            {'\u00d7'}
          </button>
        </div>
      ) : null}
      {toasts.map((toast) => (
        <div className="dshtp-global-toast" role="alert" key={toast.id}>
          <div className="dshtp-global-toast-title">{toast.title}</div>
          {toast.body !== undefined ? (
            <div className="dshtp-global-toast-body">{toast.body}</div>
          ) : null}
          {toast.actions.length > 0 ? (
            <div className="dshtp-global-toast-actions">
              {toast.actions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  className="dshtp-action"
                  onClick={() => {
                    setToasts((previous) => previous.filter((item) => item.id !== toast.id))
                    sendCommand?.(action.command)
                  }}
                >
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}
          <button
            type="button"
            className="dshtp-global-toast-close"
            aria-label={t('dismiss')}
            title={t('dismiss')}
            onClick={() =>
              setToasts((previous) => previous.filter((item) => item.id !== toast.id))
            }
          >
            {'\u00d7'}
          </button>
        </div>
      ))}
    </div>
  )
}

/** Map a failure notice to a global toast; null for non-failures. */
function describeFailure(
  t: Translator,
  notice: Notice,
): Omit<GlobalToast, 'id'> | null {
  if (notice.type === 'auto-close') {
    if (notice.reason !== 'failed') return null
    const code = notice.exitCode ?? notice.signal ?? '\u2014'
    const excerpt = (notice.excerpt ?? '').trim()
    return {
      title: t('failedCommand', { code: String(code) }),
      body: excerpt === '' ? notice.title : `${notice.title} \u2014 ${excerpt.slice(0, 120)}`,
      actions: [
        { label: t('viewHistory'), command: 'history' },
        { label: t('viewTerminal'), command: 'open' },
      ],
    }
  }
  if (notice.type === 'command-finished') {
    if (notice.exitCode === null || notice.exitCode === 0) return null
    return {
      title: t('failedCommand', { code: String(notice.exitCode) }),
      body: notice.title,
      actions: [
        { label: t('viewHistory'), command: 'history' },
        { label: t('viewTerminal'), command: 'open' },
      ],
    }
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Style injection                                                     */
/* ------------------------------------------------------------------ */

function injectStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[${STYLE_ATTRIBUTE}="${PLUGIN_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.setAttribute(STYLE_ATTRIBUTE, PLUGIN_ID)
  tag.textContent = xtermCss + '\n' + styles
  document.head.appendChild(tag)
}

/* ------------------------------------------------------------------ */
/* Plugin entry                                                        */
/* ------------------------------------------------------------------ */

const artworkIcon = (primitives as Record<string, unknown>).PluginArtworkTerminal as
  | ((props: { size?: number }) => unknown)
  | undefined

export function apply(ctx: ClientContext): void {
  injectStyles()

  const globalRecord = globalThis as Record<string, unknown>
  globalRecord.__DSH_TERMINAL_PANEL__ = true
  globalRecord.__DSH_TERMINAL_PANEL_CLIENT__ = {
    plugin: PLUGIN_ID,
    version: __PLUGIN_VERSION__,
    apiPrefix: '/dsh-terminal-panel',
    tabKind: TAB_KIND,
  }
  console.log('[dsh-live-terminal] client half loaded')

  const t = ctx.locale.bind(NAMESPACE)

  /** Reveal the panel tab; returns false when the sidebar refuses (no scene). */
  const openPanel = (): boolean => {
    const sidebar = ctx.sidebarRight
    if (sidebar === undefined) return false
    try {
      const expanded = sidebar.isExpanded?.() === true
      const records = sidebar.openTabs?.getSnapshot?.() ?? []
      const hasTab = records.some((record) => record.kind === TAB_KIND)
      if (!(hasTab && expanded)) sidebar.openTab(TAB_KIND, { revealIfOpened: true })
      return true
    } catch (error) {
      console.warn('[dsh-live-terminal] openTab failed', error)
      return false
    }
  }

  /**
   * Deliver one keyboard command to the mounted panel. When no panel is
   * mounted yet, open the sidebar tab first and retry dispatching briefly.
   */
  const sendCommand = (command: string): void => {
    if (isPanelMounted()) {
      dispatchCommand(command)
      return
    }
    if (!openPanel()) return
    let attempt = 0
    const tryDispatch = (): void => {
      if (isPanelMounted()) {
        dispatchCommand(command)
        return
      }
      attempt += 1
      if (attempt <= 4) window.setTimeout(tryDispatch, 150 * attempt)
    }
    window.setTimeout(tryDispatch, 150)
  }

  ctx.effect(
    () => ctx.locale.register(NAMESPACE, { zh, en }),
    'dsh-live-terminal: locale',
  )

  ctx.effect(
    () =>
      ctx.sidebarRightTabs.register({
        id: PLUGIN_ID,
        kind: TAB_KIND,
        multiple: true,
        priority: 'extension',
        title: () => t('title'),
        guide: [
          {
            id: 'open',
            order: 30,
            title: () => t('title'),
            description: () => t('guideDescription'),
            icon: artworkIcon,
          },
        ],
      }),
    'dsh-live-terminal: tab type',
  )

  // The panel body seat. `inject` returns the props the component receives.
  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: PLUGIN_ID,
            locale: NAMESPACE,
            inject: (sessionId: string) => ({ sessionId }),
          },
          Panel as unknown as LooseFunction,
        ),
      ),
    'dsh-live-terminal: body',
  )

  // Keyboard commands. The DSH shortcuts service rejects several useful Web
  // chords as unsupported/reserved (and a global service binding can make the
  // whole client boot fail), so the panel owns a small, predictable local
  // keymap instead. It is active only while a DSH page is focused.
  ctx.effect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const primary = event.ctrlKey || event.metaKey
      if (!primary) return
      const key = event.key.toLowerCase()
      if (key === '`' && event.shiftKey && !event.altKey) {
        event.preventDefault()
        sendCommand('open')
        return
      }
      if (event.altKey && !event.shiftKey && key === 't') {
        event.preventDefault()
        sendCommand('new')
        return
      }
      if (event.altKey && event.shiftKey && key === 'w') {
        event.preventDefault()
        sendCommand('close')
        return
      }
      if (event.altKey && !event.shiftKey && key === 'f') {
        event.preventDefault()
        sendCommand('follow')
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, 'dsh-live-terminal: local keymap')

  // Root-scope headless watcher: auto-open + global failure toasts + welcome.
  ctx.effect(() => {
    try {
      return ctx.slots.inject('shell.overlay', () => {
        const client = globalRecord.__DSH_TERMINAL_PANEL_CLIENT__
        if (client !== null && typeof client === 'object') {
          ;(client as Record<string, unknown>).autoOpenWatcher = true
        }
        return ctx.slots.register(
          {
            name: 'shell.overlay',
            id: `${PLUGIN_ID}.global-notice`,
            order: 900,
            locale: NAMESPACE,
            inject: () => ({ openPanel, sendCommand, openTabs: ctx.sidebarRight?.openTabs }),
          },
          GlobalNotice as unknown as LooseFunction,
        )
      })
    } catch (error) {
      console.warn('[dsh-live-terminal] global watcher registration failed', error)
      return undefined
    }
  }, 'dsh-live-terminal: global watcher')
}
