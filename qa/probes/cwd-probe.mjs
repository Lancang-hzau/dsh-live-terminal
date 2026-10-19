/**
 * Focused probe for the "new terminal opens in the session workspace" P2 item.
 *
 * - Captures the live DSH session id from the GUI's own API requests.
 * - POST /create { sessionId }   -> does the host resolve the session cwd?
 * - POST /create { cwd }         -> does the explicit cwd path work?
 *
 * Usage: node qa/probes/cwd-probe.mjs "<token-url>"
 */

import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'

const url = process.argv[2]
if (!url || !/^https?:\/\//.test(url)) {
  console.error('usage: node qa/probes/cwd-probe.mjs <token-url>')
  process.exit(2)
}
const candidates = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]
const browserPath = process.env.DSH_TEST_BROWSER ?? candidates.find((candidate) => existsSync(candidate))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const page = await context.newPage()

const sessionIds = new Set()
page.on('request', (request) => {
  const found = request.url().match(/sessionId=(session-[0-9a-f-]{20,})/)
  if (found) sessionIds.add(found[1])
})

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => (document.body?.innerText?.length ?? 0) > 30, null, { timeout: 40_000 })
  await sleep(2000)
  for (const name of ['继续', '进入', '开始使用']) {
    const button = page.getByRole('button', { name, exact: true }).first()
    if ((await button.count()) > 0 && (await button.isVisible())) {
      await button.click().catch(() => {})
      await sleep(500)
    }
  }
  const title = process.env.DSH_QA_SESSION_TITLE ?? '大数据实验手册操作指导'
  const link = page.getByText(title, { exact: true }).first()
  if ((await link.count()) > 0) {
    await link.click({ timeout: 4000 }).catch(() => {})
    await sleep(3000)
  }
  const sessionId = [...sessionIds][0] ?? null

  const result = await page.evaluate(async (captured) => {
    const post = async (body) => {
      const response = await fetch('/dsh-terminal-panel/create', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const text = await response.text()
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
      return { status: response.status, cwd: json?.session?.cwd, id: json?.session?.id, sessionId: json?.session?.sessionId }
    }
    const withSessionId = captured ? await post({ cols: 80, rows: 24, sessionId: captured }) : null
    const withPrefixFreeId = captured ? await post({ cols: 80, rows: 24, sessionId: captured.replace(/^session-/, '') }) : null
    const withCwd = await post({ cols: 80, rows: 24, cwd: 'C:\\Users\\LANCANG\\Desktop\\Code\\BIG DATA' })
    const withoutAnything = await post({ cols: 80, rows: 24 })
    for (const item of [withSessionId, withPrefixFreeId, withCwd, withoutAnything]) {
      if (item?.id) {
        await fetch('/dsh-terminal-panel/close', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: item.id }),
        })
      }
    }
    return { withSessionId, withPrefixFreeId, withCwd, withoutAnything }
  }, sessionId)

  console.log(JSON.stringify({ capturedSessionId: sessionId, capturedCount: sessionIds.size, ...result }, null, 2))
} finally {
  await browser.close().catch(() => {})
}
