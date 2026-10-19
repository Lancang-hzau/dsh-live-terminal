/**
 * QA probe: independently reproduce two failing host-unit-test suspicions.
 *
 * Run: node qa/probes/session-ring-probe.mjs
 *
 * 1) session.test.mjs "broadcasts output frames with monotonic sequence
 *    numbers" times out; the fake handle pushes two chunks synchronously, which
 *    a Node Readable async-iterator may coalesce into ONE chunk. This probe
 *    pushes the same chunks with a delay and reports how many `output` frames
 *    arrive.
 * 2) ring.test.mjs ByteTail cases fail: verify the ByteTail byte bound is
 *    actually enforced across multiple chunks.
 */

import { PassThrough } from 'node:stream'
import { TerminalPanelSession } from '../../packages/dsh-terminal-panel/lib/host/session.js'
import { ByteTail } from '../../packages/dsh-terminal-panel/lib/host/ring.js'

function fakeHandle() {
  const output = new PassThrough()
  const outcome = Promise.withResolvers()
  return {
    output,
    done: outcome.promise,
    async write() {},
    async resize() {},
    async terminate() {
      outcome.resolve({ exitCode: 0, signal: null })
      output.end()
    },
    push(bytes) {
      output.write(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8'))
    },
    finish() {
      outcome.resolve({ exitCode: 0, signal: null })
      output.end()
    },
  }
}

async function sessionProbe(delayed) {
  const handle = fakeHandle()
  const session = new TerminalPanelSession({
    id: 'probe',
    title: 'probe',
    kind: 'interactive',
    owner: 'user',
    handle,
    cwd: 'C:\\work',
    cols: 40,
    rows: 10,
    scrollback: 100,
    maxOutputBytes: 1024,
  })
  const chunks = []
  session.subscribe((name, data) => {
    if (name === 'output') chunks.push(data.chunk)
  })
  handle.push('one\r\n')
  if (delayed) await new Promise((resolve) => setTimeout(resolve, 120))
  handle.push('two')
  await new Promise((resolve) => setTimeout(resolve, 400))
  handle.finish()
  await session.whenExited
  await session.dispose()
  return chunks
}

const fast = await sessionProbe(false)
const delayed = await sessionProbe(true)
console.log('fast double push -> output frames:', fast.length, JSON.stringify(fast))
console.log('delayed pushes  -> output frames:', delayed.length, JSON.stringify(delayed))

const tail = new ByteTail(4)
tail.append('abc')
tail.append('def')
console.log(
  'ByteTail(4) after abc+def   ->',
  JSON.stringify(tail.text()),
  'reported byteLength =',
  tail.byteLength,
  'actual =',
  Buffer.byteLength(tail.text(), 'utf8'),
)
tail.append('ghijklmnop')
console.log(
  'ByteTail(4) after more      ->',
  JSON.stringify(tail.text()),
  'reported byteLength =',
  tail.byteLength,
  'actual =',
  Buffer.byteLength(tail.text(), 'utf8'),
)
