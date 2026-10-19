/**
 * Lead integration test C (redesigned tools): real DSH agent calling
 * `live_terminal_run` and `live_terminal_screenshot` in the dev host.
 *
 * Expectation after the task-4 redesign:
 *  - `live_terminal_run` creates its own visible command session and renders
 *    `[terminal <id>] <title> ...` so the model can pass the id to screenshot;
 *  - `live_terminal_screenshot` works with or without terminalId and returns
 *    the clean visible screen text (no wrapper marker noise).
 *
 * Makes model requests in the dev host only.
 *
 * Usage: node tools/lead-tool-test.mjs "<dev-host-url-with-token>"
 */

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
const artifacts = join(here, 'artifacts')
mkdirSync(artifacts, { recursive: true })
const candidates = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]
const browserPath = process.env.DSH_TEST_BROWSER ?? candidates.find((p) => existsSync(p))
const url = process.argv[2]
if (!url) throw new Error('usage: node tools/lead-tool-test.mjs <url-with-token>')

const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
const consoleErrors = []
page.on('pageerror', (e) => consoleErrors.push(String(e)))
page.on('response', (res) => {
  if (res.status() >= 400) consoleErrors.push(`HTTP ${res.status()} ${res.url()}`)
})

const listSessions = async () => {
  const res = await page.evaluate(async () => {
    const r = await fetch('/dsh-terminal-panel/sessions', { credentials: 'same-origin' })
    return r.json()
  })
  return res.sessions ?? []
}

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(5000)
const cont = page.getByRole('button', { name: '继续', exact: true })
if (await cont.count()) {
  await cont.first().click()
  await page.waitForTimeout(500)
}
const newSession = page.getByRole('button', { name: '新建会话', exact: true }).first()
if (await newSession.count()) {
  await newSession.click()
  await page.waitForTimeout(3000)
}

let composer = page.locator('textarea').first()
if (!(await composer.count())) composer = page.locator('[contenteditable="true"]').first()
if (!(await composer.count())) {
  await page.screenshot({ path: join(artifacts, 'tool-test-no-composer.png') })
  throw new Error('composer not found')
}

const prompt = '请调用 live_terminal_run 工具（参数：{"command":"Get-Location; Get-Date; Write-Output screenshot-check","wait":true}），然后调用 live_terminal_screenshot 工具（参数 {} 即可），最后把 screenshot 返回的 text 字段原样贴在回复里（用代码块）。只做这两步，不要反问、不要做其他事。'
const tag = await composer.evaluate((el) => el.tagName.toLowerCase())
if (tag === 'textarea') {
  await composer.fill(prompt)
} else {
  await composer.click()
  await page.keyboard.type(prompt, { delay: 3 })
}
await page.keyboard.press('Enter')
console.log('[step] tool prompt sent')

const deadline = Date.now() + 180_000
let commandSession
let snapshotText = ''
let finalBody = ''
let screenshotResultSeen = false
while (Date.now() < deadline) {
  const sessions = await listSessions()
  commandSession = sessions
    .filter((s) => s.kind === 'command' && typeof s.command === 'string' && s.command.includes('screenshot-check'))
    .at(-1)
  if (commandSession) {
    snapshotText = await page.evaluate(async (id) => {
      const r = await fetch(`/dsh-terminal-panel/snapshot?id=${encodeURIComponent(id)}`, { credentials: 'same-origin' })
      const data = await r.json()
      return data.text ?? ''
    }, commandSession.id)
  }
  finalBody = await page.evaluate(() => document.body.innerText)
  if (/\[terminal\s+[0-9a-f-]{8,}/i.test(finalBody)) screenshotResultSeen = true
  if (commandSession && snapshotText.includes('screenshot-check') && screenshotResultSeen) {
    await page.waitForTimeout(3000)
    finalBody = await page.evaluate(() => document.body.innerText)
    break
  }
  await page.waitForTimeout(2000)
}

await page.screenshot({ path: join(artifacts, 'tool-test-final.png'), fullPage: false })
const sessions = await listSessions()
await browser.close()

console.log(JSON.stringify({
  url,
  commandSession: commandSession ? { id: commandSession.id, title: commandSession.title, state: commandSession.state, cwd: commandSession.cwd } : null,
  snapshotContainsCommandOutput: snapshotText.includes('screenshot-check'),
  snapshotContainsWrapperNoise: /__DSH_TERMINAL_PANEL_(START|END)/.test(snapshotText),
  snapshotTextHead: snapshotText.slice(0, 700),
  pageMentionsScreenshotRenderHeader: screenshotResultSeen,
  pageTail: finalBody.slice(-1800),
  sessions: sessions.map((s) => ({ id: s.id, kind: s.kind, owner: s.owner, title: s.title, state: s.state, cwd: s.cwd })),
  consoleErrors: consoleErrors.filter((line) => !line.includes('changes.summary')).slice(0, 20),
}, null, 2))
