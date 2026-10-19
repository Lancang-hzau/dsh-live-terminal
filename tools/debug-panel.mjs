/**
 * Debug the rendered state of the terminal panel tab in a DSH Web GUI.
 * Usage: node tools/debug-panel.mjs <url-with-token>
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
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForTimeout(4500)
const cont = page.getByRole('button', { name: '继续', exact: true })
if (await cont.count()) { await cont.first().click(); await page.waitForTimeout(500) }
const sessionLink = page.getByText('大数据实验手册操作指导', { exact: true }).first()
if (await sessionLink.count()) { await sessionLink.click(); await page.waitForTimeout(2500) }
await page.keyboard.press('Control+Shift+B')
await page.waitForTimeout(1500)
const entry = page.getByText('终端面板', { exact: true }).first()
if (await entry.count()) { await entry.click(); await page.waitForTimeout(2500) }

const info = await page.evaluate(() => {
  const nodes = [...document.querySelectorAll('[data-dsh-terminal-panel="body"]')]
  const describe = (el) => {
    const rect = el.getBoundingClientRect()
    const chain = []
    let p = el
    for (let i = 0; i < 8 && p; i += 1) {
      chain.push({ tag: p.tagName, cls: String(p.className).slice(0, 80), aria: p.getAttribute?.('aria-label') ?? '', hidden: p.hidden ?? false, display: getComputedStyle(p).display, visibility: getComputedStyle(p).visibility, opacity: getComputedStyle(p).opacity, rect: (() => { const r = p.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] })() })
      p = p.parentElement
    }
    return { text: el.innerText, html: el.outerHTML.slice(0, 500), rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)], chain }
  }
  const tabBody = document.querySelector('[data-dockkit-tab]')?.closest('section,div')
  return {
    count: nodes.length,
    nodes: nodes.map(describe),
    rightbarHtml: (document.querySelector('[data-sidebar-right]')?.outerHTML ?? '').slice(0, 2000),
    paneCandidates: [...document.querySelectorAll('[class*="pane"], [class*="tab"]')].slice(0, 30).map((el) => ({ tag: el.tagName, cls: String(el.className).slice(0, 70), text: (el.innerText ?? '').slice(0, 40) })),
  }
})
console.log(JSON.stringify(info, null, 2))
await page.screenshot({ path: join(artifacts, 'debug-panel.png') })
await browser.close()
console.log('--- logs ---')
console.log(logs.join('\n'))
