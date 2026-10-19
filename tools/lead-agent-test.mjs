/**
 * Lead integration test: drive a real DSH agent in the dev host so that
 *
 *   1. a built-in `pwsh` tool call is intercepted into a visible command
 *      session (requirement B),
 *   2. `live_terminal_run` + `live_terminal_screenshot` work (requirement C),
 *   3. the terminal panel auto-opens in the right sidebar (client behavior).
 *
 * This DOES make model requests in the dev host session (deepseek-flash).
 * It never touches the user's Desktop DSH process.
 *
 * Usage: node tools/lead-agent-test.mjs "<dev-host-url-with-token>"
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
if (!url) throw new Error('usage: node tools/lead-agent-test.mjs <url-with-token>')

const logs = []
const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e}`))

const sessions = async () => {
  const res = await page.evaluate(async () => {
    const r = await fetch('/dsh-terminal-panel/sessions', { credentials: 'same-origin' })
    return r.json()
  })
  return res.sessions ?? []
}

const waitFor = async (predicate, timeoutMs, label) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true
    await page.waitForTimeout(1000)
  }
  console.log(`[timeout] ${label}`)
  return false
}

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(5000)
const cont = page.getByRole('button', { name: '继续', exact: true })
if (await cont.count()) {
  await cont.first().click()
  await page.waitForTimeout(500)
}

// Create a fresh session through the sidebar brand button (aria-label 新建会话).
const newSession = page.getByRole('button', { name: '新建会话', exact: true }).first()
if (await newSession.count()) {
  await newSession.click()
  await page.waitForTimeout(3000)
}
await page.screenshot({ path: join(artifacts, 'agent-test-01-new-session.png') })

const composer = page.locator('textarea').first()
if (!(await composer.count())) {
  // Fallback: contenteditable composer.
  const editable = page.locator('[contenteditable="true"]').first()
  await editable.click()
  await page.keyboard.type('请用 pwsh 工具执行命令：Write-Output intercept-ok。只执行这一条命令并把输出告诉我，不要做其他事。', { delay: 5 })
  await page.keyboard.press('Enter')
} else {
  await composer.click()
  await composer.fill('请用 pwsh 工具执行命令：Write-Output intercept-ok。只执行这一条命令并把输出告诉我，不要做其他事。')
  await page.keyboard.press('Enter')
}
console.log('[step] prompt 1 sent (pwsh intercept test)')

// Wait for the intercepted command session to appear.
const commandSession = await waitFor(async () => {
  const list = await sessions()
  return list.some((s) => s.kind === 'command' && typeof s.command === 'string' && s.command.includes('intercept-ok'))
}, 120_000, 'intercepted command session')
const listAfterRun = await sessions()
await page.waitForTimeout(3000)
await page.screenshot({ path: join(artifacts, 'agent-test-02-after-run.png') })
console.log(JSON.stringify({ commandSessionAppeared: commandSession, sessions: listAfterRun }, null, 2))

// Requirement C: live_terminal_run + live_terminal_screenshot through the agent.
const composer2 = page.locator('textarea').first()
const prompt2 = '请依次调用两个工具，不要多说话：1) live_terminal_run，参数 {"command":"Get-Location; Get-Date","wait":true}；2) live_terminal_screenshot，参数 {} 或 {"terminalId": 上一步返回的 terminalId}。把 screenshot 返回的 text 字段原样贴出来。'
if (await composer2.count()) {
  await composer2.fill(prompt2)
  await page.keyboard.press('Enter')
  console.log('[step] prompt 2 sent (tool test)')
  await page.waitForTimeout(45_000)
} else {
  console.log('[skip] composer not found for prompt 2')
}
const listAfterTools = await sessions()
const interactiveOrDefault = listAfterTools.filter((s) => s.kind === 'interactive')
const bodyText = await page.evaluate(() => document.body.innerText)
const hasScreenshotHeader = /\[terminal .*\]/.test(bodyText)
await page.screenshot({ path: join(artifacts, 'agent-test-03-tools.png') })
console.log(JSON.stringify({ interactiveSessions: interactiveOrDefault.length, hasScreenshotHeaderInPage: hasScreenshotHeader, sessions: listAfterTools.map((s) => ({ id: s.id, kind: s.kind, title: s.title, state: s.state })) }, null, 2))

await browser.close()
console.log('--- errors ---')
console.log(logs.filter((line) => line.startsWith('[pageerror]') || line.startsWith('[error]')).join('\n') || '(none)')
