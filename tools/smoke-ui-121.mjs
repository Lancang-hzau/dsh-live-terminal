#!/usr/bin/env node
/**
 * real-guest smoke check (1.2.x) (Playwright + a running dev host).
 *
 * Usage: node tools/smoke-ui-121.mjs "<url-with-token>"
 *
 * Focuses on the new compact chrome and the operations that are easiest to
 * break while refactoring: panel mount, create, input, menu/dialogs, search,
 * plus host API readiness (/config, /ping, /history). Artifacts land in
 * tools/artifacts/smoke-121-*.png.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
const artifacts = join(here, 'artifacts')
mkdirSync(artifacts, { recursive: true })

const url = process.argv[2]
if (!url) {
  console.error('usage: node tools/smoke-ui-121.mjs <url-with-token>')
  process.exit(2)
}

const browserPath = process.env.DSH_TEST_BROWSER ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((candidate) => existsSync(candidate))
const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
function skip(name, detail = '') {
  console.log(`SKIP  ${name}${detail ? `  — ${detail}` : ''}`)
  results.push({ name, skipped: true, detail })
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function screenshot(page, name) {
  await page.screenshot({ path: join(artifacts, `smoke-121-${name}.png`) }).catch(() => {})
}
async function dismissOverlays(page) {
  for (const label of ['继续', '继续使用', '我知道了', '知道啦', '关闭', 'Continue', 'Got it']) {
    const button = page.getByRole('button', { name: label, exact: true })
    if (await button.count()) {
      await button.first().click().catch(() => {})
      await wait(400)
    }
  }
}

const browser = await chromium.launch({ executablePath: browserPath, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const consoleErrors = []
const pageErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => pageErrors.push(String(error)))

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => Boolean(globalThis.__DSH_TERMINAL_PANEL__), undefined, { timeout: 30_000 })
  record('client bundle loaded', true, await page.evaluate(() => JSON.stringify(globalThis.__DSH_TERMINAL_PANEL_CLIENT__)))
  await wait(3000)
  await dismissOverlays(page)

  // Host API readiness from the page origin (same-origin cookie auth).
  const host = await page.evaluate(async () => {
    const read = async (path) => {
      const response = await fetch(`/dsh-terminal-panel${path}`, { credentials: 'same-origin' })
      return { status: response.status, body: await response.json().catch(() => null) }
    }
    return { ping: await read('/ping'), config: await read('/config'), history: await read('/history?limit=5') }
  })
  record('/ping reports 1.3.0', host.ping.status === 200 && host.ping.body?.version === '1.3.0', JSON.stringify(host.ping.body))
  record('/config returns effective values', host.config.status === 200 && host.config.body?.config?.interceptMinVisibleMs === 1500 && host.config.body?.config?.autoCloseCommandDelayMs === 8000, JSON.stringify(host.config.body?.config ?? null))
  record('/history returns entries array', host.history.status === 200 && Array.isArray(host.history.body?.entries), `entries=${host.history.body?.entries?.length}`)

  // Open a conversation so the right sidebar exists, then the guide entry.
  const treeitem = page.locator('[role="treeitem"][data-row-key^="session:"]').first()
  if (await treeitem.count()) {
    await treeitem.click().catch(() => {})
  } else {
    const newSession = page.getByRole('button', { name: '新建会话', exact: true }).first()
    if (await newSession.count()) await newSession.click().catch(() => {})
  }
  await wait(2500)
  await page.keyboard.press('Control+Shift+B')
  await wait(2000)
  await screenshot(page, '01-sidebar')

  const guide = page.getByText('打开可见终端面板', { exact: true }).first()
  if (await guide.count()) {
    await guide.click().catch(() => {})
    await wait(2000)
  }
  const body = page.locator('[data-dsh-terminal-panel="body"]')
  record('panel body mounted', (await body.count()) > 0, `bodies=${await body.count()}`)
  if ((await body.count()) === 0) {
    skip('remaining UI flow', 'panel body did not mount')
  } else {
    await screenshot(page, '02-panel')
    const chrome = page.locator('.dshtp-chrome')
    const chromeHeight = chrome.count() ? await chrome.first().evaluate((element) => Math.round(element.getBoundingClientRect().height)) : -1
    record('compact chrome is <= 40px', chromeHeight > 0 && chromeHeight <= 40, `${chromeHeight}px`)

    const create = page.locator('[data-dsh-tp-action="create"]').first()
    record('create action present', (await create.count()) > 0)
    if (await create.count()) await create.click()
    const xterm = page.locator('.dshtp-screen .xterm')
    const xtermVisible = await xterm.count() > 0 || (await page.waitForTimeout(1500), (await page.locator('.dshtp-screen .xterm').count()) > 0)
    record('new terminal renders xterm', xtermVisible)
    if (xtermVisible) {
      await page.locator('.dshtp-screen').click().catch(() => {})
      await page.locator('.xterm-helper-textarea').pressSequentially("Write-Output 'smoke-121'", { delay: 10 }).catch(() => {})
      await page.keyboard.press('Enter')
      await wait(1500)
      const text = await page.evaluate(async () => {
        const sessions = await (await fetch('/dsh-terminal-panel/sessions', { credentials: 'same-origin' })).json()
        const list = Array.isArray(sessions.sessions) ? sessions.sessions.slice().reverse() : []
        for (const session of list) {
          const snapshot = await (await fetch(`/dsh-terminal-panel/snapshot?id=${encodeURIComponent(session.id)}`, { credentials: 'same-origin' })).json()
          if (String(snapshot.text ?? '').includes('smoke-121')) return snapshot.text
        }
        return list.length > 0 ? `checked ${list.length} sessions` : ''
      })
      record('terminal output reaches the host screen', String(text).includes('smoke-121'), String(text).slice(-120))
    }

    // Focus mode: the terminal should grow from the sidebar width to a wide
    // overlay and collapse back without losing the session.
    const root = page.locator('.dshtp-root').first()
    const widthBefore = await root.evaluate((el) => Math.round(el.getBoundingClientRect().width)).catch(() => 0)
    const expandButton = page.locator('[data-dsh-tp-action="expand"]').first()
    if (await expandButton.count()) {
      await expandButton.click().catch(() => {})
      await wait(900)
      const expanded = await root.evaluate((el) => ({
        expanded: el.getAttribute('data-expanded'),
        width: Math.round(el.getBoundingClientRect().width),
      }))
      record('focus mode expands the terminal', expanded.expanded === 'true' && expanded.width > widthBefore * 1.5, `${widthBefore}px -> ${expanded.width}px`)
      await screenshot(page, '04-focus-mode')
      const collapse = page.locator('[data-dsh-tp-action="collapse"]').first()
      if (await collapse.count()) await collapse.click().catch(() => {})
      await wait(700)
      const collapsed = await root.evaluate((el) => el.getAttribute('data-expanded')).catch(() => 'unknown')
      record('focus mode collapses back to the sidebar', collapsed === 'false', `expanded=${collapsed}`)
    } else {
      skip('focus mode', 'no expand button')
    }

    // More menu opens, contains history/config, and closes with Escape.
    const more = page.locator('[data-dsh-tp-action="more"]').first()
    if (await more.count()) {
      await more.click().catch(() => {})
      await wait(300)
      const menu = page.locator('.dshtp-menu')
      const menuVisible = (await menu.count()) > 0
      record('more menu opens', menuVisible)
      if (menuVisible) {
        const menuText = await menu.first().innerText().catch(() => '')
        record('more menu exposes history/config/shortcuts', /历史|History/.test(menuText) && /配置|设置|Settings/.test(menuText) && /快捷键|Shortcuts/.test(menuText), menuText.replace(/\s+/g, ' ').slice(0, 160))
        await page.keyboard.press('Escape')
        await wait(250)
      }
    } else {
      skip('more menu', 'no more button')
    }

    // Search bar via Ctrl+F.
    await page.locator('.dshtp-screen').click().catch(() => {})
    await page.keyboard.press('Control+f')
    await wait(300)
    const searchBar = page.locator('.dshtp-search-bar')
    record('Ctrl+F opens the search bar', (await searchBar.count()) > 0)
    if (await searchBar.count()) {
      await page.locator('.dshtp-search-bar input').fill('smoke')
      await page.locator('.dshtp-search-bar input').press('Enter')
      await wait(500)
      const resultText = await searchBar.first().innerText().catch(() => '')
      record('search reports a result', /\d+\s*\/\s*\d+/.test(resultText), resultText.replace(/\s+/g, ' ').slice(0, 120))
      await page.keyboard.press('Escape')
    }

    // Config dialog via the more menu.
    if (await more.count()) {
      await more.click().catch(() => {})
      await wait(250)
      const configItem = page.locator('.dshtp-menu-item', { hasText: /配置|Configuration/ }).first()
      if (await configItem.count()) {
        await configItem.click().catch(() => {})
        await wait(1200)
        const dialog = page.locator('.dshtp-dialog')
        const dialogText = (await dialog.count()) ? await dialog.first().innerText().catch(() => '') : ''
        record('config dialog shows effective values', /1500|8000|30000/.test(dialogText), dialogText.replace(/\s+/g, ' ').slice(0, 200))
        await page.keyboard.press('Escape')
      } else {
        skip('config dialog', 'no settings menu item')
      }
    }
    await screenshot(page, '03-final')
  }

  record('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  record('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
} finally {
  await browser.close().catch(() => {})
}

const failed = results.filter((entry) => !entry.skipped && !entry.ok)
console.log(`\n${results.filter((entry) => !entry.skipped && entry.ok).length} pass / ${failed.length} fail / ${results.filter((entry) => entry.skipped).length} skip`)
process.exitCode = failed.length === 0 ? 0 : 1
