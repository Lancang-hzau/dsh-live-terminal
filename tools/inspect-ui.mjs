/**
 * Exploratory UI inspector for the DSH Web GUI.
 * Usage: node tools/inspect-ui.mjs <url>
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

const logs = []
const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e}`))
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(5000)

const clickIf = async (locator) => {
  if (await locator.count()) { await locator.first().click(); return true }
  return false
}

await clickIf(page.getByRole('button', { name: '继续' }))
await page.waitForTimeout(500)

const buttons = async () => page.evaluate(() => [...document.querySelectorAll('button,[role="button"]')].map((el) => ({
  aria: el.getAttribute('aria-label') ?? '',
  text: (el.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 50),
})).filter((b) => b.aria || b.text))

// New session via the brand button / sidebar row.
let created = await clickIf(page.getByRole('button', { name: '新建会话', exact: true }))
if (!created) created = await clickIf(page.getByRole('button', { name: /新会话/ }))
await page.waitForTimeout(4000)
console.log('created session:', created)
console.log('buttons after session:', JSON.stringify(await buttons(), null, 1))
await page.screenshot({ path: join(artifacts, 'inspect-session.png'), fullPage: false })

// Try common right-sidebar expand aria labels.
for (const label of ['展开右侧栏', '展开右侧边栏', '右侧栏', '显示右侧栏', '展开侧栏']) {
  if (await clickIf(page.getByRole('button', { name: label }))) {
    console.log('opened right sidebar with:', label)
    break
  }
}
await page.waitForTimeout(2500)
console.log('buttons after sidebar:', JSON.stringify(await buttons(), null, 1))
console.log('body text:', (await page.evaluate(() => document.body.innerText)).slice(0, 1500))
await page.screenshot({ path: join(artifacts, 'inspect-sidebar.png'), fullPage: false })

await browser.close()
console.log('--- logs ---')
console.log(logs.join('\n'))
