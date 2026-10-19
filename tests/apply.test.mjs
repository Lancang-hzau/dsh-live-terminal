import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../lib/index.js'
import { ROUTE_PREFIX } from '../lib/host/routes.js'

/** Tool names registered by `registerTools`. */
const TOOL_NAMES = [
  'live_terminal_close',
  'live_terminal_list',
  'live_terminal_open',
  'live_terminal_read',
  'live_terminal_run',
  'live_terminal_screenshot',
  'live_terminal_send',
]

/**
 * Subprocess double: `apply` only constructs the registry (it does not spawn).
 * @returns {any} fake subprocess service.
 */
function fakeSubprocess() {
  return {
    async terminalEnvironment() {
      return { platform: 'windows', defaultShell: 'cmd.exe' }
    },
    async resolveExecutable(name) {
      return `C:\\resolved\\${name}.exe`
    },
    async spawnTerminal() {
      throw new Error('spawnTerminal must not be called during apply')
    },
  }
}

/**
 * Fake Cordis context capturing every registration `apply` performs.
 * @param {{ services?: Record<string, any> }} [options] initially provided services.
 * @returns {{ ctx: any, calls: any }} fake context and captured registrations.
 */
function makeContext({ services = {} } = {}) {
  const calls = {
    services: { ...services },
    effects: [],
    injections: [],
    listeners: [],
    tools: [],
    logs: [],
  }
  const ctx = {
    logger: {
      info(message) {
        calls.logs.push(message)
      },
      warn(message) {
        calls.logs.push(message)
      },
    },
    get(name) {
      return calls.services[name]
    },
    inject(names, callback) {
      calls.injections.push({ names, callback })
      return () => {}
    },
    on(event, handler) {
      calls.listeners.push({ event, handler })
      return () => {}
    },
    effect(factory, label) {
      const disposer = factory()
      calls.effects.push({ label, disposer })
      return () => {}
    },
    tools: {
      register(definition) {
        calls.tools.push(definition)
        return () => {}
      },
    },
  }
  // Real Cordis contexts expose services both as `ctx.get(name)` and as
  // properties (`ctx.webServer`); `registerRoutes` relies on the latter.
  for (const [name, service] of Object.entries(services)) ctx[name] = service
  return { ctx, calls }
}

/**
 * @param {any} calls captured registrations.
 * @param {string[]} names inject dependency list.
 * @returns {any} matching injection registration.
 */
function findInjection(calls, names) {
  return calls.injections.find((injection) => injection.names.join(',') === names.join(','))
}

/**
 * Injected context double with the subset `registerRoutes`/`registerPrompt` use.
 * @param {object} services injected services.
 * @param {{ effects?: any[], sections?: any[] }} [record] optional recorders.
 * @returns {any} fake injected context.
 */
function injectedContext(services, record = {}) {
  return {
    ...services,
    effect(factory, label) {
      const disposer = factory()
      record.effects?.push({ label, disposer })
      return () => {}
    },
  }
}

test('apply with ready services (direct branch) does not throw and registers the backend on ctx.effect', () => {
  const { ctx, calls } = makeContext({
    services: { subprocess: fakeSubprocess(), workingDirectory: { defaultDirectory: 'C:\\work' } },
  })
  assert.doesNotThrow(() => apply(ctx, {}))

  assert.deepEqual(calls.tools.map((definition) => definition.name).sort(), TOOL_NAMES)
  assert.deepEqual(calls.listeners.map((listener) => listener.event), ['tools/execute'])
  // The registry disposer must live on the plugin ctx, not on a plain service bag.
  const backendEffect = calls.effects.find((effect) => effect.label === 'dsh-live-terminal: terminal sessions')
  assert.ok(backendEffect, 'registry disposer must be registered through ctx.effect')
  assert.equal(typeof backendEffect.disposer, 'function')
  // Direct branch: the backend was initialized immediately instead of deferred.
  assert.equal(findInjection(calls, ['subprocess', 'workingDirectory']), undefined)
  assert.ok(calls.logs.some((message) => message.includes('terminal backend ready')))
  assert.ok(calls.logs.some((message) => message.includes('routes=deferred')))
})

test('apply defers registry initialization until subprocess + workingDirectory are injected', async () => {
  const { ctx, calls } = makeContext()
  assert.doesNotThrow(() => apply(ctx, {}))

  assert.equal(calls.tools.length, TOOL_NAMES.length, 'tools register without the backend')
  const backendInjection = findInjection(calls, ['subprocess', 'workingDirectory'])
  assert.ok(backendInjection, 'must wait for subprocess + workingDirectory')
  assert.equal(calls.effects.some((effect) => effect.label === 'dsh-live-terminal: terminal sessions'), false)

  // Before the services arrive, a tool fails clearly instead of crashing.
  const listTool = calls.tools.find((definition) => definition.name === 'live_terminal_list')
  await assert.rejects(() => listTool.execute({}, {}), /backend is unavailable/)

  // Simulate the services being provided: the injected callback initializes the backend.
  backendInjection.callback({ subprocess: fakeSubprocess(), workingDirectory: { defaultDirectory: 'C:\\work' } })
  assert.ok(calls.effects.some((effect) => effect.label === 'dsh-live-terminal: terminal sessions'))
  assert.deepEqual(await listTool.execute({}, {}), { terminals: [] })
  assert.ok(calls.logs.some((message) => message.includes('terminal backend ready')))
})

test('apply does not register the tools/execute interceptor when interceptShellTools is false', () => {
  const { ctx, calls } = makeContext({
    services: { subprocess: fakeSubprocess(), workingDirectory: { defaultDirectory: 'C:\\work' } },
  })
  apply(ctx, { interceptShellTools: false })
  assert.equal(calls.listeners.filter((listener) => listener.event === 'tools/execute').length, 0)
  assert.ok(calls.logs.some((message) => message.includes('interceptShellTools=false')))
})

test('apply registers HTTP routes directly when webServer + connection exist', () => {
  const webServer = {
    spec: undefined,
    register(spec) {
      this.spec = spec
      return () => {}
    },
  }
  const connection = {
    admit() {
      return { peer: {} }
    },
  }
  const { ctx, calls } = makeContext({
    services: { subprocess: fakeSubprocess(), workingDirectory: { defaultDirectory: 'C:\\work' }, webServer, connection },
  })
  apply(ctx, {})

  assert.ok(webServer.spec, 'webServer.register must be called')
  assert.equal(webServer.spec.kind, 'prefix')
  assert.equal(webServer.spec.path, ROUTE_PREFIX)
  assert.equal(typeof webServer.spec.handler, 'function')
  assert.equal(findInjection(calls, ['webServer', 'connection']), undefined)
  assert.ok(calls.logs.some((message) => message.includes('routes=direct')))
})

test('apply defers HTTP routes through inject when webServer/connection are missing', () => {
  const { ctx, calls } = makeContext({
    services: { subprocess: fakeSubprocess(), workingDirectory: { defaultDirectory: 'C:\\work' } },
  })
  apply(ctx, {})

  const routesInjection = findInjection(calls, ['webServer', 'connection'])
  assert.ok(routesInjection, 'must wait for webServer + connection')
  const webServer = {
    spec: undefined,
    register(spec) {
      this.spec = spec
      return () => {}
    },
  }
  routesInjection.callback(
    injectedContext({
      webServer,
      connection: {
        admit() {
          return { peer: {} }
        },
      },
    }),
  )
  assert.ok(webServer.spec, 'routes register once the web services are injected')
  assert.equal(webServer.spec.kind, 'prefix')
  assert.equal(webServer.spec.path, ROUTE_PREFIX)
})

test('apply registers the system-prompt guide through inject', () => {
  const { ctx, calls } = makeContext({
    services: { subprocess: fakeSubprocess(), workingDirectory: { defaultDirectory: 'C:\\work' } },
  })
  apply(ctx, {})

  const promptInjection = findInjection(calls, ['systemPrompt'])
  assert.ok(promptInjection, 'must wait for the systemPrompt service')
  const sections = []
  promptInjection.callback(
    injectedContext({
      systemPrompt: {
        getSectionOrder(name) {
          return name === 'TOOL_PTY' ? 1700 : 0
        },
        section(section) {
          sections.push(section)
          return () => {}
        },
      },
    }),
  )
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'tool:terminal-panel')
  assert.equal(sections[0].order, 1700)
  assert.ok(sections[0].text.includes('live_terminal_screenshot'))
})

test('the terminal-session disposer disposes the registry', async () => {
  const { ctx, calls } = makeContext({
    services: { subprocess: fakeSubprocess(), workingDirectory: { defaultDirectory: 'C:\\work' } },
  })
  apply(ctx, {})
  const openTool = calls.tools.find((definition) => definition.name === 'live_terminal_open')
  const backendEffect = calls.effects.find((effect) => effect.label === 'dsh-live-terminal: terminal sessions')
  await backendEffect.disposer()
  await assert.rejects(
    () => openTool.execute({}, { agent: { id: 'agent-1' } }),
    /terminal registry disposed/,
  )
})
