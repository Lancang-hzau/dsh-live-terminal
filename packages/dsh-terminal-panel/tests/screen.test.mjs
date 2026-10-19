import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ScreenMirror } from '../lib/host/screen.js'

/**
 * @param {number} ms milliseconds.
 * @returns {Promise<void>} timer promise.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('ScreenMirror renders visible text and a cursor', async () => {
  const screen = new ScreenMirror({ cols: 40, rows: 10, scrollback: 100 })
  try {
    await screen.write('hello\r\nworld')
    assert.equal(screen.visibleText(), 'hello\nworld')
    assert.deepEqual(screen.cursor(), { x: 5, y: 1 })
  } finally {
    screen.dispose()
  }
})

test('ScreenMirror strips ANSI styling from visible text', async () => {
  const screen = new ScreenMirror({ cols: 40, rows: 5, scrollback: 100 })
  try {
    await screen.write('\u001B[31mred\u001B[0m text')
    assert.equal(screen.visibleText(), 'red text')
  } finally {
    screen.dispose()
  }
})

test('ScreenMirror right-trims lines and drops trailing blank rows', async () => {
  const screen = new ScreenMirror({ cols: 20, rows: 5, scrollback: 100 })
  try {
    await screen.write('a   \r\nb   \r\n')
    assert.equal(screen.visibleText(), 'a\nb')
  } finally {
    screen.dispose()
  }
})

test('ScreenMirror visible text follows the viewport after scrolling', async () => {
  const screen = new ScreenMirror({ cols: 20, rows: 3, scrollback: 100 })
  try {
    await screen.write('one\r\ntwo\r\nthree\r\nfour')
    // rows=3, four lines written: the viewport shows the last three lines.
    assert.equal(screen.visibleText(), 'two\nthree\nfour')
    assert.equal(screen.fullText(), 'one\ntwo\nthree\nfour')
  } finally {
    screen.dispose()
  }
})

test('ScreenMirror serializes a screen that restores its content', async () => {
  const screen = new ScreenMirror({ cols: 20, rows: 5, scrollback: 100 })
  try {
    await screen.write('\u001B[32mgreen\u001B[0m')
    const serialized = screen.serialize()
    assert.ok(serialized.includes('green'))
  } finally {
    screen.dispose()
  }
})

test('ScreenMirror resize updates dimensions and visible rows', async () => {
  const screen = new ScreenMirror({ cols: 20, rows: 5, scrollback: 100 })
  try {
    await screen.write('a\r\nb\r\nc\r\nd')
    screen.resize(30, 2)
    assert.equal(screen.cols, 30)
    assert.equal(screen.rows, 2)
    assert.equal(screen.visibleText(), 'c\nd')
    await sleep(1)
  } finally {
    screen.dispose()
  }
})

test('ScreenMirror dispose releases the emulator and tolerates empty writes', async () => {
  const screen = new ScreenMirror({ cols: 10, rows: 3, scrollback: 10 })
  await screen.write('')
  screen.dispose()
  assert.equal(screen.visibleText(), '')
  await assert.rejects(() => screen.write('after dispose'), /disposed/)
})
