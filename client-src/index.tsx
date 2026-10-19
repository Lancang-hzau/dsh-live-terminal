/**
 * dsh-terminal-panel — browser half (esbuild bundle entry).
 *
 * Registers:
 *  - the `zh`/`en` locale namespace,
 *  - the `terminal-panel` right-sidebar tab type + guide entry,
 *  - the panel body seat (`sidebar.right.pane.tab`),
 *  - a headless watcher in the root `shell.overlay` seat that auto-opens the
 *    panel when an agent command session starts (architecture.md §5.2).
 *
 * The file is bundled by tools/build-client.mjs into lib/client.js and wrapped
 * in the `window.__ModuleLoader__.load({ id, factory })` format expected by the
 * DSH client-modules bootstrap.
 */

import { useEffect } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import xtermCss from '@xterm/xterm/css/xterm.css'

import { listSessions, openSessionsStream } from './api'
import { en, zh } from './locale'
import { Panel } from './Panel'
import { styles } from './styles'
import type { SessionInfo } from './types'

export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

const NAMESPACE = 'dshTerminalPanel'
const PLUGIN_ID = 'dsh-live-terminal'
const TAB_KIND = 'terminal-panel'
const STYLE_ATTRIBUTE = 'data-plugin'

/** Per browser page: auto-open the panel at most once. */
let autoOpenConsumed = false

/* ------------------------------------------------------------------ */
/* Loose service surface (Cordis services are runtime objects, not    */
/* compile-time dependencies of this package).                        */
/* ------------------------------------------------------------------ */

type LooseFunction = (...args: never[]) => unknown

interface LocaleService {
  bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
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

interface SidebarRightService {
  openTab(kind: string, options?: Record<string, unknown>): void
  isExpanded?(): boolean
  active?(): OpenTabRecord | undefined
  openTabs?: { getSnapshot?(): OpenTabRecord[] }
}

interface ClientContext {
  effect(callback: () => (() => void) | void, label?: string): void
  locale: LocaleService
  slots: SlotsService
  sidebarRight?: SidebarRightService
  sidebarRightTabs: SidebarRightTabsService
}

/* ------------------------------------------------------------------ */
/* Headless auto-open watcher (root-scope `shell.overlay` seat)       */
/* ------------------------------------------------------------------ */

interface AutoOpenWatcherProps {
  autoOpen?: () => void
}

/**
 * Watch the global session feed for a *new* agent command session and ask the
 * host registration to reveal the panel. Renders nothing.
 *
 * The baseline is the session list at mount time, so historical sessions never
 * trigger the auto-open. The SSE subscription only starts once the host routes
 * are confirmed to exist (`GET /sessions` succeeded), which keeps the console
 * clean while the host half is still being developed.
 */
function AutoOpenWatcher(props: AutoOpenWatcherProps): null {
  const { autoOpen } = props
  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | undefined
    const known = new Set<string>()

    const inspect = (incoming: SessionInfo[]): void => {
      if (disposed || autoOpenConsumed) return
      let candidate: SessionInfo | undefined
      for (const session of incoming) {
        if (known.has(session.id)) continue
        known.add(session.id)
        if (
          candidate === undefined &&
          session.kind === 'command' &&
          session.owner === 'agent' &&
          session.state === 'running'
        ) {
          candidate = session
        }
      }
      if (candidate) autoOpen?.()
    }

    const start = async (): Promise<void> => {
      let baseline: SessionInfo[]
      try {
        baseline = await listSessions()
      } catch {
        // Host half missing: a page reload after the host restart re-runs this.
        return
      }
      if (disposed) return
      for (const session of baseline) known.add(session.id)
      unsubscribe = openSessionsStream({
        onSessions: (payload) => inspect(Array.isArray(payload) ? payload : [payload]),
      })
    }
    void start()

    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [autoOpen])
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

  // Root-scope headless watcher: auto-open the panel for new agent commands.
  const autoOpenPanel = (): void => {
    if (autoOpenConsumed) return
    const sidebar = ctx.sidebarRight
    if (!sidebar) return
    let expanded = false
    try {
      expanded = sidebar.isExpanded?.() === true
    } catch {
      expanded = false
    }
    let hasTab = false
    try {
      const records = sidebar.openTabs?.getSnapshot?.() ?? []
      hasTab = records.some((record) => record.kind === TAB_KIND)
    } catch {
      hasTab = false
    }
    if (hasTab && expanded) return
    try {
      sidebar.openTab(TAB_KIND, { revealIfOpened: true })
      autoOpenConsumed = true
      console.log('[dsh-live-terminal] auto-opened panel for a new agent command session')
    } catch (error) {
      // No on-screen conversation yet (hero/settings): wait for the next one.
      console.warn('[dsh-live-terminal] auto-open skipped', error)
    }
  }

  ctx.effect(() => {
    try {
      return ctx.slots.inject('shell.overlay', () => {
        if (globalRecord.__DSH_TERMINAL_PANEL_CLIENT__) {
          ;(globalRecord.__DSH_TERMINAL_PANEL_CLIENT__ as Record<string, unknown>).autoOpenWatcher = true
        }
        return ctx.slots.register(
          {
            name: 'shell.overlay',
            id: `${PLUGIN_ID}.auto-open`,
            order: 900,
            locale: NAMESPACE,
            inject: () => ({ autoOpen: autoOpenPanel }),
          },
          AutoOpenWatcher as unknown as LooseFunction,
        )
      })
    } catch (error) {
      console.warn('[dsh-live-terminal] auto-open watcher registration failed', error)
      return undefined
    }
  }, 'dsh-live-terminal: auto-open watcher')
}
