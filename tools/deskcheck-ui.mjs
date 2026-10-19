/**
 * Deskcheck UI probe: confirm the plugin's client half loads and the right
 * sidebar guide entry exists in a profile that mirrors the Desktop bundle set
 * (dsh-better-display + dsh-context + dshmarket + our plugin).
 *
 * Usage: node tools/deskcheck-ui.mjs "<url-with-token>"
 */

import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'

const candidates = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]
const browserPath = process.env.DSH_TEST_BROWSER ?? candidates.find((p) => existsSync(p))
const url = process.argv[2]
if (!url) throw new Error('usage: node tools/deskcheck-ui.mjs <url-with-token>')

const logs = []
const errors = []
const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => errors.push(String(e)))
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(6000)
const cont = page.getByRole('button', { name: '继续', exact: true })
if (await cont.count()) {
  await cont.first().click()
  await page.waitForTimeout(600)
}
// Open an existing conversation so the session-scoped right sidebar exists.
const sessionLink = page.getByText('大数据实验手册操作指导', { exact: true }).first()
if (await sessionLink.count()) {
  await sessionLink.click()
  await page.waitForTimeout(2500)
}
await page.keyboard.press('Control+Shift+B')
await page.waitForTimeout(2000)
const result = await page.evaluate(() => ({
  marker: Boolean(globalThis.__DSH_TERMINAL_PANEL__),
  panelMentions: (document.body.innerText.match(/终端面板/g) ?? []).length,
  bodyHead: document.body.innerText.slice(0, 400),
}))
await browser.close()
console.log(JSON.stringify({
  marker: result.marker,
  guideEntryVisible: result.panelMentions > 0,
  pluginLog: logs.filter((line) => line.includes('dsh-live-terminal')),
  pageErrors: errors,
}, null, 2))
