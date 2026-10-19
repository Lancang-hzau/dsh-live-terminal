#!/usr/bin/env node
/**
 * End-to-end UI verification for the dsh-terminal-panel plugin (browser half).
 *
 * Usage:
 *   node tools/verify-ui.mjs "<url-with-token>"            # real dev host
 *   node tools/verify-ui.mjs "<url-with-token>" --mock     # mocked host API
 *
 * Real mode asserts what must work even before the host half lands (bundle
 * loads, guide entry, panel body, graceful host-not-ready state) and, when
 * `GET /dsh-terminal-panel/sessions` returns 200, runs the full flow:
 * new terminal → type a command → output → resize → screenshot → reconnect →
 * close.
 *
 * Mock mode additionally injects a fake backend (`/dsh-terminal-panel/*` fetch
 * + EventSource) so the whole UI can be exercised while the host half is still
 * being implemented. It also verifies the auto-open watcher: a new
 * agent/command/running session must open the panel without user interaction.
 *
 * Artifacts: tools/artifacts/e2e-*.png (plus dev-host logs when used).
 */

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
const artifacts = join(here, 'artifacts')
mkdirSync(artifacts, { recursive: true })

const argv = process.argv.slice(2)
const forceError = argv.includes('--mock-error')
const mockMode = argv.includes('--mock') || forceError
const url = argv.find((arg) => !arg.startsWith('--'))
if (!url) {
  console.error('usage: node tools/verify-ui.mjs <url-with-token> [--mock | --mock-error]')
  process.exit(2)
}
/** Page URL with the `mock-error` marker understood by the mock backend. */
const pageUrl = url

const BROWSER_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]
const browserPath = process.env.DSH_TEST_BROWSER ?? BROWSER_CANDIDATES.find((p) => existsSync(p))

/* ------------------------------------------------------------------ */
/* Result bookkeeping                                                  */
/* ------------------------------------------------------------------ */

const results = []
function record(name, ok, detail, options = {}) {
  const entry = { name, ok: Boolean(ok), detail: detail ?? '', optional: options.optional === true, skipped: options.skipped === true }
  results.push(entry)
  const icon = entry.skipped ? 'SKIP' : entry.ok ? 'PASS' : entry.optional ? 'WARN' : 'FAIL'
  console.log(`[${icon}] ${name}${entry.detail ? ` — ${entry.detail}` : ''}`)
  return entry.ok
}

function skip(name, detail) {
  return record(name, true, detail, { skipped: true })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 8000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return true
    } catch {
      // Keep polling until the deadline.
    }
    await sleep(intervalMs)
  }
  return false
}

/* ------------------------------------------------------------------ */
/* Mock host backend (injected before the app boots)                   */
/* ------------------------------------------------------------------ */

const MOCK_SCRIPT = String.raw`
(() => {
  const PREFIX = '/dsh-terminal-panel'
  // Replaced by the runner: --mock-error forces every panel route to fail so
  // the error/retry UI can be verified deterministically.
  const FORCE_ERROR = __MOCK_FORCE_ERROR__
  let seq = 0
  const state = {
    sessions: [],
    streams: [],
    screens: new Map(),
    inputCalls: 0,
    resizeCalls: [],
    closeCalls: 0,
    createCalls: 0,
    createBodies: [],
  }
  const now = () => Date.now()

  function makeSession(overrides) {
    const id = 'mock-terminal-' + (state.sessions.length + 1)
    return Object.assign({
      id,
      title: 'PowerShell',
      kind: 'interactive',
      owner: 'user',
      cwd: 'C:\\\\Users\\\\Public',
      cols: 80,
      rows: 24,
      state: 'running',
      exitCode: null,
      createdAt: now(),
      updatedAt: now(),
    }, overrides || {})
  }

  function screenText(id) {
    return (state.screens.get(id) || []).join('')
  }

  function snapshotFor(id) {
    const session = state.sessions.find((item) => item.id === id)
    if (!session) return null
    const text = screenText(id)
    return { info: Object.assign({}, session), screen: text, text, cursor: { x: 0, y: 0 }, seq }
  }

  function sendToStreams(type, data, onlySessionId) {
    for (const stream of state.streams.slice()) {
      if (onlySessionId && stream.sessionId !== onlySessionId) continue
      stream.emit({ type, data })
    }
  }

  function notifySessions() {
    sendToStreams('sessions', { sessions: state.sessions.slice() })
  }

  function pushOutput(id, chunk) {
    const chunks = state.screens.get(id) || []
    chunks.push(chunk)
    state.screens.set(id, chunks)
    seq += 1
    sendToStreams('output', { seq, chunk }, id)
  }

  function updateSession(id, patch) {
    const index = state.sessions.findIndex((item) => item.id === id)
    if (index < 0) return
    state.sessions[index] = Object.assign({}, state.sessions[index], patch, { updatedAt: now() })
    notifySessions()
  }

  class MockEventSource {
    constructor(rawUrl) {
      this.url = String(rawUrl)
      this.listeners = new Map()
      this.readyState = 0
      this.closed = false
      const parsed = new URL(this.url, location.origin)
      this.sessionId = parsed.searchParams.get('id')
      state.streams.push(this)
      if (FORCE_ERROR) {
        setTimeout(() => {
          if (this.closed) return
          this.readyState = 0
          this.dispatch('error', {})
        }, 20)
        return
      }
      setTimeout(() => {
        if (this.closed) return
        this.readyState = 1
        this.dispatch('open', {})
        if (this.sessionId) {
          const snapshot = snapshotFor(this.sessionId)
          if (snapshot) this.emit({ type: 'snapshot', data: snapshot })
        } else {
          this.emit({ type: 'sessions', data: { sessions: state.sessions.slice() } })
        }
      }, 15)
    }
    addEventListener(name, fn) {
      const list = this.listeners.get(name) || []
      list.push(fn)
      this.listeners.set(name, list)
    }
    removeEventListener(name, fn) {
      const list = (this.listeners.get(name) || []).filter((item) => item !== fn)
      this.listeners.set(name, list)
    }
    close() {
      this.closed = true
      this.readyState = 2
      const index = state.streams.indexOf(this)
      if (index >= 0) state.streams.splice(index, 1)
    }
    dispatch(name, payload) {
      for (const fn of this.listeners.get(name) || []) fn(payload)
    }
    emit(frame) {
      if (this.closed) return
      for (const fn of this.listeners.get(frame.type) || []) {
        fn({ data: JSON.stringify(frame.data) })
      }
    }
  }
  window.EventSource = MockEventSource

  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
    const parsed = new URL(rawUrl, location.origin)
    if (!parsed.pathname.startsWith(PREFIX)) return originalFetch(input, init)
    const method = String((init && init.method) || (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const path = parsed.pathname.slice(PREFIX.length)
    let body = {}
    if (init && typeof init.body === 'string' && init.body !== '') {
      try { body = JSON.parse(init.body) } catch { body = {} }
    }
    const json = (value, status) => new Response(JSON.stringify(value), {
      status: status || 200,
      headers: { 'content-type': 'application/json' },
    })

    if (FORCE_ERROR) return json({ error: 'mock: terminal service unavailable' }, 503)

    if (method === 'GET' && path === '/sessions') {
      return json({ sessions: state.sessions.slice() })
    }
    if (method === 'GET' && path === '/snapshot') {
      const snapshot = snapshotFor(parsed.searchParams.get('id'))
      return snapshot ? json(snapshot) : json({ error: 'not found' }, 404)
    }
    if (method === 'POST' && path === '/create') {
      state.createCalls += 1
      state.createBodies.push(body)
      seq += 1
      const session = makeSession({
        cols: typeof body.cols === 'number' ? body.cols : 80,
        rows: typeof body.rows === 'number' ? body.rows : 24,
        title: typeof body.title === 'string' ? body.title : 'PowerShell',
      })
      state.sessions.push(session)
      state.screens.set(session.id, [])
      notifySessions()
      return json({ session }, 201)
    }
    if (method === 'POST' && path === '/input') {
      state.inputCalls += 1
      const id = body.id
      const data = String(body.data === undefined ? '' : body.data)
      pushOutput(id, data.replace(/\r/g, '\r\n'))
      if (data.indexOf('\r') >= 0) pushOutput(id, '\r\nPS C:\\\\Users\\\\Public> ')
      return json({ ok: true })
    }
    if (method === 'POST' && path === '/resize') {
      state.resizeCalls.push({ id: body.id, cols: body.cols, rows: body.rows })
      updateSession(body.id, { cols: body.cols, rows: body.rows })
      return json({ ok: true })
    }
    if (method === 'POST' && path === '/close') {
      state.closeCalls += 1
      state.sessions = state.sessions.filter((item) => item.id !== body.id)
      notifySessions()
      return json({ ok: true })
    }
    return json({ error: 'mock: unknown route ' + method + ' ' + path }, 404)
  }

  globalThis.__MOCK_TERMINAL_PANEL__ = {
    state,
    triggerAgentCommand() {
      seq += 1
      const session = makeSession({
        title: "Write-Output 'agent-command'",
        kind: 'command',
        owner: 'agent',
        command: "Write-Output 'agent-command'",
      })
      state.sessions.push(session)
      state.screens.set(session.id, [])
      pushOutput(session.id, 'agent-command\r\n')
      notifySessions()
      return session.id
    },
  }
})()
`

/** Render the mock backend script, optionally forcing every route to fail. */
function mockScript(forceFailures) {
  return MOCK_SCRIPT.replace('__MOCK_FORCE_ERROR__', forceFailures ? 'true' : 'false')
}

/* ------------------------------------------------------------------ */
/* Shared browser helpers                                              */
/* ------------------------------------------------------------------ */

function attachCollectors(page, bucket) {
  page.on('console', (message) => {
    bucket.console.push({ type: message.type(), text: message.text() })
  })
  page.on('pageerror', (error) => {
    bucket.pageErrors.push(String(error))
  })
  page.on('response', (response) => {
    if (response.status() >= 400) {
      bucket.failedResponses.push({ status: response.status(), url: response.url() })
    }
  })
  // Network-level capture of the create request body (P2-1: sessionId must ride
  // along). In --mock mode fetch is stubbed in-page, so the mock state is used
  // instead; see runMainScenario.
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !request.url().includes('/dsh-terminal-panel/create')) return
    try {
      bucket.createRequests.push(JSON.parse(request.postData() ?? '{}'))
    } catch {
      bucket.createRequests.push({ unparsable: true })
    }
  })
}

async function dismissOverlays(page) {
  for (const name of ['继续', '继续使用', '知道了', 'Continue']) {
    const button = page.getByRole('button', { name, exact: true })
    if (await button.count()) {
      await button.first().click().catch(() => {})
      await page.waitForTimeout(500)
    }
  }
}

/** Open an on-screen conversation (required for the right sidebar to exist). */
async function openConversation(page) {
  const treeitems = page.locator('[role="treeitem"][data-row-key^="session:"]')
  if (await treeitems.count()) {
    await treeitems.first().click().catch(() => {})
    await page.waitForTimeout(2500)
    return 'treeitem'
  }
  const knownTitle = page.getByText('大数据实验手册操作指导', { exact: true }).first()
  if (await knownTitle.count()) {
    await knownTitle.click().catch(() => {})
    await page.waitForTimeout(2500)
    return 'known-title'
  }
  const newSession = page.getByRole('button', { name: '新建会话', exact: true }).first()
  if (await newSession.count()) {
    await newSession.click().catch(() => {})
    await page.waitForTimeout(2500)
    return 'created'
  }
  return 'none'
}

async function screenshot(page, name) {
  try {
    await page.screenshot({ path: join(artifacts, `e2e-${name}.png`) })
  } catch {
    // Screenshots are diagnostics only.
  }
}

async function readDebug(page) {
  return page.evaluate(() => {
    const debug = globalThis.__DSH_TERMINAL_PANEL_DEBUG__
    if (!debug) return null
    return {
      phase: debug.getPhase(),
      connection: debug.getConnection(),
      selectedId: debug.getSelectedId(),
      sessions: debug.getSessions(),
      visibleText: debug.getVisibleText(),
    }
  })
}

async function hostStatus(page) {
  try {
    return await page.evaluate(async () => {
      const response = await fetch('/dsh-terminal-panel/sessions', { credentials: 'same-origin' })
      return response.status
    })
  } catch {
    return -1
  }
}

/* ------------------------------------------------------------------ */
/* Main scenario: registration + panel + functional flow               */
/* ------------------------------------------------------------------ */

async function runMainScenario(browser, page, bucket) {
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(5000)
  await dismissOverlays(page)

  const opened = await openConversation(page)
  record('opened an on-screen conversation', opened !== 'none', `via ${opened}`)
  await screenshot(page, '01-conversation')

  const markers = await page.evaluate(() => ({
    loaded: Boolean(globalThis.__DSH_TERMINAL_PANEL__),
    info: globalThis.__DSH_TERMINAL_PANEL_CLIENT__ ?? null,
  }))
  record('client bundle loaded', markers.loaded, JSON.stringify(markers.info))

  const status = await hostStatus(page)
  const functional = mockMode ? !forceError : status === 200
  record(
    'host API readiness',
    mockMode ? true : status === 200 || status === 404,
    mockMode
      ? forceError
        ? 'mocked backend (forced error)'
        : 'mocked backend'
      : `GET /dsh-terminal-panel/sessions -> ${status}`,
  )
  if (!functional) {
    skip(
      'full terminal flow',
      mockMode
        ? 'forced error mock mode'
        : `host half not ready (GET /sessions -> ${status}); expected during client-only phase`,
    )
  }

  // ---- Right sidebar guide -----------------------------------------
  await page.keyboard.press('Control+Shift+B')
  await page.waitForTimeout(2500)
  const guide = page.getByText(/终端面板|Terminal Panel/)
  const guideCount = await guide.count()
  record('right sidebar shows the terminal-panel guide entry', guideCount > 0, `matches=${guideCount}`)
  await screenshot(page, '02-right-sidebar')

  if (guideCount > 0) {
    await guide.first().click().catch(() => {})
    await page.waitForTimeout(2500)
  }
  const bodyCount = await page.locator('[data-dsh-terminal-panel="body"]').count()
  record('terminal panel body mounted from the guide entry', bodyCount > 0, `bodies=${bodyCount}`)

  if (!functional) {
    const debug = await readDebug(page)
    const errorState = await page.locator('[data-dsh-tp-state="error"]').count()
    record(
      'graceful host-not-ready state with retry',
      debug !== null && (debug.phase === 'error' || errorState > 0),
      `phase=${debug?.phase ?? 'no-debug-hook'} errorState=${errorState}`,
    )
    const retry = await page.locator('[data-dsh-tp-action="retry"]').count()
    record('retry action available in error state', retry > 0, `retryButtons=${retry}`)
    if (retry > 0) {
      await page.locator('[data-dsh-tp-action="retry"]').first().click().catch(() => {})
      await page.waitForTimeout(1200)
      const debugAfterRetry = await readDebug(page)
      const errorStateAfterRetry = await page.locator('[data-dsh-tp-state="error"]').count()
      record(
        'retry keeps the error state without crashing',
        debugAfterRetry !== null &&
          (debugAfterRetry.phase === 'error' || errorStateAfterRetry > 0),
        `phase=${debugAfterRetry?.phase ?? 'no-debug-hook'}`,
      )
    }
    await screenshot(page, '03-panel-error')
    return { functional }
  }

  // ---- Functional flow ---------------------------------------------
  const ready = await waitFor(
    async () => (await page.locator('[data-dsh-tp-phase="ready"]').count()) > 0,
    8000,
  )
  record('session list loaded (phase=ready)', ready)
  await screenshot(page, '03-panel-empty')

  const create = page.locator('[data-dsh-tp-action="create"]')
  if (await create.count()) {
    await create.first().click()
  } else {
    record('create-terminal action present', false)
    return { functional }
  }
  const terminalVisible = await waitFor(
    async () => (await page.locator('.dshtp-screen .xterm').count()) > 0,
    12_000,
  )
  record('new terminal renders an xterm screen', terminalVisible)

  const selected = await waitFor(async () => {
    const debug = await readDebug(page)
    return Boolean(debug && debug.selectedId && debug.sessions.length >= 1)
  }, 8000)
  record('new session is selected in the panel', selected)

  // P2-1: the create request must carry the conversation session id so the host
  // can resolve the session workspace as cwd.
  const conversationSessionId = await page.evaluate(
    () => globalThis.__DSH_TERMINAL_PANEL_DEBUG__?.getConversationSessionId?.() ?? null,
  )
  let createBody = null
  if (mockMode) {
    createBody = await page.evaluate(
      () => globalThis.__MOCK_TERMINAL_PANEL__.state.createBodies[0] ?? null,
    )
  } else {
    createBody = bucket.createRequests[0] ?? null
  }
  const createHasSession =
    Boolean(createBody) &&
    typeof createBody.sessionId === 'string' &&
    createBody.sessionId !== '' &&
    (conversationSessionId === null || createBody.sessionId === conversationSessionId)
  record(
    'create request carries the conversation sessionId',
    createHasSession,
    `body.sessionId=${createBody?.sessionId ?? 'missing'} conversation=${conversationSessionId ?? 'unknown'} cols=${createBody?.cols} rows=${createBody?.rows}`,
  )

  await page.waitForTimeout(1200)
  await screenshot(page, '04-terminal-created')

  // Wait for the session stream before typing; then focus xterm's textarea.
  await waitFor(async () => (await readDebug(page))?.connection === 'connected', 10_000)
  await page.locator('.dshtp-screen').click().catch(() => {})
  const textarea = page.locator('.dshtp-screen .xterm-helper-textarea')
  if (await textarea.count()) await textarea.first().focus().catch(() => {})
  await page.waitForTimeout(250)
  await page.keyboard.type("Write-Output 'hello'", { delay: 25 })
  await page.waitForTimeout(250)
  await page.keyboard.press('Enter')

  const outputTimeout = mockMode ? 8000 : 20_000
  const gotOutput = await waitFor(async () => {
    const debug = await readDebug(page)
    return ((debug?.visibleText ?? '').includes('hello'))
  }, outputTimeout)
  const debugAfterOutput = await readDebug(page)
  record(
    'typed command output appears on screen',
    gotOutput,
    `screen="${(debugAfterOutput?.visibleText ?? '').replace(/\r?\n/g, ' | ').slice(0, 160)}"`,
  )
  await screenshot(page, '05-terminal-output')

  // Fit/resize: the terminal must report a real grid size back to the host.
  // The first fit happens from a requestAnimationFrame after the snapshot, so
  // poll instead of sampling once (headless rAF timing varies).
  let mockResizeCalls = 0
  const fitForwarded = await waitFor(async () => {
    if (mockMode) {
      mockResizeCalls = await page.evaluate(
        () => globalThis.__MOCK_TERMINAL_PANEL__.state.resizeCalls.length,
      )
      return mockResizeCalls > 0
    }
    const debug = await readDebug(page)
    const session = debug?.sessions.find((item) => item.id === debug.selectedId)
    return Boolean(session && session.cols >= 2 && session.rows >= 1)
  }, 6000)
  const debugForSize = await readDebug(page)
  const selectedSession = debugForSize?.sessions.find((item) => item.id === debugForSize.selectedId)
  record(
    'terminal fit forwards a resize to the host',
    fitForwarded,
    `cols=${selectedSession?.cols} rows=${selectedSession?.rows}${mockMode ? ` mockResizeCalls=${mockResizeCalls}` : ''}`,
  )

  // Screenshot / copy-to-clipboard.
  const copy = page.locator('[data-dsh-tp-action="copy"]')
  if (await copy.count()) {
    await copy.first().click()
    await page.waitForTimeout(600)
    let clipboard = ''
    try {
      clipboard = await page.evaluate(() => navigator.clipboard.readText())
    } catch (error) {
      record('clipboard readable in test browser', false, String(error), { optional: true })
    }
    record(
      'screenshot button copies the visible screen',
      clipboard.includes('hello'),
      `clipboard="${clipboard.replace(/\r?\n/g, ' | ').slice(0, 120)}"`,
    )
  }

  // Reconnect: the stream reopens and the screen is restored.
  const reconnect = page.locator('[data-dsh-tp-action="reconnect"]')
  if (await reconnect.count()) {
    await reconnect.first().click()
    await page.waitForTimeout(1800)
    const debugAfterReconnect = await readDebug(page)
    record(
      'reconnect restores the session stream',
      (debugAfterReconnect?.visibleText ?? '').includes('hello') ||
        debugAfterReconnect?.connection === 'connected',
      `connection=${debugAfterReconnect?.connection}`,
    )
  }
  await screenshot(page, '06-terminal-reconnected')

  // Page refresh: the right-sidebar layout is persisted by the shell, the host
  // keeps its PTY sessions, and the client restores the screen from a snapshot.
  if (!mockMode) {
    const beforeReload = await readDebug(page)
    const sessionId = beforeReload?.selectedId
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(5500)
    await dismissOverlays(page)

    let reopened = await waitFor(
      async () => (await page.locator('[data-dsh-terminal-panel="body"]').count()) > 0,
      8000,
    )
    if (!reopened) {
      await page.keyboard.press('Control+Shift+B')
      await page.waitForTimeout(2500)
      reopened = (await page.locator('[data-dsh-terminal-panel="body"]').count()) > 0
    }
    record('panel reopens after a page refresh', reopened)

    const retained = await waitFor(async () => {
      const debug = await readDebug(page)
      return Boolean(debug && sessionId && debug.sessions.some((item) => item.id === sessionId))
    }, 10_000)
    record('host session retained across a page refresh', retained, `session=${sessionId ?? 'none'}`)

    const restoredScreen = await waitFor(async () => {
      const debug = await readDebug(page)
      return Boolean(
        debug &&
          debug.selectedId === sessionId &&
          (debug.visibleText ?? '').includes('hello'),
      )
    }, 12_000)
    record('terminal screen restored from the host snapshot after refresh', restoredScreen)
    await screenshot(page, '07-terminal-refreshed')
  } else {
    skip('page refresh restore', 'mocked backend state lives in the page, so refresh is a real-host check')
  }

  // Close: the selected session disappears (other retained sessions may remain).
  const close = page.locator('[data-dsh-tp-action="close"]')
  if (await close.count()) {
    const beforeClose = await readDebug(page)
    const closingId = beforeClose?.selectedId
    await close.first().click()
    const closed = await waitFor(async () => {
      const debug = await readDebug(page)
      return Boolean(debug && closingId && !debug.sessions.some((item) => item.id === closingId))
    }, 6000)
    record('close removes the current terminal session', closed, `session=${closingId ?? 'none'}`)
    const remaining = (await readDebug(page))?.sessions.length ?? 0
    if (remaining === 0) {
      const emptyState = await waitFor(
        async () => (await page.locator('[data-dsh-tp-state="empty"]').count()) > 0,
        4000,
      )
      record('empty state returns after closing the last terminal', emptyState)
    } else {
      skip('empty state returns after closing the last terminal', `${remaining} retained session(s) remain on the host`)
    }
  }
  await screenshot(page, '08-terminal-closed')

  return { functional }
}

/* ------------------------------------------------------------------ */
/* Mock-only scenario: auto-open on new agent command session          */
/* ------------------------------------------------------------------ */

async function runAutoOpenScenario(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  await context.addInitScript({ content: mockScript(false) })
  const page = await context.newPage()
  const bucket = { console: [], pageErrors: [], failedResponses: [], createRequests: [] }
  attachCollectors(page, bucket)
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(4500)
    await dismissOverlays(page)
    await openConversation(page)

    const watcher = await page.evaluate(
      () => Boolean(globalThis.__DSH_TERMINAL_PANEL_CLIENT__?.autoOpenWatcher),
    )
    record('auto-open watcher registered in the root shell.overlay seat', watcher)

    // Give the watcher a beat to seed its baseline over REST + SSE.
    await page.waitForTimeout(1500)
    const panelBefore = await page.locator('[data-dsh-terminal-panel="body"]').count()
    record('panel is closed before the agent command starts', panelBefore === 0, `bodies=${panelBefore}`)

    await page.evaluate(() => {
      globalThis.__MOCK_TERMINAL_PANEL__.triggerAgentCommand()
    })

    const autoOpened = await waitFor(
      async () => (await page.locator('[data-dsh-terminal-panel="body"]').count()) > 0,
      10_000,
    )
    record('new agent command session auto-opens the terminal panel', autoOpened)
    if (autoOpened) {
      await page.waitForTimeout(1200)
      const chips = await page.locator('[data-dsh-tp-session-id]').count()
      record('auto-opened panel lists the agent command session', chips > 0, `sessionChips=${chips}`)
      const debug = await readDebug(page)
      record(
        'auto-opened panel selects the command session',
        Boolean(debug?.selectedId),
        `selected=${debug?.selectedId ?? 'none'}`,
      )
    }
    await screenshot(page, '09-auto-open')

    const unexpectedErrors = bucket.console.filter(
      (item) => item.type === 'error' && !/Failed to load resource/i.test(item.text),
    )
    record(
      'auto-open scenario has no unexpected console/page errors',
      bucket.pageErrors.length === 0 && unexpectedErrors.length === 0,
      [...bucket.pageErrors, ...unexpectedErrors.map((item) => item.text)].join(' | '),
    )
  } finally {
    await context.close()
  }
}

/* ------------------------------------------------------------------ */
/* Diagnostics: console + failed responses                             */
/* ------------------------------------------------------------------ */

function analyzeDiagnostics(bucket, functional) {
  const unexpectedResponses = bucket.failedResponses.filter((item) => {
    let path = item.url
    try {
      path = new URL(item.url).pathname
    } catch {
      // Keep the raw URL.
    }
    if (path.startsWith('/dsh-terminal-panel/') || path.startsWith('/api/changes.summary')) {
      return functional && path.startsWith('/dsh-terminal-panel/')
    }
    if (path === '/favicon.ico') return false
    return true
  })
  record(
    'no unexpected failed HTTP responses',
    unexpectedResponses.length === 0,
    unexpectedResponses.map((item) => `${item.status} ${item.url}`).join(' | '),
  )

  record(
    'no uncaught page errors',
    bucket.pageErrors.length === 0,
    bucket.pageErrors.join(' | '),
  )

  const consoleErrors = bucket.console.filter(
    (item) =>
      item.type === 'error' &&
      !/Failed to load resource/i.test(item.text) &&
      !/EventSource/i.test(item.text),
  )
  record(
    'no unexpected console errors',
    consoleErrors.length === 0,
    consoleErrors.map((item) => item.text).join(' | '),
  )
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

const browser = await chromium.launch({
  executablePath: browserPath,
  headless: true,
  args: ['--no-sandbox'],
})

let exitCode = 0
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
  })
  if (mockMode) await context.addInitScript({ content: mockScript(forceError) })
  const page = await context.newPage()
  const bucket = { console: [], pageErrors: [], failedResponses: [], createRequests: [] }
  attachCollectors(page, bucket)

  let functional = mockMode
  try {
    const outcome = await runMainScenario(browser, page, bucket)
    functional = outcome.functional
  } finally {
    analyzeDiagnostics(bucket, functional)
    await context.close()
  }

  if (mockMode && !forceError) {
    await runAutoOpenScenario(browser)
  } else {
    skip(
      'auto-open watcher scenario',
      forceError
        ? 'skipped in --mock-error mode'
        : 'requires --mock (no way to start an agent command from the UI test)',
    )
  }

  // ---- Summary ----------------------------------------------------
  const hardFailures = results.filter((item) => !item.ok && !item.optional && !item.skipped)
  const warnings = results.filter((item) => item.optional && !item.ok)
  const skipped = results.filter((item) => item.skipped)
  console.log('\n--- summary ---')
  console.log(
    JSON.stringify(
      {
        mode: forceError ? 'mock-error' : mockMode ? 'mock' : 'real',
        url,
        passed: results.filter((item) => item.ok && !item.skipped).length,
        failed: hardFailures.length,
        warnings: warnings.length,
        skipped: skipped.length,
        functionalFlow: functional,
        artifacts,
      },
      null,
      2,
    ),
  )
  if (hardFailures.length > 0) exitCode = 1
} catch (error) {
  console.error('[verify-ui] fatal:', error)
  exitCode = 1
} finally {
  await browser.close()
}

process.exitCode = exitCode
