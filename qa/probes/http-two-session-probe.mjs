/**
 * Reproduce the H-06/H-08 failure pattern: create TWO sessions over HTTP like
 * the e2e does (main + default), then probe the FIRST session's readiness and
 * input echo.
 *
 * Usage: node qa/probes/http-two-session-probe.mjs "<token-url>"
 */

import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'

const url = process.argv[2]
if (!url || !/^https?:\/\//.test(url)) {
  console.error('usage: node qa/probes/http-two-session-probe.mjs <token-url>')
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

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => (document.body?.innerText?.length ?? 0) > 30, null, { timeout: 40_000 })
  await sleep(1200)

  const result = await page.evaluate(async () => {
    const jsonFetch = async (path, init) => {
      const response = await fetch(path, { credentials: 'same-origin', ...init })
      const text = await response.text()
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
      return { status: response.status, json, text }
    }
    const post = (path, body) =>
      jsonFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const snapshotText = async (id) => {
      const snapshot = await jsonFetch('/dsh-terminal-panel/snapshot?id=' + encodeURIComponent(id))
      return snapshot.json?.text ?? ''
    }
    const waitPrompt = async (id, timeoutMs) => {
      const started = Date.now()
      while (Date.now() - started < timeoutMs) {
        const text = await snapshotText(id)
        if (/PS\s+[A-Za-z]:[\\/]/.test(text)) return { ok: true, waitedMs: Date.now() - started, text }
        await new Promise((r) => setTimeout(r, 300))
      }
      return { ok: false, waitedMs: timeoutMs, text: await snapshotText(id) }
    }

    const main = await post('/dsh-terminal-panel/create', { cols: 100, rows: 30, title: 'qa-http-main' })
    const mainId = main.json?.session?.id
    const second = await post('/dsh-terminal-panel/create', {})
    const secondId = second.json?.session?.id

    const mainReady = await waitPrompt(mainId, 45_000)
    const secondReady = await waitPrompt(secondId, 25_000)

    const nonce = 'qa-two-' + Date.now().toString(36)
    await post('/dsh-terminal-panel/input', { id: mainId, data: "Write-Output '" + nonce + "'\r" })
    const started = Date.now()
    let outputSeen = false
    let trace = []
    while (Date.now() - started < 20_000) {
      const text = await snapshotText(mainId)
      trace.push({ t: Date.now() - started, textLength: text.length, tail: text.split('\n').filter(Boolean).pop()?.slice(0, 90) ?? '' })
      if (text.includes(nonce)) {
        outputSeen = true
        break
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    const mainInfo = (await jsonFetch('/dsh-terminal-panel/sessions')).json?.sessions?.find((session) => session.id === mainId)
    for (const id of [mainId, secondId].filter(Boolean)) await post('/dsh-terminal-panel/close', { id })
    return {
      mainId,
      secondId,
      mainReady: { ok: mainReady.ok, waitedMs: mainReady.waitedMs, textLength: (mainReady.text ?? '').length },
      secondReady: { ok: secondReady.ok, waitedMs: secondReady.waitedMs, textLength: (secondReady.text ?? '').length },
      outputSeen,
      trace: trace.slice(0, 25),
      mainInfo,
    }
  })
  console.log(JSON.stringify(result, null, 2))
} finally {
  await browser.close().catch(() => {})
}
