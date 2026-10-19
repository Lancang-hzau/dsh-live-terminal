/**
 * End-to-end UI smoke test for the dsh-terminal-panel plugin in a DSH Web GUI.
 *
 * Usage: node tools/verify-ui.mjs <url-with-token>
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
if (!url) throw new Error('usage: node tools/verify-ui.mjs <url-with-token>')

const logs = []
const errors = []
const failed = []
const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => errors.push(`[pageerror] ${e}`))
page.on('response', (res) => {
  if (res.status() >= 400) failed.push(`${res.status()} ${res.url()}`)
})

const step = async (label) => {
  await page.screenshot({ path: join(artifacts, `e2e-${label}.png`) })
  console.log(`[step] ${label}`)
}

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(5000)

const cont = page.getByRole('button', { name: '继续', exact: true })
if (await cont.count()) {
  await cont.first().click()
  await page.waitForTimeout(600)
}

// Open an existing conversation from the session list.
const sessionLink = page.getByText('大数据实验手册操作指导', { exact: true }).first()
if (await sessionLink.count()) {
  await sessionLink.click()
  await page.waitForTimeout(3000)
}
await step('01-session')

// Toggle the right sidebar (web default: Ctrl+Shift+B).
await page.keyboard.press('Control+Shift+B')
await page.waitForTimeout(2000)
await step('02-right-sidebar')

const marker = await page.evaluate(() => Boolean(globalThis.__DSH_TERMINAL_PANEL__))
const guideVisible = await page.getByText('终端面板', { exact: true }).count()
console.log(JSON.stringify({ clientPluginLoaded: marker, guideEntryCount: guideVisible }, null, 2))

// Open our panel from the right-sidebar guide page.
const entry = page.getByText('终端面板', { exact: true }).first()
if (await entry.count()) {
  await entry.click()
  await page.waitForTimeout(3000)
}
await step('03-terminal-panel')
const bodyInfo = await page.evaluate(() => {
  const el = document.querySelector('[data-dsh-terminal-panel="body"]')
  return el ? el.innerText : null
})
console.log('panel body:', bodyInfo)

await browser.close()
console.log('--- failed responses ---')
console.log(failed.slice(0, 40).join('\n') || '(none)')
console.log('--- errors ---')
console.log(errors.join('\n') || '(none)')
console.log('--- logs ---')
console.log(logs.join('\n') || '(none)')
