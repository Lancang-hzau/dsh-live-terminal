/**
 * Acceptance probes run after the formal e2e (QA-owned, read/write via HTTP only).
 *
 * 1) Reload-noise attribution: does DSH's own page error
 *    ("TypeError: ... reading 'dimensions'") happen without the terminal panel
 *    ever being opened? Compares a reload-only scenario with a
 *    reload-with-panel-open scenario.
 * 2) Host cwd fix: POST /create with a DSH session id should open in that
 *    session's workspace (host-side fix); without a session id it falls back to
 *    the host launch directory. Also confirms the client currently does NOT send
 *    the session id (P2 residual).
 *
 * Usage: node qa/probes/acceptance-probes.mjs "<token-url>"
 */

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const artifacts = join(repoRoot, 'qa', 'artifacts', 'probes')
mkdirSync(artifacts, { recursive: true })

const url = process.argv[2]
if (!url || !/^https?:\/\//.test(url)) {
  console.error('usage: node qa/probes/acceptance-probes.mjs <token-url>')
  process.exit(2)
}
const origin = new URL(url).origin
const candidates = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]
const browserPath = process.env.DSH_TEST_BROWSER ?? candidates.find((candidate) => existsSync(candidate))
if (!browserPath) {
  console.error('no system Chrome found')
  process.exit(2)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const pageErrors = []
const consoleErrors = []

const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', (error) => pageErrors.push(String(error?.stack ?? error)))
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})

async function appReady() {
  await page.waitForFunction(() => (document.body?.innerText?.length ?? 0) > 30, null, { timeout: 40_000 })
  await sleep(1500)
}

async function dismissOverlay() {
  for (const name of ['继续', '进入', '开始使用', '知道了']) {
    const button = page.getByRole('button', { name, exact: true }).first()
    try {
      if ((await button.count()) > 0 && (await button.isVisible())) {
        await button.click({ timeout: 2000 })
        await sleep(400)
      }
    } catch {
      /* ignore */
    }
  }
}

function take(kind) {
  return pageErrors.filter((entry) => kind === 'all' || !entry.includes('__DSH_TERMINAL_PANEL')).length
}

async function reloadTwice(label) {
  const marks = []
  for (let index = 1; index <= 2; index += 1) {
    const before = pageErrors.length
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
    await appReady()
    await sleep(1200)
    marks.push({ reload: index, newPageErrors: pageErrors.slice(before).map((entry) => entry.split('\n')[0] + ' @ ' + (entry.split('\n')[1] ?? '').trim().slice(0, 110)) })
  }
  await page.screenshot({ path: join(artifacts, `reload-${label}.png`) }).catch(() => {})
  return marks
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await appReady()
  await dismissOverlay()
  const sessionTitle = process.env.DSH_QA_SESSION_TITLE ?? '大数据实验手册操作指导'
  const sessionLink = page.getByText(sessionTitle, { exact: true }).first()
  if ((await sessionLink.count()) > 0) {
    await sessionLink.click({ timeout: 4000 }).catch(() => {})
    await sleep(2500)
  }

  // Scenario A: reload only, terminal panel never opened.
  const scenarioA = await reloadTwice('without-panel')
  await page.screenshot({ path: join(artifacts, 'scenario-a-reload-without-panel.png') }).catch(() => {})

  // Scenario B: open the terminal panel, then reload twice.
  await page.keyboard.press('Control+Shift+B')
  await sleep(1500)
  const guide = page.getByText('终端面板', { exact: true })
  const guideCount = await guide.count()
  for (let index = 0; index < guideCount; index += 1) {
    const candidate = guide.nth(index)
    const isTabTitle = await candidate
      .evaluate((element) => element.closest('[data-dockkit-tab-title], [data-slot="sidebar.right.pane.tab.title"], [role="tab"]') !== null)
      .catch(() => false)
    if (isTabTitle) continue
    try {
      await candidate.click({ timeout: 4000 })
      break
    } catch {
      /* next */
    }
  }
  const panelOpened = await page
    .waitForSelector('[data-dsh-terminal-panel="body"]', { timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  const scenarioB = await reloadTwice('with-panel')

  // Host cwd probes (same-origin fetch with the browser cookie).
  const cwdProbe = await page.evaluate(async () => {
    const jsonFetch = async (path, init) => {
      const response = await fetch(path, { credentials: 'same-origin', ...init })
      const text = await response.text()
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
      return { status: response.status, json }
    }
    const sessionId = 'session-fbb8fd5d-72c6-404a-a9fe-2668d68f8512'
    const withSession = await jsonFetch('/dsh-terminal-panel/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cols: 80, rows: 24, sessionId }),
    })
    const withoutSession = await jsonFetch('/dsh-terminal-panel/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cols: 80, rows: 24 }),
    })
    const created = [withSession.json?.session?.id, withoutSession.json?.session?.id].filter(Boolean)
    for (const id of created) {
      await jsonFetch('/dsh-terminal-panel/close', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      })
    }
    return {
      withSessionId: { status: withSession.status, cwd: withSession.json?.session?.cwd, sessionId: withSession.json?.session?.sessionId },
      withoutSessionId: { status: withoutSession.status, cwd: withoutSession.json?.session?.cwd },
    }
  })

  const panelTypeErrors = pageErrors.filter((entry) => /dimensions/.test(entry))
  console.log(
    JSON.stringify(
      {
        origin,
        panelOpened,
        scenarioA,
        scenarioB,
        pageErrorCount: pageErrors.length,
        pageErrorFirstLines: pageErrors.map((entry) => entry.split('\n')[0]),
        pageErrorStacks: pageErrors.map((entry) => entry.split('\n').slice(0, 6)),
        dimensionsErrorSeen: panelTypeErrors.length,
        consoleErrors: consoleErrors.length,
        cwdProbe,
      },
      null,
      2,
    ),
  )
} finally {
  await browser.close().catch(() => {})
}
