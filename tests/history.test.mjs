import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { CommandHistory } from '../lib/host/history.js'

/**
 * @param {Partial<any>} [overrides] entry overrides.
 * @returns {any} history entry.
 */
function entry(overrides = {}) {
  return {
    id: 't-1',
    title: 'Get-ChildItem',
    command: 'Get-ChildItem',
    cwd: 'C:\\work',
    kind: 'command',
    exitCode: 0,
    signal: null,
    startedAt: 1000,
    endedAt: 1500,
    durationMs: 500,
    cols: 120,
    rows: 30,
    reason: 'auto-close',
    text: 'output',
    truncated: false,
    ports: [],
    sandbox: { mode: 'workspace-write', confined: false, required: false },
    ...overrides,
  }
}

test('history keeps newest first and bounds the LRU size', () => {
  const history = new CommandHistory({ size: 2, persist: false })
  history.add(entry({ id: 'a' }))
  history.add(entry({ id: 'b' }))
  history.add(entry({ id: 'c' }))
  assert.deepEqual(history.list().map((item) => item.id), ['c', 'b'])
  assert.equal(history.size, 2)
})

test('history add replaces an existing id and returns deep copies', () => {
  const history = new CommandHistory({ size: 5, persist: false })
  history.add(entry({ id: 'a', exitCode: 1 }))
  history.add(entry({ id: 'a', exitCode: 2 }))
  assert.equal(history.size, 1)
  assert.equal(history.get('a').exitCode, 2)
  const listed = history.list()
  listed[0].exitCode = 99
  assert.equal(history.get('a').exitCode, 2, 'list must not leak mutable internals')
})

test('history filters by terminal id and limit', () => {
  const history = new CommandHistory({ size: 5, persist: false })
  history.add(entry({ id: 'a' }))
  history.add(entry({ id: 'b' }))
  assert.deepEqual(history.list({ terminalId: 'a' }).map((item) => item.id), ['a'])
  assert.deepEqual(history.list({ limit: 1 }).map((item) => item.id), ['b'])
})

test('history persists to disk and reloads after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-live-terminal-history-'))
  const file = join(dir, 'history.json')
  try {
    const first = new CommandHistory({ size: 5, file, persist: true })
    first.add(entry({ id: 'persisted', text: 'kept output' }))
    first.save()
    const raw = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(raw.version, 1)
    assert.equal(raw.entries[0].id, 'persisted')

    const second = new CommandHistory({ size: 5, file, persist: true })
    assert.equal(second.get('persisted')?.text, 'kept output')
    await second.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('history tolerates a corrupt file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-live-terminal-history-'))
  const file = join(dir, 'history.json')
  try {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, '{not json', 'utf8')
    const warnings = []
    const history = new CommandHistory({ size: 5, file, persist: true, logger: { warn: (message) => warnings.push(message) } })
    assert.equal(history.size, 0)
    history.add(entry({ id: 'after-corrupt' }))
    assert.equal(history.get('after-corrupt')?.id, 'after-corrupt')
    assert.ok(warnings.length >= 1)
    await history.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
