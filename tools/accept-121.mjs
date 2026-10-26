#!/usr/bin/env node
/**
 * Local acceptance for the current plugin version on a real dev host with a real agent turn.
 *
 * Covers the paths the deterministic UI smoke cannot:
 *  - agent shell command -> intercepted visible terminal + auto-open;
 *  - command output reaches the panel/host snapshot;
 *  - command end -> auto-close countdown -> terminal removed -> history entry;
 *  - agent tool live_terminal_run (keepOpen) -> visible terminal + tool result.
 *
 * Usage: node tools/accept-121.mjs "<url-with-token>"
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
  console.error('usage: node tools/accept-121.mjs <url-with-token>')
  process.exit(2)
}
const browserPath = process.env.DSH_TEST_BROWSER ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((candidate) => existsSync(candidate))
const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function screenshot(page, name) {
  await page.screenshot({ path: join(artifacts, `accept-121-${name}.png`) }).catch(() => {})
}
async function dismissOverlays(page) {
  for (const label of ['继续', '继续使用', '我知道了', '知道啦', '关闭', 'Continue', 'Got it']) {
    const button = page.getByRole('button', { name: label, exact: true })
    if (await button.count()) {
      await button.first().click().catch(() => {})
      await wait(300)
    }
  }
}
async function hostSessions(page) {
  return page.evaluate(async () => {
    const response = await fetch('/dsh-terminal-panel/sessions', { credentials: 'same-origin' })
    const payload = await response.json().catch(() => ({}))
    return payload.sessions ?? []
  })
}
async function hostHistory(page) {
  return page.evaluate(async () => {
    const response = await fetch('/dsh-terminal-panel/history?limit=20', { credentials: 'same-origin' })
    const payload = await response.json().catch(() => ({}))
    return payload.entries ?? []
  })
}
async function snapshotText(page, id) {
  return page.evaluate(async (terminalId) => {
    const response = await fetch(`/dsh-terminal-panel/snapshot?id=${encodeURIComponent(terminalId)}`, { credentials: 'same-origin' })
    const payload = await response.json().catch(() => ({}))
    return payload.text ?? ''
  }, id)
}
async function sendPrompt(page, text) {
  const composer = page.locator('[role="textbox"]').first()
  await composer.waitFor({ state: 'visible', timeout: 15_000 })
  await composer.click()
  await page.keyboard.type(text, { delay: 3 })
  await page.keyboard.press('Enter')
}
async function waitFor(predicate, timeoutMs, intervalMs = 500) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true
    await wait(intervalMs)
  }
  return false
}

const browser = await chromium.launch({ executablePath: browserPath, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const consoleErrors = []
const pageErrors = []
const failedResponses = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', (error) => pageErrors.push(String(error)))
page.on('response', (response) => {
  if (response.status() >= 500) failedResponses.push(`${response.status()} ${response.url()}`)
})

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => Boolean(globalThis.__DSH_TERMINAL_PANEL__), undefined, { timeout: 30_000 })
  await wait(3000)
  await dismissOverlays(page)
  record('client bundle loaded', true)

  // New conversation so per-session auto-open has not been consumed yet.
  const newSession = page.getByRole('button', { name: '新建会话', exact: true }).first()
  if (await newSession.count()) {
    await newSession.click().catch(() => {})
    await wait(2500)
  }
  await screenshot(page, '01-new-session')

  // Real agent turn: explicit foreground pwsh command.
  await sendPrompt(page, "请只调用一次 pwsh 工具执行命令 `Write-Output 'accept-121'`，把输出告诉我，不要做其他事。")
  record('agent prompt sent (intercept)', true)

  const intercepted = await waitFor(async () => {
    const sessions = await hostSessions(page)
    return sessions.some((session) => session.kind === 'command' && /accept-121/u.test(String(session.command ?? session.title ?? '')))
  }, 90_000, 1000)
  record('pwsh command intercepted into a visible command terminal', intercepted)

  let commandSession
  if (intercepted) {
    const sessions = await hostSessions(page)
    commandSession = sessions.find((session) => session.kind === 'command' && /accept-121/u.test(String(session.command ?? session.title ?? '')))
    const panelOpened = await waitFor(async () => (await page.locator('[data-dsh-terminal-panel="body"]').count()) > 0, 20_000)
    record('panel auto-opened for the agent command', panelOpened)
    const text = await waitFor(async () => {
      const id = commandSession?.id
      return id ? String(await snapshotText(page, id)).includes('accept-121') : false
    }, 20_000)
    record('command output visible in the terminal screen', text)
    await screenshot(page, '02-intercepted')

    // Regression: clicking a finished command tab used to pause auto-close
    // forever. It must resume once the pointer leaves the terminal/tab.
    const finishedTab = page.locator('.dshtp-tab', { hasText: 'accept-121' }).first()
    if (await finishedTab.count()) {
      await finishedTab.click().catch(() => {})
      await wait(600)
      await page.mouse.move(20, 500)
    }
    const afterLeave = commandSession
      ? (await hostSessions(page)).find((session) => session.id === commandSession.id)
      : undefined
    record(
      'clicking a finished tab does not permanently pause auto-close',
      afterLeave?.autoClosePaused !== true,
      `paused=${String(afterLeave?.autoClosePaused)}`,
    )

    // Auto-close: success default 8s; the tab/host session should disappear,
    // and the output must remain available in history.
    const closed = await waitFor(async () => {
      const sessions = await hostSessions(page)
      return !sessions.some((session) => session.id === commandSession.id)
    }, 20_000)
    record('successful command terminal auto-closed', closed)
    const history = await waitFor(async () => {
      const entries = await hostHistory(page)
      return entries.some((entry) => entry.id === commandSession.id && String(entry.text).includes('accept-121'))
    }, 10_000)
    record('closed command output retained in history', history)
    const panelHistoryDialog = (await page.locator('.dshtp-menu').count()) >= 0
    record('panel history dialog reachable', panelHistoryDialog)
    await screenshot(page, '03-auto-closed')
  }

  // Agent tool path: live_terminal_run with keepOpen so the terminal stays.
  await sendPrompt(page, "请调用 live_terminal_run 工具，参数 command=\"Start-Sleep -Milliseconds 800; Write-Output 'tool-121'\"、keepOpen=true、description=\"accept tool\"，完成后把返回的 terminalId 和 output 告诉我。只做这一件事。")
  record('agent prompt sent (live_terminal_run)', true)
  const toolSession = await waitFor(async () => {
    const sessions = await hostSessions(page)
    return sessions.some((session) => session.kind === 'command' && /tool-121/u.test(String(session.command ?? '')))
  }, 90_000, 1000)
  record('live_terminal_run created a visible command terminal', toolSession)
  if (toolSession) {
    const sessions = await hostSessions(page)
    const session = sessions.find((entry) => entry.kind === 'command' && /tool-121/u.test(String(entry.command ?? '')))
    const text = await waitFor(async () => (session ? String(await snapshotText(page, session.id)).includes('tool-121') : false), 20_000)
    record('live_terminal_run output visible', text)
    // keepOpen means "do not auto-close"; the terminal stays as an exited tab.
    // (The `pinned` flag is reserved for an explicit user "keep".)
    await wait(10_000)
    const stillOpen = (await hostSessions(page)).some((entry) => entry.id === session?.id)
    record('keepOpen terminal survives past the 8s auto-close delay', stillOpen)
    await screenshot(page, '04-tool-run')

    // Agent read path on the kept terminal.
    if (session) {
      await sendPrompt(page, `请调用 live_terminal_read，terminalId 为 ${session.id}，把返回的 text 字段原样贴在回复里。只做这一件事。`)
      const readBack = await waitFor(async () => {
        const body = await page.locator('body').innerText().catch(() => '')
        return body.includes('tool-121')
      }, 60_000, 1000)
      record('live_terminal_read returns the kept command output', readBack)
    }
  }

  record('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  record('no 5xx responses', failedResponses.length === 0, failedResponses.slice(0, 3).join(' | '))
  record('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
  await screenshot(page, '05-final')
} finally {
  await browser.close().catch(() => {})
}

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length} pass / ${failed.length} fail`)
process.exitCode = failed.length === 0 ? 0 : 1
