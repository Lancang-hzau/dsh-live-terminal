import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'

const url = process.argv[2]
if (!url) { console.error('usage: node tools/regress-banner-close.mjs <url-with-token>'); process.exit(2) }
const browserPath = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((candidate) => existsSync(candidate))
const browser = await chromium.launch({ executablePath: browserPath, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sessions = async () => page.evaluate(async () => (await (await fetch('/dsh-terminal-panel/sessions', { credentials: 'same-origin' })).json()).sessions ?? [])
const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(globalThis.__DSH_TERMINAL_PANEL__), undefined, { timeout: 30000 })
  await wait(2500)
  for (const label of ['继续', '继续使用', '我知道了', '关闭', 'Continue']) {
    const button = page.getByRole('button', { name: label, exact: true })
    if (await button.count()) await button.first().click().catch(() => {})
  }
  await page.getByRole('button', { name: '新建会话', exact: true }).first().click().catch(() => {})
  await wait(2500)
  await page.keyboard.press('Control+Shift+B')
  await wait(1200)
  const guide = page.getByText('打开可见终端面板', { exact: true }).first()
  if (await guide.count()) await guide.click().catch(() => {})
  await wait(1200)
  if ((await page.locator('[data-dsh-terminal-panel="body"]').count()) === 0) {
    await page.keyboard.press('Control+Shift+B')
    await wait(800)
    if (await guide.count()) await guide.click().catch(() => {})
    await wait(1000)
  }
  const composer = page.locator('[role="textbox"]').first()
  await composer.waitFor({ state: 'visible', timeout: 15000 })
  await composer.click()
  await page.keyboard.type("请只调用一次 pwsh 工具执行命令 `Write-Output 'banner-close-test'`，把输出告诉我，不要做其他事。", { delay: 3 })
  await page.keyboard.press('Enter')

  let session
  for (let i = 0; i < 90; i++) {
    session = (await sessions()).find((s) => s.kind === 'command' && String(s.command ?? '').includes('banner-close-test'))
    if (session) break
    await wait(1000)
  }
  record('intercepted command created', Boolean(session))
  if (!session) throw new Error('no session')
  for (let i = 0; i < 30; i++) {
    session = (await sessions()).find((s) => s.id === session.id)
    if (session && session.state !== 'running' && session.autoCloseAt !== null) break
    await wait(300)
  }
  record('command exited with an auto-close deadline', Boolean(session) && session.state !== 'running' && session.autoCloseAt !== null)

  // Select the finished command tab first (the panel may still be showing an
  // older terminal after previous tests/agent turns).
  const tab = page.locator(`[data-dsh-tp-session-id="${session.id}"]`).first()
  if (await tab.count()) await tab.click().catch(() => {})
  await wait(250)

  // Move the pointer onto the countdown banner itself: this pauses auto-close
  // (the exact action that used to remove the banner). It must stay visible.
  const banner = page.locator('[data-dsh-tp-auto-close]').first()
  if (await banner.count()) {
    const box = await banner.boundingBox()
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await wait(250)
      // A second move guarantees the parent receives mousemove after the tab's
      // mouseleave (which can otherwise resume the countdown in this test).
      await page.mouse.move(box.x + box.width / 2 + 16, box.y + box.height / 2 + 2)
    }
  }
  await wait(700)
  const bannerCount = await banner.count()
  const paused = bannerCount ? await banner.getAttribute('data-paused') : null
  const bannerText = bannerCount ? await banner.innerText().catch(() => '') : ''
  record('countdown banner remains visible while hover-paused', bannerCount > 0 && paused === 'true', bannerText.replace(/\s+/g, ' ').slice(0, 120))
  const keep = page.locator('[data-dsh-tp-auto-close] button', { hasText: '保留' }).first()
  const closeNow = page.locator('[data-dsh-tp-auto-close] button', { hasText: '立即关闭' }).first()
  record('keep and close buttons are still present', (await keep.count()) > 0 && (await closeNow.count()) > 0)
  await page.screenshot({ path: 'tools/artifacts/banner-paused.png' })
  if (await closeNow.count()) await closeNow.click()
  await wait(1200)
  const still = (await sessions()).some((s) => s.id === session.id)
  record('clicking 立即关闭 closes the terminal', !still)
  await page.screenshot({ path: 'tools/artifacts/banner-closed.png' })
} finally {
  await browser.close().catch(() => {})
}
const failed = results.filter((entry) => !entry.ok).length
console.log(`\n${results.length - failed} pass / ${failed} fail`)
process.exitCode = failed === 0 ? 0 : 1
