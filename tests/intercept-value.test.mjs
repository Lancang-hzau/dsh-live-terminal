import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildForegroundValue,
  INTERCEPT_DEFAULT_TIMEOUT_MS,
  shouldIntercept,
} from '../lib/host/intercept.js'
import { FOREGROUND_VALUE_SCHEMA, validateValue } from './helpers/schema.mjs'

test('buildForegroundValue maps a completed command to the built-in foreground shape', () => {
  const value = buildForegroundValue({
    cwd: 'C:\\work',
    output: 'hello\n',
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 30_000,
  })
  assert.deepEqual(validateValue(FOREGROUND_VALUE_SCHEMA, value), [])
  assert.equal(value.kind, 'foreground')
  assert.equal(value.cwd, 'C:\\work')
  assert.equal(value.exitCode, 0)
  assert.equal(value.signal, null)
  assert.equal(value.timedOut, false)
  assert.equal(value.aborted, false)
  assert.equal(value.timeoutMs, 30_000)
  assert.equal(value.stdout.text, 'hello')
  assert.equal(value.stdout.truncated, false)
  assert.equal(value.stderr.text, '')
})

test('buildForegroundValue strips ANSI from merged PTY output', () => {
  const value = buildForegroundValue({
    cwd: '.',
    output: '\u001B[32mok\u001B[0m\r\n\u001B[1;31mfail\u001B[0m',
    exitCode: 1,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 1,
  })
  assert.equal(value.stdout.text, 'ok\nfail')
})

test('buildForegroundValue maps timeout to exitCode null and SIGTERM', () => {
  const value = buildForegroundValue({
    cwd: '.',
    output: 'partial',
    exitCode: 1,
    signal: null,
    timedOut: true,
    aborted: false,
    timeoutMs: 120_000,
  })
  assert.deepEqual(validateValue(FOREGROUND_VALUE_SCHEMA, value), [])
  assert.equal(value.exitCode, null)
  assert.equal(value.signal, 'SIGTERM')
  assert.equal(value.timedOut, true)
  assert.equal(value.aborted, false)
})

test('buildForegroundValue maps abort to exitCode null and SIGTERM', () => {
  const value = buildForegroundValue({
    cwd: '.',
    output: '',
    exitCode: null,
    signal: null,
    timedOut: false,
    aborted: true,
    timeoutMs: 120_000,
  })
  assert.deepEqual(validateValue(FOREGROUND_VALUE_SCHEMA, value), [])
  assert.equal(value.exitCode, null)
  assert.equal(value.signal, 'SIGTERM')
  assert.equal(value.aborted, true)
})

test('buildForegroundValue adds a head truncation note while keeping truncated=false', () => {
  const value = buildForegroundValue({
    cwd: '.',
    output: 'tail data',
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 1000,
    truncated: true,
    maxOutputBytes: 4096,
  })
  assert.deepEqual(validateValue(FOREGROUND_VALUE_SCHEMA, value), [])
  assert.equal(value.stdout.truncated, false)
  assert.match(value.stdout.text, /^\[output truncated/)
  assert.ok(value.stdout.text.endsWith('tail data'))
})

test('INTERCEPT_DEFAULT_TIMEOUT_MS is the documented fallback', () => {
  assert.equal(INTERCEPT_DEFAULT_TIMEOUT_MS, 120_000)
})

/**
 * @param {object} [overrides] execution overrides.
 * @returns {any} fake tool execution.
 */
function execution(overrides = {}) {
  return {
    name: 'pwsh',
    arguments: { description: 'List files', command: 'Get-ChildItem' },
    agent: { id: 'agent-1', session: { id: 'session-1' }, ctx: {} },
    signal: new AbortController().signal,
    ...overrides,
  }
}

test('shouldIntercept accepts foreground pwsh and bash calls with an agent', () => {
  assert.equal(shouldIntercept(execution(), { interceptShellTools: true }), true)
  assert.equal(shouldIntercept(execution({ name: 'bash' }), { interceptShellTools: true }), true)
})

test('shouldIntercept rejects other tools, disabled config and missing agents', () => {
  assert.equal(shouldIntercept(execution({ name: 'write' }), { interceptShellTools: true }), false)
  assert.equal(shouldIntercept(execution(), { interceptShellTools: false }), false)
  assert.equal(shouldIntercept(execution({ agent: undefined }), { interceptShellTools: true }), false)
})

test('shouldIntercept leaves background and sandbox-escalation calls to the built-in tool', () => {
  const background = execution({ arguments: { description: 'x', command: 'Get-ChildItem', run_in_background: true } })
  assert.equal(shouldIntercept(background, { interceptShellTools: true }), false)
  const escalated = execution({ arguments: { description: 'x', command: 'Get-ChildItem', sandbox_permissions: 'danger-full-access' } })
  assert.equal(shouldIntercept(escalated, { interceptShellTools: true }), false)
})

test('shouldIntercept ignores empty or missing commands and aborted executions', () => {
  assert.equal(shouldIntercept(execution({ arguments: { description: 'x', command: '   ' } }), { interceptShellTools: true }), false)
  assert.equal(shouldIntercept(execution({ arguments: { description: 'x' } }), { interceptShellTools: true }), false)
  const controller = new AbortController()
  controller.abort()
  assert.equal(shouldIntercept(execution({ signal: controller.signal }), { interceptShellTools: true }), false)
})
