import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerIntercept } from '../lib/host/intercept.js'
import { FOREGROUND_VALUE_SCHEMA, validateValue } from './helpers/schema.mjs'

const agent = { id: 'agent-1', session: { id: 'session-1' } }

/**
 * @param {object} [overrides] registry overrides.
 * @returns {any} fake registry.
 */
function fakeRegistry(overrides = {}) {
  const calls = { created: [], closed: [], waited: [] }
  const session = { id: 'command-session-1', state: 'running' }
  const registry = {
    calls,
    async resolveCwd() {
      return 'C:\\work'
    },
    async createCommandSession(options) {
      calls.created.push(options)
      if (overrides.createThrows === true) throw new Error('spawn failed')
      if (overrides.unresolvableHint !== undefined && options.shellKindHint === overrides.unresolvableHint) {
        throw new Error(`dsh-terminal-panel: no usable shell found for shell kind ${options.shellKindHint} (bash: not found)`)
      }
      return session
    },
    async waitForCommandSession(target, options) {
      calls.waited.push(options)
      if (overrides.waitThrows === true) throw new Error('wait failed')
      return {
        output: overrides.output ?? 'command output',
        truncated: overrides.truncated ?? false,
        exitCode: overrides.exitCode ?? 0,
        signal: overrides.signal ?? null,
        timedOut: overrides.timedOut ?? false,
        aborted: overrides.aborted ?? false,
      }
    },
    async close(id) {
      calls.closed.push(id)
      return true
    },
  }
  return registry
}

/**
 * Register the interceptor and return its `tools/execute` handler.
 * @param {any} registry fake registry.
 * @param {object} [config] plugin config overrides.
 * @returns {{ handler: Function | undefined, listeners: any[], logger: string[] }} captured wiring.
 */
function setup(registry, config = {}) {
  const listeners = []
  const logger = []
  const ctx = {
    on(event, handler) {
      listeners.push({ event, handler })
    },
  }
  const plugin = {
    config: { interceptShellTools: true, ...config },
    registry,
    logger: { warn: (message) => logger.push(message) },
  }
  registerIntercept(ctx, plugin)
  const entry = listeners.find((listener) => listener.event === 'tools/execute')
  return { handler: entry?.handler, listeners, logger }
}

/**
 * @returns {any} fake pwsh tool execution.
 */
function execution() {
  return {
    name: 'pwsh',
    arguments: { description: 'List files', command: 'Get-ChildItem' },
    agent,
    signal: new AbortController().signal,
  }
}

test('registers one tools/execute waterfall listener when enabled', () => {
  const { listeners } = setup(fakeRegistry())
  assert.deepEqual(listeners.map((listener) => listener.event), ['tools/execute'])
})

test('does not register the interceptor when interceptShellTools is false', () => {
  const { listeners } = setup(fakeRegistry(), { interceptShellTools: false })
  assert.equal(listeners.length, 0)
})

test('intercepts a foreground pwsh call and returns a built-in-shaped value', async () => {
  const registry = fakeRegistry()
  const { handler } = setup(registry)
  let nextCalls = 0
  const result = await handler(execution(), () => {
    nextCalls += 1
    return { value: { from: 'builtin' } }
  })
  assert.equal(nextCalls, 0)
  assert.deepEqual(validateValue(FOREGROUND_VALUE_SCHEMA, result.value), [])
  assert.equal(result.value.stdout.text, 'command output')
  assert.equal(result.value.exitCode, 0)
  assert.equal(registry.calls.created.length, 1)
  assert.equal(registry.calls.created[0].command, 'Get-ChildItem')
  assert.equal(registry.calls.created[0].cwd, 'C:\\work')
  assert.equal(registry.calls.created[0].agentId, 'agent-1')
  assert.equal(registry.calls.created[0].sessionId, 'session-1')
  assert.equal(registry.calls.created[0].shellKindHint, 'pwsh')
  assert.equal(registry.calls.created[0].origin, 'intercept')
  assert.equal(registry.calls.waited.length, 1)
})

test('passes the shell-kind hint matching the intercepted tool name', async () => {
  const registry = fakeRegistry()
  const { handler } = setup(registry)
  await handler(execution(), () => assert.fail('next must not be called'))
  await handler(
    { ...execution(), name: 'bash', arguments: { command: 'echo hi' } },
    () => assert.fail('next must not be called'),
  )
  assert.equal(registry.calls.created[0].shellKindHint, 'pwsh')
  assert.equal(registry.calls.created[1].shellKindHint, 'bash')
})

test('falls back to next() when the hinted shell cannot be resolved', async () => {
  const registry = fakeRegistry({ unresolvableHint: 'bash' })
  const { handler, logger } = setup(registry)
  const builtin = { value: { from: 'builtin' } }
  const result = await handler({ ...execution(), name: 'bash', arguments: { command: 'echo hi' } }, () => builtin)
  assert.equal(result, builtin)
  assert.equal(registry.calls.created[0].shellKindHint, 'bash')
  assert.deepEqual(registry.calls.closed, [])
  assert.ok(logger.some((line) => line.includes('fell back')))
})

test('maps a timeout to exitCode null, SIGTERM and timedOut', async () => {
  const { handler } = setup(fakeRegistry({ timedOut: true, exitCode: 1, signal: null }))
  const result = await handler(execution(), () => assert.fail('next must not be called'))
  assert.deepEqual(validateValue(FOREGROUND_VALUE_SCHEMA, result.value), [])
  assert.equal(result.value.exitCode, null)
  assert.equal(result.value.signal, 'SIGTERM')
  assert.equal(result.value.timedOut, true)
})

test('maps an abort to exitCode null, SIGTERM and aborted', async () => {
  const { handler } = setup(fakeRegistry({ aborted: true, exitCode: null }))
  const result = await handler(execution(), () => assert.fail('next must not be called'))
  assert.deepEqual(validateValue(FOREGROUND_VALUE_SCHEMA, result.value), [])
  assert.equal(result.value.exitCode, null)
  assert.equal(result.value.signal, 'SIGTERM')
  assert.equal(result.value.aborted, true)
})

test('keeps the head truncation note when the command output was bounded', async () => {
  const { handler } = setup(fakeRegistry({ truncated: true }))
  const result = await handler(execution(), () => assert.fail('next must not be called'))
  assert.match(result.value.stdout.text, /^\[output truncated/)
  assert.equal(result.value.stdout.truncated, false)
})

test('falls back to next() when the command session cannot be created', async () => {
  const registry = fakeRegistry({ createThrows: true })
  const { handler, logger } = setup(registry)
  const builtin = { value: { from: 'builtin' } }
  const result = await handler(execution(), () => builtin)
  assert.equal(result, builtin)
  assert.ok(logger.length > 0)
  assert.ok(logger[0].includes('fell back'))
})

test('closes the created session and falls back when the wait fails', async () => {
  const registry = fakeRegistry({ waitThrows: true })
  const { handler } = setup(registry)
  const builtin = { value: { from: 'builtin' } }
  const result = await handler(execution(), () => builtin)
  assert.equal(result, builtin)
  assert.deepEqual(registry.calls.closed, ['command-session-1'])
})

test('does not intercept background or sandbox-escalation calls', async () => {
  const registry = fakeRegistry()
  const { handler } = setup(registry)
  let nextCalls = 0
  const next = () => {
    nextCalls += 1
    return { value: { from: 'builtin' } }
  }
  await handler({ ...execution(), arguments: { command: 'x', run_in_background: true } }, next)
  await handler({ ...execution(), arguments: { command: 'x', sandbox_permissions: 'danger-full-access' } }, next)
  assert.equal(nextCalls, 2)
  assert.equal(registry.calls.created.length, 0)
})

test('falls back when the terminal backend is not ready', async () => {
  const { handler } = setup(undefined)
  const builtin = { value: { from: 'builtin' } }
  assert.equal(await handler(execution(), () => builtin), builtin)
})
