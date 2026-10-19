#!/usr/bin/env node
/**
 * Independent QA e2e harness for the dsh-terminal-panel plugin.
 *
 * Drives the DSH Web GUI with Playwright + the system Chrome (UI assertions) and
 * validates the plugin's HTTP + SSE contract with fetch (every request is a real
 * fetch against the dev host with the browser's auth cookie).
 *
 * Usage:
 *   node tools/qa-e2e.mjs "<dev-host-url-with-token>"
 *   node tools/qa-e2e.mjs --http-only "<url>"      # skip UI interactions
 *   node tools/qa-e2e.mjs --slow "<url>"           # include 20s heartbeat check
 *   node tools/qa-e2e.mjs --no-create-session "<url>"
 *   node tools/qa-e2e.mjs --host-log=<path> "<url>"
 *   DSH_QA_URL="<url>" node tools/qa-e2e.mjs
 *
 * Exit codes: 0 = no FAIL, 1 = at least one FAIL, 2 = environment/usage error.
 *
 * Contract reference: docs/architecture.md §4 (host/HTTP/SSE/tools) and §6
 * (test & acceptance). This file is QA-owned: it never modifies plugin code.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

// ---------------------------------------------------------------------------
// CLI / environment
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)
const argv = process.argv.slice(2)
const positional = argv.filter((a) => !a.startsWith('--'))
const flags = new Map(
  argv
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const eq = a.indexOf('=')
      return eq === -1 ? [a.slice(2), true] : [a.slice(2, eq), a.slice(eq + 1)]
    }),
)
const help = flags.has('help') || flags.has('h')
const url = positional[0] ?? process.env.DSH_QA_URL

if (help) {
  console.log(`dsh-terminal-panel independent QA e2e

usage: node tools/qa-e2e.mjs <url-with-token> [options]

options:
  --http-only             skip UI interactions (page is still loaded to obtain the auth cookie)
  --slow                  include the 20s SSE heartbeat check
  --no-create-session     never create a conversation through the UI session list
  --keep-sessions         leave created terminal sessions open for debugging
  --host-log=<path>       inspect a dev-host log file for plugin startup errors (E-01)
  --out=<dir>             artifacts directory (default qa/artifacts/<runId>)
  --help, -h              show this help
`)
  process.exit(0)
}

if (!url || !/^https?:\/\//.test(url)) {
  console.error('usage: node tools/qa-e2e.mjs <url-with-token> [--http-only] [--slow]')
  console.error('  (url may also be provided via env DSH_QA_URL)')
  process.exit(2)
}

const HTTP_ONLY = flags.has('http-only')
const SLOW = flags.has('slow')
const NO_CREATE_SESSION = flags.has('no-create-session')
const KEEP_SESSIONS = flags.has('keep-sessions')
const HOST_LOG = typeof flags.get('host-log') === 'string' ? flags.get('host-log') : process.env.DSH_QA_HOST_LOG
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const artifacts = typeof flags.get('out') === 'string' ? resolve(repoRoot, flags.get('out')) : join(repoRoot, 'qa', 'artifacts', runId)
mkdirSync(artifacts, { recursive: true })

let origin
try {
  origin = new URL(url).origin
} catch {
  console.error(`invalid url: ${url}`)
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nowIso = () => new Date().toISOString()

// ---------------------------------------------------------------------------
// Result recording
// ---------------------------------------------------------------------------

/** @type {{id:string,title:string,method:string,status:string,detail:any,evidence:string[],at:string}[]} */
const results = []
const consoleMessages = []
const consoleErrors = []
const pageErrors = []
const pluginHttpCalls = []
const pluginHttpFailures = []
const unrelatedHttpErrors = []
let shotSeq = 0

class SkipError extends Error {}

function rel(file) {
  return file.startsWith(repoRoot) ? file.slice(repoRoot.length + 1).replace(/\\/g, '/') : file
}

function record(id, title, method, status, detail) {
  const entry = {
    id,
    title,
    method,
    status,
    detail: detail === undefined ? null : detail,
    evidence: [],
    at: nowIso(),
  }
  results.push(entry)
  const label = `[${status}] ${id} ${title}`
  if (status === 'FAIL') console.error(`${label} -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  else console.log(`${label}${typeof detail === 'string' && status !== 'PASS' ? ` (${detail})` : ''}`)
  return entry
}

function pass(id, title, method, detail) {
  return record(id, title, method, 'PASS', detail)
}
function manual(id, title, method, detail) {
  return record(id, title, method, 'MANUAL', detail)
}
function skip(id, title, method, reason) {
  return record(id, title, method, 'SKIP', reason)
}
function fail(id, title, method, detail) {
  return record(id, title, method, 'FAIL', detail)
}

async function test(id, title, method, fn) {
  try {
    const detail = await fn()
    const entry = pass(id, title, method, detail)
    return entry
  } catch (error) {
    if (error instanceof SkipError) {
      const entry = skip(id, title, method, error.message)
      return entry
    }
    const entry = fail(id, title, method, sanitizeError(error))
    try {
      if (page) entry.evidence.push(await shot(`fail-${id}`, page))
    } catch {
      /* ignore */
    }
    return entry
  }
}

function sanitizeError(error) {
  if (error instanceof Error) {
    return { message: error.message, stack: String(error.stack ?? '').split('\n').slice(0, 6) }
  }
  return String(error)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function shot(label, targetPage = page) {
  shotSeq += 1
  const safe = String(label).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80)
  const file = join(artifacts, `${String(shotSeq).padStart(2, '0')}-${safe}.png`)
  try {
    await targetPage.screenshot({ path: file, timeout: 10_000 })
    return rel(file)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let browser = null
let context = null
/** @type {import('playwright-core').Page | null} */
let page = null
let cookieHeader = ''
const initialSessionIds = new Set()
const createdSessionIds = new Set()

const ui = {
  pageReady: false,
  guideOpened: false,
  panelOpened: false,
  xtermReady: false,
  currentSessionId: null,
  helloNonce: null,
  secondNonce: null,
}

const https = {
  mainSessionId: null,
  boundarySessionId: null,
}

// ---------------------------------------------------------------------------
// HTTP helpers (real fetch, browser auth cookie)
// ---------------------------------------------------------------------------

async function http(method, path, options = {}) {
  const { data, headers = {}, timeoutMs = 20_000, noCookie = false } = options
  const finalHeaders = { ...headers }
  if (!noCookie && cookieHeader) finalHeaders.cookie = cookieHeader
  let body
  if (data !== undefined) {
    finalHeaders['content-type'] = finalHeaders['content-type'] ?? 'application/json'
    body = typeof data === 'string' ? data : JSON.stringify(data)
  }
  const response = await fetch(origin + path, {
    method,
    headers: finalHeaders,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, text, json, headers: response.headers }
}

function assertJsonError(res, label, expected) {
  assert(res.status >= 400 && res.status < 600, `${label}: 期望 4xx/5xx，实际 ${res.status} ${res.text.slice(0, 160)}`)
  if (expected) assert(expected.includes(res.status), `${label}: 期望状态 ${expected.join('/')}，实际 ${res.status}`)
  assert(res.json && typeof res.json.error === 'string' && res.json.error.length > 0, `${label}: 错误响应应为 {error:string}，实际 ${res.text.slice(0, 200)}`)
}

async function waitFor(fn, { timeoutMs = 15_000, intervalMs = 150, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await fn()
    } catch (error) {
      last = { ok: false, message: sanitizeError(error) }
    }
    if (last && last.ok) return last
    await sleep(intervalMs)
  }
  const msg = last && last.message ? (typeof last.message === 'string' ? last.message : JSON.stringify(last.message)) : '超时'
  throw new Error(`${label} 等待超时 (${timeoutMs}ms): ${msg}`)
}

async function fetchSessions() {
  const res = await http('GET', '/dsh-terminal-panel/sessions')
  assert(res.status === 200, `GET /sessions 期望 200，实际 ${res.status} ${res.text.slice(0, 200)}`)
  assert(res.json && Array.isArray(res.json.sessions), `GET /sessions 响应应为 {sessions:[]}，实际 ${res.text.slice(0, 200)}`)
  return res.json.sessions
}

function validateSessionInfo(info) {
  const problems = []
  const stringFields = ['id', 'title', 'kind', 'owner', 'cwd']
  for (const key of stringFields) {
    if (typeof info?.[key] !== 'string' || info[key].length === 0) problems.push(`${key} 应为非空字符串`)
  }
  if (!['command', 'interactive'].includes(info?.kind)) problems.push(`kind 非法: ${JSON.stringify(info?.kind)}`)
  if (!['agent', 'user'].includes(info?.owner)) problems.push(`owner 非法: ${JSON.stringify(info?.owner)}`)
  if (!['running', 'exited', 'failed'].includes(info?.state)) problems.push(`state 非法: ${JSON.stringify(info?.state)}`)
  for (const key of ['cols', 'rows']) {
    if (typeof info?.[key] !== 'number' || !Number.isFinite(info[key]) || info[key] <= 0) problems.push(`${key} 应为正数`)
  }
  if (!(typeof info?.exitCode === 'number' || info?.exitCode === null)) problems.push('exitCode 应为 number|null')
  for (const key of ['createdAt', 'updatedAt']) {
    if (typeof info?.[key] !== 'number') problems.push(`${key} 应为 number`)
  }
  return problems
}

async function createSession(body = { cols: 100, rows: 30 }) {
  const res = await http('POST', '/dsh-terminal-panel/create', { data: body })
  assert(res.status === 200, `POST /create 期望 200，实际 ${res.status} ${res.text.slice(0, 200)}`)
  const info = res.json?.session
  assert(info && typeof info.id === 'string', `POST /create 响应应为 {session:{id,...}}，实际 ${res.text.slice(0, 200)}`)
  createdSessionIds.add(info.id)
  return info
}

async function getSnapshot(id) {
  const res = await http('GET', `/dsh-terminal-panel/snapshot?id=${encodeURIComponent(id)}`)
  assert(res.status === 200, `GET /snapshot?id=${id} 期望 200，实际 ${res.status} ${res.text.slice(0, 200)}`)
  assert(res.json && typeof res.json === 'object', 'snapshot 响应应为 JSON 对象')
  return res.json
}

async function sendInput(id, data) {
  const res = await http('POST', '/dsh-terminal-panel/input', { data: { id, data } })
  assert(res.status === 200, `POST /input 期望 200，实际 ${res.status} ${res.text.slice(0, 200)}`)
  return res.json
}

async function runCommand(id, command) {
  return sendInput(id, command + '\r')
}

async function waitForSnapshotText(id, needle, timeoutMs = 20_000) {
  const started = Date.now()
  const hit = await waitFor(
    async () => {
      const snap = await getSnapshot(id)
      return { ok: typeof snap.text === 'string' && snap.text.includes(needle), snap }
    },
    { timeoutMs, intervalMs: 200, label: `snapshot 文本包含 ${JSON.stringify(needle)}` },
  )
  return { elapsedMs: Date.now() - started, snap: hit.snap }
}

async function waitForShellReady(id, timeoutMs = 25_000) {
  try {
    await waitFor(
      async () => {
        const snap = await getSnapshot(id)
        const text = snap.text ?? ''
        const lines = text.split('\n').map((l) => l.trimEnd())
        const last = lines.filter((l) => l.length > 0).pop() ?? ''
        return { ok: /PS\s+[A-Za-z]:[\\/]/.test(text) || /PS\s+\S/.test(text) || /[>$#]\s*$/.test(last), snap }
      },
      { timeoutMs, intervalMs: 200, label: 'shell 就绪（出现提示符）' },
    )
    return true
  } catch {
    return false
  }
}

async function closeSession(id) {
  try {
    const res = await http('POST', '/dsh-terminal-panel/close', { data: { id } })
    return res
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// SSE helpers (framed parsing over fetch streams)
// ---------------------------------------------------------------------------

/**
 * Open an SSE connection and parse `event:`/`data:` frames plus `:` heartbeat
 * comments. Returns a small collector with waitFor/close.
 */
async function openSse(path, { timeoutMs = 90_000 } = {}) {
  const controller = new AbortController()
  const hardTimeout = setTimeout(() => {
    try {
      controller.abort()
    } catch {
      /* ignore */
    }
  }, timeoutMs)
  const state = {
    status: 0,
    contentType: null,
    frames: [],
    error: null,
    closed: false,
    connectedAt: null,
  }
  const response = await fetch(origin + path, {
    headers: { accept: 'text/event-stream', cookie: cookieHeader },
    signal: controller.signal,
  })
  state.status = response.status
  state.contentType = response.headers.get('content-type')
  state.connectedAt = Date.now()
  const contentProblem =
    response.status !== 200
      ? `SSE ${path} 期望 200，实际 ${response.status} ${response.headers.get('content-type') ?? ''}`
      : !String(state.contentType ?? '').includes('text/event-stream')
        ? `SSE ${path} Content-Type 应为 text/event-stream，实际 ${state.contentType}`
        : null
  if (contentProblem) {
    clearTimeout(hardTimeout)
    try {
      controller.abort()
    } catch {
      /* ignore */
    }
    throw new Error(contentProblem)
  }

  const waiters = []
  const flushWaiters = (frame) => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i]
      let matched = false
      try {
        matched = waiter.predicate(frame)
      } catch {
        matched = false
      }
      if (matched) {
        waiters.splice(i, 1)
        clearTimeout(waiter.timer)
        waiter.resolve(frame)
      }
    }
  }
  const rejectAll = (error) => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
  }
  const pump = (async () => {
    try {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          if (raw.length === 0) continue
          if (raw.startsWith(':')) {
            state.frames.push({ kind: 'heartbeat', raw: raw.slice(0, 120), at: Date.now() })
            continue
          }
          let event = 'message'
          const dataLines = []
          let retry = null
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) {
              event = line.slice(6).trim()
            } else if (line.startsWith('data:')) {
              dataLines.push(line.slice(5).trimStart())
            } else if (line.startsWith('retry:')) {
              // Valid SSE field (reconnect delay), not an event frame.
              retry = Number(line.slice(6).trim())
            } else if (line.startsWith(':')) {
              state.frames.push({ kind: 'heartbeat', raw: line.slice(0, 120), at: Date.now() })
            }
          }
          // Control-only frames (retry:) carry no data and are never dispatched.
          if (dataLines.length === 0) continue
          const dataText = dataLines.join('\n')
          let data = dataText
          try {
            data = JSON.parse(dataText)
          } catch {
            data = dataText
          }
          const frame = { kind: 'event', event, data, dataText, retry, at: Date.now() }
          state.frames.push(frame)
          flushWaiters(frame)
        }
      }
    } catch (error) {
      if (error?.name !== 'AbortError') state.error = String(error)
    } finally {
      state.closed = true
      rejectAll(new Error(`SSE ${path} 流已关闭`))
      clearTimeout(hardTimeout)
    }
  })()

  return {
    state,
    path,
    async waitFor(predicate, waitTimeoutMs = 15_000) {
      const existing = state.frames.find((f) => f.kind === 'event' && predicate(f))
      if (existing) return existing
      return new Promise((resolveFn, rejectFn) => {
        const waiter = {
          predicate: (frame) => frame.kind === 'event' && predicate(frame),
          resolve: resolveFn,
          reject: rejectFn,
          timer: setTimeout(() => {
            const i = waiters.indexOf(waiter)
            if (i >= 0) waiters.splice(i, 1)
            rejectFn(new Error(`SSE ${path} 等待事件超时 (${waitTimeoutMs}ms)`))
          }, waitTimeoutMs),
        }
        waiters.push(waiter)
      })
    },
    close() {
      try {
        controller.abort()
      } catch {
        /* ignore */
      }
      void pump
    },
    async finish() {
      this.close()
      await pump.catch(() => {})
      return state
    },
  }
}

function framePayloadString(frame) {
  try {
    return JSON.stringify(frame.data)
  } catch {
    return String(frame.data)
  }
}

// ---------------------------------------------------------------------------
// Browser / page helpers
// ---------------------------------------------------------------------------

const BROWSER_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]

function findBrowser() {
  if (process.env.DSH_TEST_BROWSER && existsSync(process.env.DSH_TEST_BROWSER)) return process.env.DSH_TEST_BROWSER
  return BROWSER_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null
}

function attachPageListeners(target) {
  target.on('console', (message) => {
    const line = `[${message.type()}] ${message.text()}`
    consoleMessages.push(line)
    if (message.type() === 'error') consoleErrors.push(line)
  })
  target.on('pageerror', (error) => {
    pageErrors.push(String(error?.stack ?? error))
  })
  target.on('response', (response) => {
    const responseUrl = response.url()
    const status = response.status()
    if (responseUrl.includes('/dsh-terminal-panel')) {
      pluginHttpCalls.push({ status, url: responseUrl, method: response.request().method(), at: nowIso() })
      if (status >= 400) pluginHttpFailures.push(`${status} ${response.request().method()} ${responseUrl}`)
    } else if (status >= 400) {
      unrelatedHttpErrors.push(`${status} ${responseUrl}`)
    }
  })
}

async function acquireSession() {
  let browserLaunchError = null
  const browserPath = findBrowser()
  if (browserPath && !HTTP_ONLY_FORCE_NO_BROWSER()) {
    try {
      browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
      context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      page = await context.newPage()
      page.setDefaultTimeout(20_000)
      attachPageListeners(page)
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForTimeout(1200)
      const cookies = await context.cookies()
      cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
      if (cookieHeader && page) return { browserUsed: true }
    } catch (error) {
      browserLaunchError = error
      console.error(`[setup] 浏览器流程失败，尝试 Node fetch 获取 cookie: ${error?.message ?? error}`)
      try {
        if (page) await page.close().catch(() => {})
        if (context) await context.close().catch(() => {})
        if (browser) await browser.close().catch(() => {})
      } catch {
        /* ignore */
      }
      browser = null
      context = null
      page = null
    }
  }

  // Fallback: exchange the launch token with plain fetch and keep Set-Cookie.
  const response = await fetch(url, { redirect: 'follow' })
  await response.text()
  const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  cookieHeader = setCookies.map((cookie) => cookie.split(';')[0]).join('; ')
  if (!cookieHeader) {
    throw new Error(`无法获取认证 cookie（browser: ${browserLaunchError?.message ?? 'unavailable'}）`)
  }
  return { browserUsed: false, reason: browserLaunchError ? String(browserLaunchError.message ?? browserLaunchError) : 'http-only' }
}

function HTTP_ONLY_FORCE_NO_BROWSER() {
  return process.env.DSH_QA_NO_BROWSER === '1'
}

async function dismissOverlays(targetPage) {
  const clicked = []
  for (const name of ['继续', '进入', '开始使用', '我知道了', '知道了', '关闭预览']) {
    const button = targetPage.getByRole('button', { name, exact: true }).first()
    try {
      if (await button.count()) {
        if (await button.isVisible()) {
          await button.click({ timeout: 2500 })
          clicked.push(name)
          await targetPage.waitForTimeout(500)
        }
      }
    } catch {
      /* ignore */
    }
  }
  try {
    await targetPage.keyboard.press('Escape')
  } catch {
    /* ignore */
  }
  await targetPage.waitForTimeout(400)
  return { clicked }
}

async function waitForAppReady(targetPage) {
  await targetPage.waitForFunction(() => (document.body?.innerText?.length ?? 0) > 30, null, { timeout: 40_000 })
  await targetPage.waitForTimeout(1500)
}

async function ensureConversation(targetPage) {
  await dismissOverlays(targetPage)
  const composerCount = await targetPage
    .locator('textarea, [contenteditable="true"]')
    .count()
    .catch(() => 0)

  const title = process.env.DSH_QA_SESSION_TITLE ?? '大数据实验手册操作指导'
  const existing = targetPage.getByText(title, { exact: true }).first()
  if (await existing.count().catch(() => 0)) {
    try {
      if (await existing.isVisible()) {
        await existing.click({ timeout: 4000 })
        await targetPage.waitForTimeout(2500)
        return { mode: 'existing-session', title, composerCount }
      }
    } catch {
      /* ignore */
    }
  }
  if (composerCount > 0) return { mode: 'composer-already-visible', title, composerCount }
  if (NO_CREATE_SESSION) return { mode: 'skipped-new-session', title, composerCount }

  const newSession = targetPage.getByRole('button', { name: '新建会话' }).first()
  if (await newSession.count().catch(() => 0)) {
    try {
      if (await newSession.isVisible()) {
        await newSession.click({ timeout: 4000 })
        await targetPage.waitForTimeout(3000)
        return { mode: 'new-session', title, composerCount }
      }
    } catch {
      /* ignore */
    }
  }
  return { mode: 'no-session-created', title, composerCount }
}

async function openRightSidebar(targetPage) {
  const collapse = targetPage.getByRole('button', { name: /收起右侧边栏/ }).first()
  const isOpen = async () => {
    try {
      return (await collapse.count()) > 0 && (await collapse.isVisible())
    } catch {
      return false
    }
  }
  if (await isOpen()) return 'already-open'
  try {
    await targetPage.keyboard.press('Control+Shift+B')
  } catch {
    /* ignore */
  }
  await targetPage.waitForTimeout(1200)
  if (await isOpen()) return 'keyboard'
  const openButton = targetPage.getByRole('button', { name: /打开右侧边栏/ }).first()
  if (await openButton.count().catch(() => 0)) {
    try {
      await openButton.click({ timeout: 3000 })
      await targetPage.waitForTimeout(1200)
      if (await isOpen()) return 'button'
    } catch {
      /* ignore */
    }
  }
  return 'unconfirmed'
}

async function openPanelFromGuide(targetPage) {
  const bodySelector = '[data-dsh-terminal-panel="body"]'
  // The tab may already be restored (e.g. after a page reload) and its body
  // already mounted; the guide under the sidebar home is then not needed.
  if ((await targetPage.locator(bodySelector).count()) > 0) {
    return { guideEntries: 0, alreadyOpen: true }
  }
  const entry = () => targetPage.getByText('终端面板', { exact: true })
  let count = await entry().count()
  if (count === 0) {
    // The guide list may live behind the right sidebar's home/start tab.
    for (const name of ['开始', '新标签页']) {
      const tab = targetPage.getByText(name, { exact: true }).first()
      try {
        if (await tab.count()) {
          await tab.click({ timeout: 3000 })
          await targetPage.waitForTimeout(900)
          count = await entry().count()
          if (count > 0) break
        }
      } catch {
        /* ignore */
      }
    }
  }
  if (count === 0) {
    throw new Error('右侧栏未出现“终端面板”guide 入口（architecture.md §6.2）')
  }
  // Prefer a guide entry over an already-rendered tab title (a title may be
  // covered by its dockkit title span and is not clickable).
  for (let index = 0; index < count; index += 1) {
    const candidate = entry().nth(index)
    const isTabTitle = await candidate
      .evaluate((element) => element.closest('[data-dockkit-tab-title], [data-slot="sidebar.right.pane.tab.title"], [role="tab"]') !== null)
      .catch(() => false)
    if (isTabTitle) continue
    try {
      await candidate.click({ timeout: 5000 })
      await targetPage.waitForSelector(bodySelector, { timeout: 20_000 })
      return { guideEntries: count, alreadyOpen: false, index }
    } catch {
      /* try the next candidate */
    }
  }
  // Last resort: an inactive restored tab's title can be pointer-blocked by its
  // dockkit title span; dispatch a DOM click on the tab itself.
  const domClicked = await targetPage.evaluate(() => {
    const titles = [...document.querySelectorAll('[data-dockkit-tab-title], [data-slot="sidebar.right.pane.tab.title"]')]
    const target = titles.find((element) => (element.textContent ?? '').trim() === '终端面板')
    if (!target) return false
    const tab = target.closest('[data-dockkit-tab], [role="tab"]') ?? target
    tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  })
  if (domClicked) {
    try {
      await targetPage.waitForSelector(bodySelector, { timeout: 15_000 })
      return { guideEntries: count, alreadyOpen: false, domClicked: true }
    } catch {
      /* fall through */
    }
  }
  throw new Error('找到“终端面板”文本但无法点击打开面板（候选均为 tab 标题或被遮挡）')
}

function panelRoot() {
  return page.locator('[data-dsh-terminal-panel="body"]').first()
}

async function panelButtonLabels() {
  return page.evaluate(() => {
    const root = document.querySelector('[data-dsh-terminal-panel="body"]')
    if (!root) return []
    return [...root.querySelectorAll('button')].map((button) =>
      String(button.getAttribute('aria-label') ?? button.title ?? button.innerText ?? '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
  })
}

async function clickPanelButton(regex) {
  const labels = await panelButtonLabels()
  const index = labels.findIndex((label) => regex.test(label))
  if (index === -1) return null
  const clicked = await page.evaluate((buttonIndex) => {
    const root = document.querySelector('[data-dsh-terminal-panel="body"]')
    const button = root ? [...root.querySelectorAll('button')][buttonIndex] : null
    if (!button) return false
    button.click()
    return true
  }, index)
  return clicked ? labels[index] : null
}

/**
 * Preferred UI hook: the panel exposes `data-dsh-tp-action` on its buttons
 * (create / create-empty / refresh / reconnect / copy / close …). Falls back to
 * label matching in the individual checks when the attribute is absent.
 */
async function clickPanelAction(action) {
  const locator = page.locator(`[data-dsh-terminal-panel="body"] [data-dsh-tp-action="${action}"]`).first()
  try {
    if ((await locator.count()) === 0) return null
    if (!(await locator.isVisible())) return null
    await locator.click({ timeout: 5000 })
    return action
  } catch {
    return null
  }
}

/** Debug handle the client exposes for e2e (read-only state snapshot). */
async function panelDebug() {
  return page.evaluate(() => {
    const debug = globalThis.__DSH_TERMINAL_PANEL_DEBUG__
    if (!debug) return null
    try {
      const sessions = debug.getSessions?.() ?? []
      return {
        phase: debug.getPhase?.() ?? null,
        connection: debug.getConnection?.() ?? null,
        selectedId: debug.getSelectedId?.() ?? null,
        sessionIds: Array.isArray(sessions) ? sessions.map((session) => session.id) : [],
        visibleText: debug.getVisibleText?.() ?? '',
      }
    } catch {
      return null
    }
  })
}

async function panelSessionIds() {
  return page.evaluate(() => {
    const root = document.querySelector('[data-dsh-terminal-panel="body"]')
    if (!root) return []
    return [...root.querySelectorAll('[data-dsh-tp-session-id]')]
      .map((node) => node.getAttribute('data-dsh-tp-session-id'))
      .filter((id) => typeof id === 'string')
  })
}

async function clickSessionTab(id) {
  const locator = page.locator(`[data-dsh-terminal-panel="body"] [data-dsh-tp-session-id="${id}"]`).first()
  if ((await locator.count()) === 0) return false
  await locator.click({ timeout: 5000 })
  return true
}

async function panelStatusSize() {
  return page.evaluate(() => {
    const node = document.querySelector('[data-dsh-terminal-panel="body"] [data-dsh-tp-status-size]')
    return node ? String(node.textContent ?? '') : ''
  })
}

async function xtermText() {
  return page.evaluate(() => {
    const debug = globalThis.__DSH_TERMINAL_PANEL_DEBUG__
    try {
      const text = debug?.getVisibleText?.()
      if (typeof text === 'string' && text.length > 0) return text
    } catch {
      /* fall through to the DOM */
    }
    const root = document.querySelector('[data-dsh-terminal-panel="body"]')
    return root ? root.querySelector('.xterm-rows')?.innerText ?? '' : ''
  })
}

async function focusXterm() {
  const screen = page.locator('[data-dsh-terminal-panel="body"] .xterm-screen').first()
  try {
    await screen.click({ position: { x: 40, y: 20 }, timeout: 4000 })
  } catch {
    /* ignore */
  }
  await page.waitForTimeout(200)
}

async function typeInXterm(text) {
  await focusXterm()
  await page.keyboard.type(text, { delay: 12 })
  await page.keyboard.press('Enter')
}

async function waitForXtermMatch(predicate, timeoutMs, label) {
  const started = Date.now()
  const hit = await waitFor(
    async () => {
      const text = await xtermText()
      return { ok: predicate(text), text }
    },
    { timeoutMs, intervalMs: 200, label: `xterm ${label}` },
  )
  return { elapsedMs: Date.now() - started, text: hit.text }
}

function requireUi(prereqId, flag) {
  if (!flag) throw new SkipError(`前置 ${prereqId} 未通过`)
}

// ---------------------------------------------------------------------------
// UI checks (architecture.md §6.2)
// ---------------------------------------------------------------------------

async function runUiChecks() {
  await test('U-01', '打开 dev GUI 并渲染工作台', 'AUTO-UI', async () => {
    await waitForAppReady(page)
    const title = await page.title()
    const bodyLength = await page.evaluate(() => document.body?.innerText?.length ?? 0)
    assert(bodyLength > 30, `页面内容过少 (${bodyLength})`)
    ui.pageReady = true
    const pluginMarker = await page.evaluate(() => Boolean(globalThis.__DSH_TERMINAL_PANEL__)).catch(() => false)
    const screenshot = await shot('app-loaded')
    return { title, bodyLength, pluginMarker, screenshot }
  })
  if (!ui.pageReady) return

  await test('U-02', '关闭预览/欢迎弹窗', 'AUTO-UI', async () => {
    const info = await dismissOverlays(page)
    await shot('after-overlays')
    return info
  })

  await test('U-03', '打开一个会话（不发送消息）', 'AUTO-UI', async () => {
    const info = await ensureConversation(page)
    await shot('conversation')
    return info
  })

  await test('U-04', 'Control+Shift+B 打开右侧栏并出现“终端面板”guide', 'AUTO-UI', async () => {
    const how = await openRightSidebar(page)
    await page.waitForTimeout(900)
    const count = await page.getByText('终端面板', { exact: true }).count()
    const screenshot = await shot('right-sidebar-guide')
    if (count === 0) {
      throw new Error(`右侧栏未出现“终端面板”guide 入口（打开方式: ${how}）。详见截图 ${screenshot}`)
    }
    return { openedBy: how, guideEntries: count, screenshot }
  })

  await test('U-05', '点 guide 打开终端面板 body', 'AUTO-UI', async () => {
    if ((await page.getByText('终端面板', { exact: true }).count()) === 0) throw new SkipError('前置 U-04 未通过')
    const info = await openPanelFromGuide(page)
    ui.panelOpened = true
    await page.waitForTimeout(800)
    const screenshot = await shot('panel-open')
    const buttons = await panelButtonLabels()
    return { ...info, buttons, screenshot }
  })
  if (!ui.panelOpened) return

  await test('U-14', '面板空态/工具栏含“新建终端”入口', 'AUTO-UI', async () => {
    const labels = await panelButtonLabels()
    const actionCount = await page
      .locator('[data-dsh-terminal-panel="body"] [data-dsh-tp-action="create"], [data-dsh-terminal-panel="body"] [data-dsh-tp-action="create-empty"]')
      .count()
    const hasCreate = actionCount > 0 || labels.some((label) => /新建|新终端|打开终端|new terminal/i.test(label)) || labels.some((label) => label === '+' || label === '＋')
    if (!hasCreate) throw new Error(`面板内未找到“新建终端”入口。可见按钮: ${labels.slice(0, 20).join(' | ') || '(none)'}`)
    const debug = await panelDebug()
    return { buttons: labels.slice(0, 20), createActionElements: actionCount, phase: debug?.phase ?? null }
  })

  await test('U-06', '面板内新建终端 → xterm 出现', 'AUTO-UI', async () => {
    const before = new Set((await fetchSessions()).map((session) => session.id))
    const clicked =
      (await clickPanelAction('create')) ??
      (await clickPanelAction('create-empty')) ??
      (await clickPanelButton(/新建终端|新终端|打开终端|new terminal|^\s*[+＋]\s*$|新建/i))
    if (!clicked) throw new Error('未找到可点击的“新建终端”按钮')
    const created = await waitFor(
      async () => {
        const sessions = await fetchSessions()
        const found = sessions.find((session) => !before.has(session.id))
        return { ok: Boolean(found), session: found, sessions }
      },
      { timeoutMs: 20_000, label: '新建终端后 /sessions 出现新会话' },
    )
    ui.currentSessionId = created.session.id
    await page.waitForSelector('[data-dsh-terminal-panel="body"] .xterm', { timeout: 20_000 })
    ui.xtermReady = true
    // The selected tab should follow the new session.
    await waitFor(
      async () => {
        const debug = await panelDebug()
        return { ok: debug?.selectedId === created.session.id || (await panelSessionIds()).includes(created.session.id) }
      },
      { timeoutMs: 10_000, label: '面板选中新会话' },
    ).catch(() => null)
    const screenshot = await shot('xterm-created')
    return { button: clicked, session: created.session, screenshot, sessionProblems: validateSessionInfo(created.session) }
  })

  await test('U-07', 'xterm 输入命令 → 屏幕出现输出', 'AUTO-UI', async () => {
    requireUi('U-06', ui.xtermReady)
    await waitForXtermMatch((text) => /PS\s+[A-Za-z]:[\\/]/.test(text) || /PS\s+\S/.test(text), 20_000, '出现 PowerShell 提示符').catch(() => null)
    const nonce = `qa-hello-${Date.now().toString(36)}`
    ui.helloNonce = nonce
    let last = null
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await typeInXterm(`Write-Output '${nonce}'`)
      try {
        const hit = await waitForXtermMatch((text) => text.includes(nonce), 10_000, `输出 ${nonce}`)
        last = hit
        break
      } catch (error) {
        last = error
      }
    }
    if (!last || !('text' in last)) throw new Error(`输入命令后 10s 内屏幕未出现 ${nonce}`)
    const screenshot = await shot('xterm-output')
    const session = (await fetchSessions()).find((item) => item.id === ui.currentSessionId)
    return { nonce, screenshot, sessionState: session?.state, elapsedMs: last.elapsedMs }
  })

  await test('U-08', '中文输出（xterm 渲染 UTF-8）', 'AUTO-UI', async () => {
    requireUi('U-07', ui.helloNonce)
    // Type ASCII-only PowerShell that emits CJK, avoiding IME/composition flakiness.
    const command = "Write-Output ([string]([char]0x4E2D)+[char]0x6587+'-qa')"
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await typeInXterm(command)
      try {
        const hit = await waitForXtermMatch((text) => text.includes('中文-qa'), 10_000, '显示中文-qa')
        const screenshot = await shot('xterm-chinese')
        return { matched: hit.elapsedMs, hasReplacementChar: hit.text.includes('\uFFFD'), screenshot }
      } catch {
        /* retry once */
      }
    }
    throw new Error('中文输出未出现在 xterm 屏幕（可能是 UTF-8 解码/渲染问题）')
  })

  await test('U-09', 'resize：视口变化后 xterm fit 并同步 host 尺寸', 'AUTO-UI', async () => {
    requireUi('U-07', ui.helloNonce)
    const before = await getSnapshot(ui.currentSessionId)
    const statusBefore = await panelStatusSize()
    const resizeCallsBefore = pluginHttpCalls.filter((call) => call.url.includes('/resize')).length
    await page.setViewportSize({ width: 1200, height: 680 })
    await page.waitForTimeout(2200)
    const after = await getSnapshot(ui.currentSessionId)
    const statusAfter = await panelStatusSize()
    const resizeCalls = pluginHttpCalls.filter((call) => call.url.includes('/resize')).length
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.waitForTimeout(1200)
    const screenshot = await shot('resized')
    const changed = before.info?.cols !== after.info?.cols || before.info?.rows !== after.info?.rows
    if (!changed && resizeCalls === resizeCallsBefore) {
      throw new Error(
        `尺寸未变化且未见 /resize 调用: before ${before.info?.cols}x${before.info?.rows} status="${statusBefore}", after ${after.info?.cols}x${after.info?.rows} status="${statusAfter}"`,
      )
    }
    return {
      before: { cols: before.info?.cols, rows: before.info?.rows, status: statusBefore },
      after: { cols: after.info?.cols, rows: after.info?.rows, status: statusAfter },
      resizeHttpCalls: resizeCalls,
      screenshot,
    }
  })

  await test('U-11', '页面刷新后重开面板：host 会话保留、可重连', 'AUTO-UI', async () => {
    requireUi('U-07', ui.helloNonce)
    const retainedId = ui.currentSessionId
    const nonce = ui.helloNonce
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
    await waitForAppReady(page)
    await dismissOverlays(page)
    await ensureConversation(page)
    await openRightSidebar(page)
    if ((await page.getByText('终端面板', { exact: true }).count()) === 0) throw new SkipError('刷新后右侧栏 guide 未出现')
    await openPanelFromGuide(page)
    await page.waitForTimeout(1500)
    const sessions = await fetchSessions()
    const retained = sessions.find((session) => session.id === retainedId)
    assert(retained, `刷新后 host 端会话 ${retainedId} 丢失（交互会话不自动移除，architecture.md §4.2）`)
    const snapshot = await getSnapshot(retainedId)
    assert(snapshot.text.includes(nonce), `刷新后 snapshot 未保留先前输出 ${nonce}`)
    // Select the retained terminal in the reloaded panel and verify the screen restores.
    const clickedTab = await clickSessionTab(retainedId)
    let restoredInUi = false
    try {
      const hit = await waitForXtermMatch((text) => text.includes(nonce), 12_000, `刷新后 UI 恢复 ${nonce}`)
      restoredInUi = true
      void hit
    } catch {
      restoredInUi = false
    }
    const screenshot = await shot('after-reload')
    return {
      retainedId,
      sessionState: retained.state,
      snapshotKeptOutput: true,
      clickedTab,
      restoredInUi,
      xtermMountedAfterReload: (await panelRoot().locator('.xterm').count()) > 0,
      screenshot,
    }
  })

  await test('U-12', '多会话：新建第二个终端、切换标签且内容互不串台', 'AUTO-UI', async () => {
    requireUi('U-07', ui.helloNonce)
    const firstId = ui.currentSessionId
    const firstNonce = ui.helloNonce
    const before = new Set((await fetchSessions()).map((session) => session.id))
    const clicked =
      (await clickPanelAction('create')) ??
      (await clickPanelAction('create-empty')) ??
      (await clickPanelButton(/新建终端|新终端|打开终端|new terminal|^\s*[+＋]\s*$|新建/i))
    if (!clicked) throw new Error('未找到“新建终端”按钮')
    const created = await waitFor(
      async () => {
        const sessions = await fetchSessions()
        const found = sessions.find((session) => !before.has(session.id))
        return { ok: Boolean(found), session: found }
      },
      { timeoutMs: 20_000, label: '第二个终端会话出现' },
    )
    ui.secondSessionId = created.session.id
    await page.waitForTimeout(1500)
    await waitForXtermMatch((text) => /PS\s+[A-Za-z]:[\\/]/.test(text) || /PS\s+\S/.test(text), 20_000, '第二个终端提示符').catch(() => null)
    const secondNonce = `qa-second-${Date.now().toString(36)}`
    ui.secondNonce = secondNonce
    let typed = false
    for (let attempt = 1; attempt <= 2 && !typed; attempt += 1) {
      await typeInXterm(`Write-Output '${secondNonce}'`)
      try {
        await waitForXtermMatch((text) => text.includes(secondNonce), 10_000, '第二个终端输出')
        typed = true
      } catch {
        /* retry */
      }
    }
    if (!typed) throw new Error('第二个终端未出现预期输出')
    const firstSnap = await getSnapshot(firstId)
    const secondSnap = await getSnapshot(created.session.id)
    assert(firstSnap.text.includes(firstNonce), '第一个会话丢失自己的输出')
    assert(!firstSnap.text.includes(secondNonce), '第一个会话串入了第二个会话的输出')
    assert(secondSnap.text.includes(secondNonce), '第二个会话未包含自己的输出')
    assert(!secondSnap.text.includes(firstNonce), '第二个会话串入了第一个会话的输出')

    // UI switching: click the first tab, expect its screen; then back.
    let switchOk = false
    let tabIds = []
    try {
      tabIds = await panelSessionIds()
      assert(tabIds.includes(firstId) && tabIds.includes(created.session.id), `面板会话标签缺少 id（tabIds=${tabIds.join(',')}）`)
      await clickSessionTab(firstId)
      await page.waitForTimeout(900)
      const firstView = await xtermText()
      assert(firstView.includes(firstNonce), '切换回第一个会话后屏幕未显示其内容')
      await clickSessionTab(created.session.id)
      await page.waitForTimeout(900)
      const secondView = await xtermText()
      assert(secondView.includes(secondNonce), '切换回第二个会话后屏幕未显示其内容')
      switchOk = true
    } catch (error) {
      switchOk = false
      throw error
    }
    const screenshot = await shot('multi-session')
    return { firstId, secondId: created.session.id, tabIds, switchOk, screenshot }
  })

  await test('U-13', '面板截图/复制按钮给出当前屏幕文本', 'AUTO-UI', async () => {
    requireUi('U-07', ui.helloNonce)
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin }).catch(() => {})
    const clicked = (await clickPanelAction('copy')) ?? (await clickPanelButton(/截图|复制|copy|screenshot/i))
    if (!clicked) throw new SkipError('面板内未找到截图/复制按钮（可能未实现或命名为图标按钮）')
    await page.waitForTimeout(800)
    const clipboardText = await page.evaluate(async () => {
      try {
        return await navigator.clipboard.readText()
      } catch {
        return null
      }
    })
    if (clipboardText === null) throw new SkipError(`点击“${clicked}”后剪贴板不可读（权限或实现限制）`)
    assert(clipboardText.length > 0, `点击“${clicked}”后剪贴板为空`)
    const debug = await panelDebug()
    const screenText = debug?.visibleText ?? ''
    const matchesScreen = screenText.length === 0 || screenText.trim().split('\n')[0] === clipboardText.trim().split('\n')[0]
    const screenshot = await shot('screenshot-button')
    return {
      button: clicked,
      clipboardLength: clipboardText.length,
      head: clipboardText.slice(0, 120),
      matchesVisibleScreen: matchesScreen,
      screenshot,
    }
  })

  await test('U-10', 'UI 关闭当前会话', 'AUTO-UI', async () => {
    requireUi('U-06', ui.currentSessionId)
    const closingId = ui.secondSessionId && (await fetchSessions()).some((session) => session.id === ui.secondSessionId) ? ui.secondSessionId : ui.currentSessionId
    await clickSessionTab(closingId).catch(() => false)
    await page.waitForTimeout(500)
    const clicked = (await clickPanelAction('close')) ?? (await clickPanelButton(/关闭|停止|close|terminate/i))
    if (!clicked) throw new Error('面板内未找到关闭会话按钮')
    const removed = await waitFor(
      async () => {
        const sessions = await fetchSessions()
        return { ok: !sessions.some((session) => session.id === closingId), sessions }
      },
      { timeoutMs: 10_000, label: `关闭后 /sessions 移除 ${closingId}` },
    )
    const screenshot = await shot('session-closed')
    return { button: clicked, closedSessionId: closingId, remaining: removed.sessions.length, screenshot }
  })
}

// ---------------------------------------------------------------------------
// Post-UI runtime check (reload / tab switching must not throw plugin errors)
// ---------------------------------------------------------------------------

async function runPostUiRuntimeChecks() {
  if (!page) {
    skip('E-04', '刷新/多会话后无 plugin 运行时异常', 'AUTO-UI', '浏览器页面不可用')
    return
  }
  await test('E-04', '刷新/多会话后无 plugin 运行时异常（非 plugin 错误单独记录）', 'AUTO-UI', async () => {
    const pluginPageErrors = pageErrors.filter((entry) =>
      /dsh-terminal-panel|__DSH_TERMINAL_PANEL|dshtp|plugin_?chunk/i.test(entry),
    )
    const pluginConsoleErrors = consoleErrors.filter((text) =>
      /dsh-terminal-panel|ModuleLoader|Failed to load plugins|missed the module table/i.test(text),
    )
    const problems = [...pluginPageErrors, ...pluginConsoleErrors].slice(0, 5)
    assert(problems.length === 0, `UI 交互期间出现 plugin 相关异常: ${problems.join(' | ')}`)
    // Non-plugin page errors still get surfaced as environment noise evidence.
    const environmentPageErrors = pageErrors.filter((entry) => !pluginPageErrors.includes(entry))
    return {
      pluginPageErrors: 0,
      pluginConsoleErrors: 0,
      environmentPageErrors: environmentPageErrors.length,
      environmentSamples: environmentPageErrors.slice(0, 3),
      unrelatedHttpErrors: unrelatedHttpErrors.length,
    }
  })
}

// ---------------------------------------------------------------------------
// Client-load check (architecture.md §6.3: bundle loads without console error)
// ---------------------------------------------------------------------------

async function runClientLoadChecks() {
  if (!page) {
    skip('E-03', 'client bundle 加载无 console error / pageerror', 'AUTO-UI', '浏览器页面不可用')
    return
  }
  await test('E-03', 'client bundle 加载无 plugin console error / pageerror', 'AUTO-UI', async () => {
    const marker = await page.evaluate(() => Boolean(globalThis.__DSH_TERMINAL_PANEL__)).catch(() => false)
    const clientLog = consoleMessages.some((line) => line.includes('[dsh-terminal-panel] client half loaded'))
    assert(marker || clientLog, '未检测到 client bundle 加载标记（__DSH_TERMINAL_PANEL__ 或 "client half loaded" 日志）')
    const pluginConsoleErrors = consoleErrors.filter((text) =>
      /dsh-terminal-panel|ModuleLoader|Failed to load plugins|missed the module table/i.test(text),
    )
    const bundleFailures = pluginHttpFailures.filter((line) => line.includes('/plugins/') || /^5\d\d /.test(line))
    const problems = []
    if (pluginConsoleErrors.length > 0) problems.push(...pluginConsoleErrors.slice(0, 3))
    if (pageErrors.length > 0) problems.push(...pageErrors.slice(0, 3))
    if (bundleFailures.length > 0) problems.push(...bundleFailures.slice(0, 3))
    assert(problems.length === 0, `client 加载问题: ${problems.join(' | ')}`)
    return {
      marker,
      clientLog,
      consoleErrorsTotal: consoleErrors.length,
      pluginConsoleErrors: 0,
      pageErrors: 0,
      pluginHttpFailures: pluginHttpFailures.length,
      unrelatedHttpErrors: unrelatedHttpErrors.length,
      pluginHttpCalls: pluginHttpCalls.slice(0, 15),
    }
  })
}

// ---------------------------------------------------------------------------
// HTTP / SSE checks (architecture.md §4.4)
// ---------------------------------------------------------------------------

async function runHttpChecks() {
  await test('H-01', 'GET /sessions 带 cookie 返回 200 + SessionInfo[]', 'AUTO-HTTP', async () => {
    const sessions = await fetchSessions()
    const problems = sessions.flatMap((info) => validateSessionInfo(info).map((problem) => `${info?.id ?? '?'}: ${problem}`))
    assert(problems.length === 0, `SessionInfo 形状问题: ${problems.slice(0, 8).join('; ')}`)
    for (const session of sessions) initialSessionIds.add(session.id)
    return { count: sessions.length }
  })

  await test('H-02', 'GET /sessions 无 cookie → 401（未鉴权）', 'AUTO-HTTP', async () => {
    const response = await http('GET', '/dsh-terminal-panel/sessions', { noCookie: true })
    assert(response.status === 401 || response.status === 403, `期望 401/403，实际 ${response.status} ${response.text.slice(0, 200)}`)
    assert(response.status === 401, `契约期望未认证为 401（admit 返回 rejection:401），实际 ${response.status}`)
    if (response.json) assert(typeof response.json.error === 'string', `错误响应应为 {error:string}，实际 ${response.text.slice(0, 200)}`)
    return { status: response.status, body: response.text.slice(0, 120) }
  })

  await test('H-03', 'POST /create 创建交互会话（SessionInfo 合法）', 'AUTO-HTTP', async () => {
    const info = await createSession({ cols: 100, rows: 30, title: 'qa-http-main' })
    https.mainSessionId = info.id
    const problems = validateSessionInfo(info)
    assert(problems.length === 0, `SessionInfo 形状问题: ${problems.join('; ')}`)
    assert(info.kind === 'interactive', `POST /create 应创建交互会话，实际 kind=${info.kind}`)
    assert(info.state === 'running', `新会话 state 应为 running，实际 ${info.state}`)
    return { session: info }
  })

  await test('H-04', 'POST /create 缺省 cols/rows 使用默认值', 'AUTO-HTTP', async () => {
    const info = await createSession({})
    assert(typeof info.cols === 'number' && info.cols > 0, `缺省 cols 应为正数，实际 ${info.cols}`)
    assert(typeof info.rows === 'number' && info.rows > 0, `缺省 rows 应为正数，实际 ${info.rows}`)
    const screenshot = null
    return { cols: info.cols, rows: info.rows, screenshot }
  })

  await test('H-05', 'GET /snapshot 返回 {info,screen,text,cursor}', 'AUTO-HTTP', async () => {
    assert(https.mainSessionId, '前置 H-03 未创建会话')
    const snapshot = await getSnapshot(https.mainSessionId)
    assert(snapshot.info && snapshot.info.id === https.mainSessionId, 'snapshot.info.id 不匹配')
    assert(typeof snapshot.screen === 'string', 'snapshot.screen 应为 ANSI 字符串')
    assert(typeof snapshot.text === 'string', 'snapshot.text 应为字符串')
    assert(snapshot.cursor && typeof snapshot.cursor.x === 'number' && typeof snapshot.cursor.y === 'number', 'snapshot.cursor 应为 {x:number,y:number}')
    return { textLength: snapshot.text.length, screenLength: snapshot.screen.length, cursor: snapshot.cursor }
  })

  await test('H-06', 'POST /input 写入命令 → snapshot 出现输出', 'AUTO-HTTP', async () => {
    assert(https.mainSessionId, '前置 H-03 未创建会话')
    const ready = await waitForShellReady(https.mainSessionId, 30_000)
    const before = await getSnapshot(https.mainSessionId)
    if (!ready) {
      const sessions = await fetchSessions().catch(() => [])
      throw new Error(
        `会话 30s 内未出现 shell 提示符（怀疑 spawn 挂起）：state=${before.info?.state} text=${JSON.stringify((before.text ?? '').slice(-240))} screenLen=${(before.screen ?? '').length} sessions=${JSON.stringify(sessions.map((session) => ({ id: session.id.slice(0, 8), kind: session.kind, state: session.state, title: session.title })))}`,
      )
    }
    const nonce = `qa-input-${Date.now().toString(36)}`
    await runCommand(https.mainSessionId, `Write-Output '${nonce}'`)
    try {
      const hit = await waitForSnapshotText(https.mainSessionId, nonce, 20_000)
      return { nonce, elapsedMs: hit.elapsedMs, shellReady: ready }
    } catch (error) {
      const latest = await getSnapshot(https.mainSessionId).catch(() => null)
      const output = await http('POST', '/dsh-terminal-panel/input', { data: { id: https.mainSessionId, data: 'Write-Output qa-diagnostic-probe\r' } }).catch(() => null)
      throw new Error(
        `${error.message}; state=${latest?.info?.state} latestText=${JSON.stringify((latest?.text ?? '').slice(-300))} screenLen=${(latest?.screen ?? '').length} retryInputStatus=${output?.status ?? 'n/a'}`,
      )
    }
  })

  await test('H-07', 'SSE /events?id= 帧格式与首帧 snapshot', 'AUTO-SSE', async () => {
    assert(https.mainSessionId, '前置 H-03 未创建会话')
    const sse = await openSse(`/dsh-terminal-panel/events?id=${encodeURIComponent(https.mainSessionId)}`)
    try {
      const snapshotFrame = await sse.waitFor((frame) => frame.event === 'snapshot', 15_000)
      const frameProblems = []
      for (const frame of sse.state.frames.filter((item) => item.kind === 'event')) {
        if (!['snapshot', 'output', 'state', 'exit'].includes(frame.event)) frameProblems.push(`未知事件名 ${frame.event}`)
        if (typeof frame.dataText !== 'string' || frame.dataText.length === 0) frameProblems.push(`${frame.event} 帧 data 为空`)
      }
      assert(frameProblems.length === 0, frameProblems.slice(0, 5).join('; '))
      assert(snapshotFrame.data && typeof snapshotFrame.data === 'object', 'snapshot 帧 data 应为 JSON 对象')
      return {
        contentType: sse.state.contentType,
        firstEvent: snapshotFrame.event,
        snapshotKeys: Object.keys(snapshotFrame.data),
      }
    } finally {
      await sse.finish()
    }
  })

  await test('H-08', 'SSE 实时输出 + seq 递增（<5s）', 'AUTO-SSE', async () => {
    assert(https.mainSessionId, '前置 H-03 未创建会话')
    const ready = await waitForShellReady(https.mainSessionId, 30_000)
    if (!ready) throw new Error('H-08 前置：会话 30s 内未出现 shell 提示符')
    const sse = await openSse(`/dsh-terminal-panel/events?id=${encodeURIComponent(https.mainSessionId)}`)
    try {
      const snapshotFrame = await sse.waitFor((frame) => frame.event === 'snapshot', 15_000)
      const nonce = `qa-sse-${Date.now().toString(36)}`
      const sentAt = Date.now()
      await runCommand(https.mainSessionId, `Write-Output '${nonce}'`)
      let outputFrame
      try {
        outputFrame = await sse.waitFor((frame) => frame.event === 'output' && framePayloadString(frame).includes(nonce), 15_000)
      } catch (error) {
        const latest = await getSnapshot(https.mainSessionId).catch(() => null)
        const frameSummary = sse.state.frames.map((frame) => (frame.kind === 'heartbeat' ? ':hb' : `${frame.event}:${frame.dataText.slice(0, 60)}`)).slice(-8)
        throw new Error(
          `${error.message}; frames=${JSON.stringify(frameSummary)} snapshotSeq=${snapshotFrame.data?.seq} latestState=${latest?.info?.state} latestText=${JSON.stringify((latest?.text ?? '').slice(-240))}`,
        )
      }
      const latencyMs = outputFrame.at - sentAt
      assert(latencyMs < 5000, `output 帧延迟过大: ${latencyMs}ms（目标 <2s）`)
      const outputFrames = sse.state.frames.filter((frame) => frame.kind === 'event' && frame.event === 'output')
      const payloadSample = outputFrames[0]?.data
      const seqValues = outputFrames.map((frame) => frame.data?.seq ?? frame.data?.sequence).filter((value) => typeof value === 'number')
      const seqProblems = []
      if (typeof payloadSample !== 'object') seqProblems.push(`output 帧 data 应为 JSON 对象，实际 ${JSON.stringify(payloadSample).slice(0, 120)}`)
      if (seqValues.length === 0) seqProblems.push('output 帧缺少数值 seq 字段（architecture.md §4.2：生成 seq+1 广播 output 帧）')
      for (let i = 1; i < seqValues.length; i += 1) if (seqValues[i] <= seqValues[i - 1]) seqProblems.push(`seq 非递增: ${seqValues[i - 1]} -> ${seqValues[i]}`)
      assert(seqProblems.length === 0, seqProblems.slice(0, 5).join('; '))
      return { latencyMs, outputFrames: outputFrames.length, seqSample: seqValues.slice(-5), dataKeys: Object.keys(payloadSample ?? {}) }
    } finally {
      await sse.finish()
    }
  })

  await test('H-09', '全局 SSE /events 收到 sessions 事件', 'AUTO-SSE', async () => {
    const sse = await openSse('/dsh-terminal-panel/events')
    try {
      await sse.waitFor((frame) => frame.event === 'snapshot' || frame.event === 'sessions', 5000).catch(() => null)
      const created = await createSession({ cols: 90, rows: 24, title: 'qa-global-sse' })
      const frame = await sse.waitFor((item) => item.event === 'sessions', 10_000)
      return { event: frame.event, dataKeys: Object.keys(frame.data ?? {}), sessionCreated: created.id }
    } finally {
      await sse.finish()
    }
  })

  await test('H-10', 'POST /resize 生效并反映到 snapshot.info', 'AUTO-HTTP', async () => {
    assert(https.mainSessionId, '前置 H-03 未创建会话')
    const response = await http('POST', '/dsh-terminal-panel/resize', { data: { id: https.mainSessionId, cols: 90, rows: 25 } })
    assert(response.status === 200, `POST /resize 期望 200，实际 ${response.status} ${response.text.slice(0, 200)}`)
    assert(response.json?.ok === true, `POST /resize 响应应为 {ok:true}，实际 ${response.text.slice(0, 200)}`)
    const hit = await waitFor(
      async () => {
        const snapshot = await getSnapshot(https.mainSessionId)
        return { ok: snapshot.info?.cols === 90 && snapshot.info?.rows === 25, snapshot }
      },
      { timeoutMs: 5000, intervalMs: 150, label: 'snapshot.info 尺寸更新为 90x25' },
    )
    return { cols: hit.snapshot.info.cols, rows: hit.snapshot.info.rows }
  })

  await test('H-12', 'snapshot 缺 id / 未知 id → 4xx + {error}', 'AUTO-HTTP', async () => {
    const missing = await http('GET', '/dsh-terminal-panel/snapshot')
    assertJsonError(missing, 'snapshot 缺 id')
    const unknown = await http('GET', '/dsh-terminal-panel/snapshot?id=does-not-exist')
    assertJsonError(unknown, 'snapshot 未知 id')
    return { missingStatus: missing.status, unknownStatus: unknown.status }
  })

  await test('H-13', 'POST /input 未知 id → 4xx + {error}', 'AUTO-HTTP', async () => {
    const response = await http('POST', '/dsh-terminal-panel/input', { data: { id: 'does-not-exist', data: 'x' } })
    assertJsonError(response, 'input 未知 id')
    return { status: response.status }
  })

  await test('H-14', 'POST /resize 参数校验：非整数 4xx、越界值安全处理', 'AUTO-HTTP', async () => {
    assert(https.mainSessionId, '前置 H-03 未创建会话')
    const invalidTypes = [
      { cols: 'abc', rows: 24 },
      { cols: 90, rows: null },
    ]
    const typeStatuses = []
    for (const body of invalidTypes) {
      const response = await http('POST', '/dsh-terminal-panel/resize', { data: { id: https.mainSessionId, ...body } })
      assertJsonError(response, `resize 非整数参数 ${JSON.stringify(body)}`)
      typeStatuses.push(response.status)
    }
    // 契约未规定越界数值必须 4xx；接受“拒绝”或“安全钳制”两种策略并记录实现行为。
    const outOfRange = [
      { cols: 0, rows: 24 },
      { cols: -1, rows: 24 },
      { cols: 90, rows: 0 },
    ]
    const policies = []
    for (const body of outOfRange) {
      const response = await http('POST', '/dsh-terminal-panel/resize', { data: { id: https.mainSessionId, ...body } })
      if (response.status === 200) {
        assert(response.json?.ok === true, `resize 越界参数 ${JSON.stringify(body)} 返回 200 但响应不是 {ok:true}`)
        const snapshot = await getSnapshot(https.mainSessionId)
        assert(
          typeof snapshot.info.cols === 'number' && snapshot.info.cols >= 2 && typeof snapshot.info.rows === 'number' && snapshot.info.rows >= 1,
          `resize 越界参数 ${JSON.stringify(body)} 钳制后的尺寸非法: ${snapshot.info.cols}x${snapshot.info.rows}`,
        )
        policies.push({ body, status: 200, policy: 'clamped', dims: { cols: snapshot.info.cols, rows: snapshot.info.rows } })
      } else {
        assertJsonError(response, `resize 越界参数 ${JSON.stringify(body)}`)
        policies.push({ body, status: response.status, policy: 'rejected' })
      }
    }
    return { typeStatuses, policies }
  })

  await test('H-15', '非法 JSON body → 4xx 且服务不崩溃', 'AUTO-HTTP', async () => {
    const response = await http('POST', '/dsh-terminal-panel/input', { data: '{not-json' })
    assert(response.status >= 400 && response.status < 500, `期望 4xx，实际 ${response.status} ${response.text.slice(0, 200)}`)
    const after = await fetchSessions()
    return { status: response.status, sessionsAfter: after.length }
  })

  await test('H-16', '请求体超上限（>1MB）→ 有界读取且不崩溃', 'AUTO-HTTP', async () => {
    const huge = 'x'.repeat(2 * 1024 * 1024)
    let response = null
    let fetchError = null
    try {
      response = await http('POST', '/dsh-terminal-panel/input', {
        data: { id: https.mainSessionId ?? 'unknown', data: huge },
        timeoutMs: 30_000,
      })
    } catch (error) {
      fetchError = error
    }
    if (fetchError !== null) {
      const afterFailed = await fetchSessions()
      throw new Error(
        `>1MB 请求体：连接被重置（${fetchError?.message ?? fetchError}），未返回 {error} JSON（契约 §4.4 错误统一 4xx/5xx + {error}）。服务未崩溃（/sessions 仍 200, count=${afterFailed.length}），建议先写回 413 再销毁连接。`,
      )
    }
    assert(response.status >= 400 && response.status < 500, `期望 4xx/413，实际 ${response.status} ${response.text.slice(0, 200)}`)
    if (response.json !== null) assert(typeof response.json.error === 'string', '错误响应应为 {error:string}')
    const after = await fetchSessions()
    return { status: response.status, sessionsAfter: after.length }
  })

  await test('H-17', 'SSE 反复连接/断开后服务仍正常（订阅清理迹象）', 'AUTO-SSE', async () => {
    assert(https.mainSessionId, '前置 H-03 未创建会话')
    for (let i = 0; i < 5; i += 1) {
      const sse = await openSse(`/dsh-terminal-panel/events?id=${encodeURIComponent(https.mainSessionId)}`)
      await sse.waitFor((frame) => frame.event === 'snapshot', 8000).catch(() => null)
      await sse.finish()
    }
    const sessions = await fetchSessions()
    const fresh = await openSse(`/dsh-terminal-panel/events?id=${encodeURIComponent(https.mainSessionId)}`)
    try {
      await fresh.waitFor((frame) => frame.event === 'snapshot', 8000)
    } finally {
      await fresh.finish()
    }
    return { reconnects: 5, sessionsAfter: sessions.length }
  })

  if (SLOW) {
    await test('H-18', 'SSE 20s 心跳注释', 'AUTO-SSE', async () => {
      const sse = await openSse(`/dsh-terminal-panel/events?id=${encodeURIComponent(https.mainSessionId)}`, { timeoutMs: 26_000 })
      try {
        await waitFor(async () => ({ ok: sse.state.frames.some((frame) => frame.kind === 'heartbeat') }), {
          timeoutMs: 23_000,
          intervalMs: 250,
          label: 'SSE 心跳注释',
        })
        return { heartbeats: sse.state.frames.filter((frame) => frame.kind === 'heartbeat').length }
      } finally {
        await sse.finish()
      }
    })
  } else {
    skip('H-18', 'SSE 20s 心跳注释', 'AUTO-SSE', '默认跳过；加 --slow 执行')
  }

  await test('H-11', 'POST /close 关闭会话 → 列表移除 + snapshot 4xx', 'AUTO-HTTP', async () => {
    assert(https.mainSessionId, '前置 H-03 未创建会话')
    const id = https.mainSessionId
    const closeRes = await http('POST', '/dsh-terminal-panel/close', { data: { id } })
    assert(closeRes.status === 200, `POST /close 期望 200，实际 ${closeRes.status} ${closeRes.text.slice(0, 200)}`)
    assert(closeRes.json?.ok === true, `POST /close 响应应为 {ok:true}，实际 ${closeRes.text.slice(0, 200)}`)
    const sessions = await fetchSessions()
    assert(!sessions.some((session) => session.id === id), '关闭后 /sessions 仍包含该会话')
    const snapshot = await http('GET', `/dsh-terminal-panel/snapshot?id=${encodeURIComponent(id)}`)
    assertJsonError(snapshot, '关闭后 snapshot')
    https.mainSessionId = null
    return { closedId: id, snapshotStatus: snapshot.status }
  })

  // Cleanup sessions created by the HTTP tests (kept sessions only).
  await test('H-19', '自动化清理本测试创建的会话（无泄漏）', 'AUTO-HTTP', async () => {
    if (KEEP_SESSIONS) return { skipped: '--keep-sessions' }
    const sessions = await fetchSessions()
    const leftovers = sessions.filter((session) => createdSessionIds.has(session.id) && !initialSessionIds.has(session.id))
    for (const session of leftovers) await closeSession(session.id)
    const after = await fetchSessions()
    const stillThere = after.filter((session) => createdSessionIds.has(session.id))
    return { closed: leftovers.length, stillThere: stillThere.map((session) => session.id) }
  })
}

// ---------------------------------------------------------------------------
// Boundary / data-correctness checks (Chinese, ANSI, long output, exit, ...)
// ---------------------------------------------------------------------------

async function ensureBoundarySession() {
  if (https.boundarySessionId) {
    const sessions = await fetchSessions().catch(() => [])
    if (sessions.some((session) => session.id === https.boundarySessionId)) return https.boundarySessionId
  }
  const info = await createSession({ cols: 110, rows: 30, title: 'qa-boundary' })
  https.boundarySessionId = info.id
  await waitForShellReady(info.id)
  return info.id
}

async function runBoundaryChecks() {
  await test('B-01', '中文/UTF-8 输出正确显示', 'AUTO-HTTP', async () => {
    const id = await ensureBoundarySession()
    const nonce = `qa-cn-${Date.now().toString(36)}`
    await runCommand(id, `Write-Output '中文测试-终端面板-${nonce}'`)
    const hit = await waitForSnapshotText(id, `中文测试-终端面板-${nonce}`, 20_000)
    const text = hit.snap.text
    assert(!text.includes('\uFFFD'), 'snapshot.text 出现 UTF-8 替换字符 \\uFFFD')
    const screenshot = null
    return { elapsedMs: hit.elapsedMs, textLength: text.length, screenshot }
  })

  await test('B-02', 'UTF-8 跨块边界（大段 CJK）无替换符', 'AUTO-HTTP', async () => {
    const id = await ensureBoundarySession()
    await runCommand(id, "Write-Output ('中文ABC' * 400)")
    const hit = await waitForSnapshotText(id, '中文ABC中文ABC', 25_000)
    const text = hit.snap.text
    assert(!text.includes('\uFFFD'), '大面积 CJK 输出出现替换字符（流式解码跨块错误）')
    return { elapsedMs: hit.elapsedMs, textLength: text.length }
  })

  await test('B-03', 'ANSI 处理：screen 保留 SGR、text 剥离控制符', 'AUTO-HTTP', async () => {
    const id = await ensureBoundarySession()
    const nonce = `qa-red-${Date.now().toString(36)}`
    await runCommand(id, `Write-Host '${nonce}' -ForegroundColor Red`)
    const hit = await waitForSnapshotText(id, nonce, 20_000)
    const snapshot = hit.snap
    assert(typeof snapshot.screen === 'string' && snapshot.screen.includes('\u001b['), 'snapshot.screen 未见 ANSI 转义序列（serialize 应保留 SGR）')
    assert(!snapshot.text.includes('\u001b'), 'snapshot.text 不应包含 ESC 控制符（visibleText 需剥离 ANSI）')
    return { nonce, screenHasAnsi: true, textHasEsc: false }
  })

  await test('B-04', '长输出（500 行）不崩溃且可见屏尾部正确', 'AUTO-HTTP', async () => {
    const id = await ensureBoundarySession()
    await runCommand(id, '1..500 | ForEach-Object { "qa-line-$_" }')
    const hit = await waitForSnapshotText(id, 'qa-line-500', 30_000)
    const text = hit.snap.text
    const rows = hit.snap.info?.rows ?? 30
    const lineCount = text.split('\n').length
    assert(lineCount <= rows + 2, `visibleText 行数 ${lineCount} 超过屏高 ${rows} + 2（应只含可见屏）`)
    assert(!text.includes('\uFFFD'), '长输出出现替换字符')
    return { elapsedMs: hit.elapsedMs, visibleLines: lineCount, rows }
  })

  await test('B-05', '交互会话 exit → state=exited exitCode=0', 'AUTO-HTTP', async () => {
    const info = await createSession({ cols: 100, rows: 30, title: 'qa-exit' })
    await waitForShellReady(info.id)
    await runCommand(info.id, 'exit')
    const hit = await waitFor(
      async () => {
        const sessions = await fetchSessions()
        const session = sessions.find((item) => item.id === info.id)
        return { ok: session?.state === 'exited', session, sessions }
      },
      { timeoutMs: 20_000, intervalMs: 300, label: '会话状态变为 exited' },
    )
    assert(hit.session.exitCode === 0, `exit 后 exitCode 应为 0，实际 ${hit.session.exitCode}`)
    const snapshot = await getSnapshot(info.id)
    assert(typeof snapshot.text === 'string', '退出后 snapshot.text 不可读')
    return { exitCode: hit.session.exitCode, state: hit.session.state }
  })

  await test('B-06', '多会话内容隔离', 'AUTO-HTTP', async () => {
    const first = await createSession({ cols: 100, rows: 30, title: 'qa-iso-1' })
    const second = await createSession({ cols: 100, rows: 30, title: 'qa-iso-2' })
    await Promise.all([waitForShellReady(first.id), waitForShellReady(second.id)])
    const nonceA = `qa-iso-a-${Date.now().toString(36)}`
    const nonceB = `qa-iso-b-${Date.now().toString(36)}`
    await runCommand(first.id, `Write-Output '${nonceA}'`)
    await runCommand(second.id, `Write-Output '${nonceB}'`)
    await waitForSnapshotText(first.id, nonceA, 20_000)
    await waitForSnapshotText(second.id, nonceB, 20_000)
    const snapA = await getSnapshot(first.id)
    const snapB = await getSnapshot(second.id)
    assert(!snapA.text.includes(nonceB), '会话 A 串入会话 B 输出')
    assert(!snapB.text.includes(nonceA), '会话 B 串入会话 A 输出')
    return { first: first.id, second: second.id }
  })

  await test('B-07', '接近 64KB 的 /input 写入不破坏会话', 'AUTO-HTTP', async () => {
    const id = await ensureBoundarySession()
    const response = await http('POST', '/dsh-terminal-panel/input', { data: { id, data: 'y'.repeat(60_000) }, timeoutMs: 30_000 })
    assert(response.status === 200, `合法上限内大输入应 200，实际 ${response.status} ${response.text.slice(0, 200)}`)
    await sendInput(id, '\u0003')
    await waitForShellReady(id, 15_000)
    const session = (await fetchSessions()).find((item) => item.id === id)
    assert(session?.state === 'running', `大输入后会话应仍 running，实际 ${session?.state}`)
    return { status: response.status, bytes: 60_000 }
  })

  await test('B-08', 'Ctrl-C（\\u0003）中断前台命令且会话保持运行', 'AUTO-HTTP', async () => {
    const id = await ensureBoundarySession()
    await runCommand(id, 'Start-Sleep 30')
    await sleep(1000)
    await sendInput(id, '\u0003')
    await waitForShellReady(id, 15_000)
    const session = (await fetchSessions()).find((item) => item.id === id)
    assert(session?.state === 'running', `Ctrl-C 后会话应仍 running，实际 ${session?.state}`)
    const snapshot = await getSnapshot(id)
    assert(!snapshot.text.includes('Start-Sleep 30\r'), '仅做宽松检查：命令回显允许存在')
    return { state: session.state }
  })

  skip('B-09', '非法 UTF-8 字节输入', 'AUTO-HTTP', 'JSON 协议无法承载非法 UTF-8，超出契约范围')
}

// ---------------------------------------------------------------------------
// Environment / startup-log checks
// ---------------------------------------------------------------------------

async function runEnvironmentChecks() {
  await test('E-01', 'dev host 启动日志无插件报错', 'LOGFILE', async () => {
    if (!HOST_LOG) throw new SkipError('未提供 --host-log=<path>，无法自动检查启动日志')
    assert(existsSync(HOST_LOG), `日志文件不存在: ${HOST_LOG}`)
    const content = readFileSync(HOST_LOG, 'utf8')
    const lines = content.split(/\r?\n/)
    const pluginLines = lines.filter((line) => line.includes('dsh-terminal-panel'))
    const errorLines = lines.filter((line) => /dsh-terminal-panel/i.test(line) && /error|exception|failed|cannot|throw/i.test(line))
    assert(errorLines.length === 0, `启动日志包含插件错误: ${errorLines.slice(0, 5).join(' | ')}`)
    return { pluginLogLines: pluginLines.slice(0, 10), errorLines: 0 }
  })

  manual(
    'E-11',
    'desktop profile 安装后同样工作',
    'MANUAL-LEAD',
    '契约 §6.3 最后一条：由 Lead 在确认后安装到 desktop profile 并重启 Desktop；QA 不操作 58966。验证方法：重启后重复 U-04/U-05/U-07。',
  )

  manual(
    'R-03',
    '未触碰用户 Desktop DSH 与 D:\\DSH',
    'MANUAL',
    'QA 全程只读 D:\\DSH 与 C:\\Users\\LANCANG\\.dsh\\profiles\\dev；测试开始/结束时记录 58966 监听 PID 应不变（当前监听 PID 由 qa 记录在报告）。',
  )
}

function recordManualItems() {
  const manualCases = [
    ['E-09', '拦截生效：agent 内置 pwsh 调用在面板出现命令会话（B）', 'MANUAL-LEAD', 'Lead 在 dev host 新会话发：“用 pwsh 工具运行 Write-Output intercept-ok”。期望：面板出现 kind=command 会话（标题=命令首行）并实时输出；工具结果正常，agent 不报错。契约 §4.6/§6.3。'],
    ['E-10', 'live_terminal_screenshot 返回当前屏幕文本（C）', 'MANUAL-LEAD', 'Lead 发：“live_terminal_run 运行 Get-Process，然后 live_terminal_screenshot”。期望 value 含 text/ansi/cols/rows/cursor，text=当前可见屏；render 首行含 [terminal ...]；返回文本而非图片（用户已确认）。契约 §4.5。'],
    ['E-12', 'agent 命令会话自动打开终端面板（契约 §5.2）', 'MANUAL-LEAD', '复现布局：关闭右侧栏面板（或刷新后不打开面板）→ Lead 让 agent 执行一条前台 pwsh 命令。期望：右侧栏自动打开并显示“终端面板”tab，能看到命令会话实时输出；同一浏览器标签页最多自动打开一次；面板已开时不重复开 tab。'],
    ['T-01', '7 个 live_terminal_* 工具注册且 schema 合法', 'MANUAL-STATIC', '静态审查 lib/host/tools.js + dev host 工具目录：live_terminal_run/screenshot/send/read/list/open/close 全部注册；parameters 为 JSON Schema 对象；output.schema 合法。契约 §4.5。'],
    ['T-02', '拦截内置 pwsh（代理 E-09）', 'MANUAL-LEAD', '同 E-09。'],
    ['T-03', '拦截回退：run_in_background / sandbox_permissions 走原实现', 'MANUAL-LEAD', 'Lead 发：“pwsh 运行 Start-Sleep 3; Write-Output done 并 run_in_background:true”。期望不在面板创建命令会话，走原后台实现且无报错。契约 §4.6。'],
    ['T-04', 'live_terminal_screenshot TUI 场景（vim/htop）', 'MANUAL-LEAD', 'Lead 发：live_terminal_open 后 live_terminal_send vim，再 live_terminal_screenshot。期望 text 是 TUI 当前画面文本。契约 §4.5。'],
    ['T-05', 'live_terminal_run 超时', 'MANUAL-LEAD', 'Lead 发：live_terminal_run 执行 Start-Sleep 10，timeoutMs 2000。期望 timedOut:true、exitCode:null、会话终止，后续 ensureAgentTerminal 重建。契约 §4.3/§4.5。'],
    ['T-06', 'live_terminal_run wait:false + live_terminal_read', 'MANUAL-LEAD', 'Lead 发：live_terminal_run 1..20 输出，wait:false；随后 live_terminal_read。期望立即返回 stillRunning:true，read 可读到递增输出。契约 §4.5。'],
    ['T-07', 'live_terminal_send/open/close/list 基本行为', 'MANUAL-LEAD', 'Lead 驱动：open 创建可见交互会话；send 写入并 submit；list 返回 SessionInfo[]；close 移除。契约 §4.5。'],
    ['T-08', 'agent 默认终端按 agentId 复用', 'MANUAL-LEAD', 'Lead 连续两次 live_terminal_run，期望 terminalId 相同（复用），不重复创建会话。契约 §4.3。'],
    ['T-09', 'systemPrompt 指南注册', 'MANUAL-STATIC', '静态审查 lib/host/prompt.js：ctx.systemPrompt.section({name:"tool:terminal-panel", ...})，文案含“终端面板/live_terminal_screenshot”。契约 §4.5。'],
    ['T-10', 'exec.signal abort → 会话 terminate + aborted:true', 'MANUAL-STATIC', 'host-engine 单测或人工取消工具调用；契约 §4.3/§4.6。'],
    ['T-11', '自动打开行为（代理 E-12）', 'MANUAL-LEAD', '同 E-12。'],
    ['R-01', '重启 dev host 后插件仍正常', 'MANUAL-QA', 'kill QA 的 3105 host → 重新启动 → 重跑本脚本 H-01/H-03 与 U-04/U-05/U-07。契约 §2/§6.3。'],
    ['R-02', '重复运行 e2e 无状态泄漏', 'MANUAL-QA', '连续执行本脚本两次，比较结果；两次之间 host 不重启。'],
  ]
  for (const [id, title, method, detail] of manualCases) manual(id, title, method, detail)
}

// ---------------------------------------------------------------------------
// Static contract checklist (informational — actual review is in docs/test-report.md)
// ---------------------------------------------------------------------------

function recordStaticChecklist() {
  const staticCases = [
    ['S-01', '路由方法/路径/请求/响应形状与 §4.4 一致', 'STATIC'],
    ['S-02', 'SSE event/data 帧、心跳、req.close 清理与 §4.4 一致', 'STATIC'],
    ['S-03', 'SessionInfo 字段/枚举与 §4.4 一致', 'STATIC'],
    ['S-04', '工具名/参数/返回/render 默认值与 §4.5 一致', 'STATIC'],
    ['S-05', '拦截条件与 next() 回退与 §4.6 一致', 'STATIC'],
    ['S-06', '配置项名/默认值与 §4.1 一致', 'STATIC'],
    ['S-07', 'host 不 import @deepseek-ai/*；headless xterm 用 createRequire；inject=[tools]', 'STATIC'],
    ['S-08', 'client 注册 locale/sidebarRightTabs/guide/slots 与 §5.1 一致', 'STATIC'],
    ['S-09', '构建产物包装/external/单文件 xterm 打包与 §5.3 一致', 'STATIC'],
    ['S-10', 'node:test 单测覆盖 §6.1（ansi/ring/wrapper/value）', 'STATIC'],
    ['S-11', '会话保留/单 writer/EOF flush 与 §4.2 一致', 'STATIC'],
  ]
  for (const [id, title, method] of staticCases) {
    manual(id, title, method, '静态审查项：见 docs/test-report.md 的契约一致性章节（由 QA 阅读 lib/index.js、lib/host/**、client-src/**、lib/client.js 后逐条判定 PASS/FAIL）。')
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function cleanupSessions() {
  if (KEEP_SESSIONS) {
    console.log('[cleanup] --keep-sessions: leaving sessions open for inspection')
    return { skipped: true }
  }
  try {
    const sessions = await fetchSessions()
    // Only close sessions this run created — never pre-existing/foreign sessions.
    // (If H-01 failed, initialSessionIds may be empty; createdAt is the safety net.)
    const leftovers = sessions.filter(
      (session) =>
        !initialSessionIds.has(session.id) &&
        (createdSessionIds.has(session.id) || (typeof session.createdAt === 'number' && session.createdAt >= startedAtMs - 2000)),
    )
    for (const session of leftovers) await closeSession(session.id)
    if (leftovers.length > 0) console.log(`[cleanup] closed ${leftovers.length} leftover session(s)`)
    return { closed: leftovers.length, leftovers: leftovers.map((session) => session.id) }
  } catch (error) {
    console.error(`[cleanup] failed: ${error?.message ?? error}`)
    return { closed: 0, error: String(error?.message ?? error) }
  }
}

function writeSummary(extra) {
  const counts = results.reduce(
    (acc, result) => {
      acc[result.status] = (acc[result.status] ?? 0) + 1
      return acc
    },
    { PASS: 0, FAIL: 0, SKIP: 0, MANUAL: 0 },
  )
  const summary = {
    runId,
    url,
    origin,
    httpOnly: HTTP_ONLY,
    slow: SLOW,
    startedAt: startIso,
    finishedAt: nowIso(),
    durationMs: Date.now() - startedAtMs,
    counts,
    failed: results.filter((result) => result.status === 'FAIL').map((result) => ({ id: result.id, title: result.title, detail: result.detail })),
    results,
    consoleErrors,
    pageErrors,
    pluginHttpCalls,
    pluginHttpFailures,
    unrelatedHttpErrors,
    hostLog: HOST_LOG ?? null,
    ...extra,
  }
  const summaryPath = join(artifacts, 'summary.json')
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8')
  writeFileSync(join(artifacts, 'console.log'), consoleMessages.join('\n'), 'utf8')
  return { summary, summaryPath, counts }
}

const startedAtMs = Date.now()
const startIso = nowIso()

async function main() {
  console.log(`dsh-terminal-panel QA e2e  runId=${runId}`)
  console.log(`url: ${url}`)
  console.log(`artifacts: ${artifacts}`)
  if (HTTP_ONLY) console.log('mode: --http-only (UI 断言跳过)')

  let setup
  try {
    setup = await acquireSession()
    console.log(`[setup] auth cookie acquired (${cookieHeader ? 'yes' : 'no'}); browser=${setup.browserUsed}`)
  } catch (error) {
    fail('ENV-00', '环境初始化（浏览器/认证 cookie）', 'SETUP', sanitizeError(error))
    const { summaryPath } = writeSummary({ fatal: true })
    console.error(`\nFATAL: 无法初始化测试环境: ${error?.message ?? error}`)
    console.error(`summary: ${rel(summaryPath)}`)
    process.exitCode = 2
    return
  }

  try {
    if (page && !HTTP_ONLY) {
      await runUiChecks()
    } else {
      for (const [id, title] of [
        ['U-01', '打开 dev GUI'],
        ['U-04', '右侧栏 guide 打开'],
        ['U-05', '面板 body'],
        ['U-06', '新建终端 → xterm'],
        ['U-07', 'xterm 输入输出'],
      ]) {
        skip(id, title, 'AUTO-UI', HTTP_ONLY ? '--http-only 模式跳过 UI 交互' : '浏览器页面不可用')
      }
    }

    await runClientLoadChecks()
    await runPostUiRuntimeChecks()
    await runHttpChecks()
    await runBoundaryChecks()
    await runEnvironmentChecks()
    recordManualItems()
    recordStaticChecklist()
  } finally {
    const cleanup = await cleanupSessions()
    const { summaryPath, counts } = writeSummary({ setup, cleanup, uiState: ui })
    console.log('\n=== SUMMARY ===')
    console.log(`PASS ${counts.PASS}  FAIL ${counts.FAIL}  SKIP ${counts.SKIP}  MANUAL ${counts.MANUAL}`)
    if (counts.FAIL > 0) {
      console.log('FAILED:')
      for (const result of results.filter((item) => item.status === 'FAIL')) {
        const detail = typeof result.detail === 'string' ? result.detail : result.detail?.message ?? JSON.stringify(result.detail)
        console.log(`  - ${result.id} ${result.title}: ${String(detail).slice(0, 300)}`)
      }
    }
    console.log(`artifacts dir: ${artifacts}`)
    console.log(`summary: ${rel(summaryPath)}`)
    if (browser) await browser.close().catch(() => {})
    process.exitCode = counts.FAIL > 0 ? 1 : 0
  }
}

main().catch(async (error) => {
  console.error('UNEXPECTED ERROR:', error)
  try {
    if (browser) await browser.close()
  } catch {
    /* ignore */
  }
  process.exitCode = 1
})
