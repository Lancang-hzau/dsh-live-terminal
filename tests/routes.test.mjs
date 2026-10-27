import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { MAX_STREAM_BUFFER_BYTES, ROUTE_PREFIX, SSE_SNAPSHOT_SCROLLBACK, registerRoutes } from '../lib/host/routes.js'

/** One plain `SessionInfo` used by every route test. */
const SESSION_INFO = {
  id: 's1',
  title: 'Get-ChildItem',
  kind: 'command',
  owner: 'agent',
  sessionId: 'ds-session-1',
  cwd: 'C:\\work',
  cols: 120,
  rows: 30,
  state: 'running',
  exitCode: null,
  createdAt: 1,
  updatedAt: 2,
}

/** Largest JSON request body accepted by the routes (`MAX_BODY_BYTES`). */
const MAX_BODY_BYTES = 1024 * 1024
/** Largest terminal input payload accepted by `/input` (`MAX_INPUT_BYTES`). */
const MAX_INPUT_BYTES = 64 * 1024

/** @returns {Promise<void>} resolves after pending microtasks/macrotasks. */
function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Minimal `IncomingMessage` double: JSON bodies are emitted as `data`/`end`.
 */
class FakeRequest extends EventEmitter {
  /**
   * @param {{ url?: string, method?: string }} [options] request fields.
   */
  constructor({ url = '/', method = 'GET' } = {}) {
    super()
    this.url = url
    this.method = method
    this.socket = { setNoDelay() {} }
    this.resumed = false
  }

  /** Mark the request body as drained. @returns {void} */
  resume() {
    this.resumed = true
  }
}

/**
 * Minimal `ServerResponse` double recording frames and honouring `write()`'s
 * boolean backpressure return.
 */
class FakeResponse extends EventEmitter {
  /**
   * @param {{ writeResults?: boolean[] }} [options] scripted `write()` return values.
   */
  constructor({ writeResults = [] } = {}) {
    super()
    this.writeResults = [...writeResults]
    this.frames = []
    this.statusCode = undefined
    this.headers = undefined
    this.ended = false
    this.endCalls = 0
    this.endBody = undefined
    this.destroyed = false
    this.writeAfterEnd = 0
  }

  /** @returns {boolean} whether headers were written. */
  get headersSent() {
    return this.statusCode !== undefined
  }

  /**
   * @param {number} status status code.
   * @param {Record<string, string>} [headers] response headers.
   * @returns {this} this response.
   */
  writeHead(status, headers) {
    this.statusCode = status
    this.headers = headers ?? {}
    return this
  }

  /** @returns {void} */
  flushHeaders() {}

  /**
   * @param {string | Buffer} chunk response chunk.
   * @returns {boolean} whether the caller may keep writing immediately.
   */
  write(chunk) {
    if (this.ended) {
      this.writeAfterEnd += 1
      return false
    }
    this.frames.push(String(chunk))
    return this.writeResults.length > 0 ? this.writeResults.shift() === true : true
  }

  /**
   * @param {string | Buffer} [chunk] final chunk.
   * @returns {void}
   */
  end(chunk) {
    this.endCalls += 1
    if (chunk !== undefined) this.endBody = String(chunk)
    this.ended = true
  }

  /** @returns {void} */
  destroy() {
    this.destroyed = true
  }
}

/**
 * Session double with the subset the SSE/HTTP routes use.
 * @param {object} [overrides] field overrides.
 * @returns {{ session: any, subscription: { listeners: any[], unsubscribed: boolean } }} fake session.
 */
function fakeSession(overrides = {}) {
  const subscription = { listeners: [], unsubscribed: false }
  const snapshotCalls = []
  const session = {
    id: SESSION_INFO.id,
    title: SESSION_INFO.title,
    state: 'running',
    info: SESSION_INFO,
    cols: SESSION_INFO.cols,
    rows: SESSION_INFO.rows,
    writes: [],
    resizes: [],
    signals: [],
    captures: [],
    attached: [],
    detached: [],
    snapshotCalls,
    snapshot(options) {
      snapshotCalls.push(options)
      return { info: SESSION_INFO, screen: 'ansi-screen', text: 'visible', cursor: { x: 1, y: 2 }, seq: 7 }
    },
    subscribe(listener) {
      subscription.listeners.push(listener)
      return () => {
        subscription.unsubscribed = true
      }
    },
    async write(data) {
      this.writes.push(data)
    },
    async resize(cols, rows) {
      this.resizes.push([cols, rows])
    },
    async sendSignal(name) {
      this.signals.push(name)
      return { delivered: name }
    },
    isWritable(clientId) {
      return this.writerClientId === undefined || this.writerClientId === clientId
    },
    takeControl(clientId) {
      this.writerClientId = clientId
    },
    attachClient(clientId) {
      this.attached.push(clientId)
    },
    detachClient(clientId) {
      this.detached.push(clientId)
    },
    framesSince(seq) {
      return this.frames.filter((frame) => frame.seq > seq)
    },
    frames: [
      { seq: 1, chunk: 'a' },
      { seq: 2, chunk: 'b' },
    ],
    resolveCapture(requestId, payload) {
      this.captures.push({ requestId, payload })
    },
    ...overrides,
  }
  return { session, subscription }
}

/**
 * Registry double covering every registry call the routes make.
 * @param {{ session?: any, sessions?: Map<string, any> }} [options] known sessions.
 * @returns {any} fake registry with typed call recording.
 */
function fakeRegistry({ session, sessions } = {}) {
  const known = sessions ?? new Map([[SESSION_INFO.id, session ?? fakeSession().session]])
  const historyEntries = []
  const calls = {
    list: 0,
    lookup: [],
    created: [],
    closed: [],
    resolveSessionCwd: [],
    subscribeEvents: [],
    unsubscribed: false,
    kept: [],
    paused: [],
    resumed: [],
    renamed: [],
    replayed: [],
    exported: [],
    historyQuery: [],
  }
  return {
    calls,
    historyEntries,
    get size() {
      return known.size
    },
    list() {
      calls.list += 1
      return [...known.values()].map((entry) => entry.info)
    },
    lookup(id) {
      calls.lookup.push(id)
      return known.get(id)
    },
    async resolveSessionCwd(id) {
      calls.resolveSessionCwd.push(id)
      return 'C:\\session-workspace'
    },
    async createInteractive(options) {
      calls.created.push(options)
      return { info: { ...SESSION_INFO, id: 'new-1', cwd: options.cwd ?? 'C:\\work' } }
    },
    async close(id) {
      calls.closed.push(id)
      return true
    },
    keep(id) {
      calls.kept.push(id)
      return { ...SESSION_INFO, id, pinned: true, autoCloseAt: null }
    },
    pauseAutoClose(id) {
      calls.paused.push(id)
      return { ...SESSION_INFO, id, autoClosePaused: true }
    },
    resumeAutoClose(id) {
      calls.resumed.push(id)
      return { ...SESSION_INFO, id, autoClosePaused: false }
    },
    async setTitle(id, title) {
      calls.renamed.push({ id, title })
      return { ...SESSION_INFO, id, title }
    },
    historyList(limit, terminalId) {
      calls.historyQuery.push({ limit, terminalId })
      return historyEntries.slice(0, limit)
    },
    replay(id, fromSeq) {
      calls.replayed.push({ id, fromSeq })
      return { frames: [{ seq: 1, chunk: 'replayed' }], nextSeq: 2 }
    },
    exportSession(id, format) {
      calls.exported.push({ id, format })
      return { text: `exported-${id}-${format}`, bytes: 17, truncated: false }
    },
    subscribeEvents(listener) {
      calls.subscribeEvents.push(listener)
      return () => {
        calls.unsubscribed = true
      }
    },
  }
}

/**
 * Register the routes against a fake web context and capture the handler.
 * @param {{ admission?: any, registry?: any, connection?: any, omitConnection?: boolean }} [options] route dependencies.
 * @returns {{ handler: Function, registry: any, webCtx: any }} captured handler and dependencies.
 */
function setupRoutes({ admission = { peer: {} }, registry = fakeRegistry(), connection, omitConnection = false, config, resolveSandboxPolicy } = {}) {
  const webCtx = {
    connection: omitConnection ? undefined : connection === undefined ? { admit: () => admission } : connection,
    webServer: {
      spec: undefined,
      register(spec) {
        this.spec = spec
        return () => {}
      },
    },
    effect(factory) {
      const disposer = factory()
      this.disposed = disposer
      return () => {}
    },
  }
  registerRoutes(webCtx, { registry, config, resolveSandboxPolicy })
  assert.ok(webCtx.webServer.spec, 'webServer.register must be called')
  return { handler: webCtx.webServer.spec.handler, registry, webCtx }
}

/**
 * Dispatch one request through the captured route handler and wait for the
 * promise chain to settle. POST helpers emit the JSON body afterwards, exactly
 * like an incoming HTTP request.
 * @param {Function} handler captured route handler.
 * @param {{ url?: string, method?: string, body?: string | Buffer | Buffer[] }} [options] request fields.
 * @returns {Promise<{ req: FakeRequest, res: FakeResponse }>} request/response pair.
 */
async function dispatch(handler, { url = '/', method = 'GET', body } = {}) {
  const req = new FakeRequest({ url: ROUTE_PREFIX + url, method })
  const res = new FakeResponse()
  handler(req, res)
  if (body !== undefined) {
    const chunks = Array.isArray(body) ? body : [body]
    for (const chunk of chunks) req.emit('data', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    req.emit('end')
  }
  await tick()
  return { req, res }
}

/**
 * Dispatch one SSE request with scripted `write()` backpressure results.
 * @param {Function} handler captured route handler.
 * @param {string} url request path (without prefix).
 * @param {boolean[]} writeResults scripted `res.write` return values.
 * @returns {Promise<{ req: FakeRequest, res: FakeResponse }>} request/response pair.
 */
async function dispatchSse(handler, url, writeResults) {
  const req = new FakeRequest({ url: ROUTE_PREFIX + url })
  const res = new FakeResponse({ writeResults })
  handler(req, res)
  await tick()
  return { req, res }
}

/**
 * @param {FakeResponse} res response.
 * @returns {any} parsed JSON body.
 */
function jsonBody(res) {
  return JSON.parse(res.endBody)
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

test('admission rejections return 401/403 before any route runs', async () => {
  for (const [rejection, status, text] of [
    [401, 401, 'unauthorized'],
    [403, 403, 'forbidden'],
  ]) {
    const registry = fakeRegistry()
    const { handler } = setupRoutes({ admission: { rejection }, registry })
    const { res } = await dispatch(handler, { url: '/sessions' })
    assert.equal(res.statusCode, status)
    assert.equal(res.endBody, text)
    assert.equal(registry.calls.list, 0, 'rejected requests must not reach the registry')
  }
})

test('returns 503 when the connection service is missing', async () => {
  const { handler } = setupRoutes({ omitConnection: true })
  const { res } = await dispatch(handler, { url: '/sessions' })
  assert.equal(res.statusCode, 503)
  assert.match(jsonBody(res).error, /connection service/)
})

/* ------------------------------------------------------------------ */
/* GET routes                                                          */
/* ------------------------------------------------------------------ */

test('GET /sessions returns the session list', async () => {
  const { handler } = setupRoutes()
  const { res } = await dispatch(handler, { url: '/sessions' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(jsonBody(res), { sessions: [SESSION_INFO] })
})

test('GET /snapshot returns the screen, seq and writerClientId, missing ids are 400/404', async () => {
  const { session } = fakeSession({ writerClientId: 'client-7' })
  const { handler } = setupRoutes({ registry: fakeRegistry({ session }) })
  const { res } = await dispatch(handler, { url: '/snapshot?id=s1' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(jsonBody(res), {
    info: SESSION_INFO,
    screen: 'ansi-screen',
    text: 'visible',
    cursor: { x: 1, y: 2 },
    seq: 7,
    writerClientId: 'client-7',
  })
  assert.deepEqual(session.snapshotCalls, [{ scrollback: SSE_SNAPSHOT_SCROLLBACK }], 'HTTP snapshots bound the scrollback')

  const missing = await dispatch(handler, { url: '/snapshot?id=missing' })
  assert.equal(missing.res.statusCode, 404)
  assert.match(jsonBody(missing.res).error, /not found/)

  const withoutId = await dispatch(handler, { url: '/snapshot' })
  assert.equal(withoutId.res.statusCode, 400)
  assert.match(jsonBody(withoutId.res).error, /id is required/)
})

test('GET /ping, / and unknown paths respond', async () => {
  const { handler } = setupRoutes()
  const ping = await dispatch(handler, { url: '/ping' })
  assert.equal(ping.res.statusCode, 200)
  assert.deepEqual(jsonBody(ping.res), { ok: true, plugin: 'dsh-live-terminal', version: '1.3.1', sessions: 1 })

  const index = await dispatch(handler, { url: '/' })
  assert.equal(index.res.statusCode, 200)
  assert.equal(jsonBody(index.res).version, '1.3.1')
  assert.deepEqual(jsonBody(index.res).routes, [
    'config',
    'sessions',
    'snapshot',
    'events',
    'history',
    'replay',
    'export',
    'create',
    'input',
    'resize',
    'close',
    'keep',
    'auto-close',
    'rename',
    'take-control',
    'signal',
    'capture',
    'ping',
  ])

  const unknown = await dispatch(handler, { url: '/nope' })
  assert.equal(unknown.res.statusCode, 404)
  assert.match(jsonBody(unknown.res).error, /unknown route/)
})

/* ------------------------------------------------------------------ */
/* POST routes + validation                                            */
/* ------------------------------------------------------------------ */

test('POST /input writes terminal input and enforces the 64 KiB cap', async () => {
  const session = fakeSession().session
  const { handler } = setupRoutes({ registry: fakeRegistry({ session }) })

  const ok = await dispatch(handler, { url: '/input', method: 'POST', body: JSON.stringify({ id: 's1', data: 'hi' }) })
  assert.equal(ok.res.statusCode, 200)
  assert.deepEqual(jsonBody(ok.res), { ok: true })
  assert.deepEqual(session.writes, ['hi'])

  const tooBig = await dispatch(handler, {
    url: '/input',
    method: 'POST',
    body: JSON.stringify({ id: 's1', data: 'x'.repeat(MAX_INPUT_BYTES + 1) }),
  })
  assert.equal(tooBig.res.statusCode, 413)
  assert.match(jsonBody(tooBig.res).error, /exceeds 65536 bytes/)
  assert.deepEqual(session.writes, ['hi'], 'oversized input must not be written')

  const missing = await dispatch(handler, { url: '/input', method: 'POST', body: JSON.stringify({ data: 'hi' }) })
  assert.equal(missing.res.statusCode, 400)
  assert.match(jsonBody(missing.res).error, /id is required/)
})

test('POST /resize validates integers and applies normalized dimensions', async () => {
  const session = fakeSession().session
  const { handler } = setupRoutes({ registry: fakeRegistry({ session }) })

  const invalid = await dispatch(handler, {
    url: '/resize',
    method: 'POST',
    body: JSON.stringify({ id: 's1', cols: 1.5, rows: 30 }),
  })
  assert.equal(invalid.res.statusCode, 400)
  assert.match(jsonBody(invalid.res).error, /must be integers/)

  const ok = await dispatch(handler, {
    url: '/resize',
    method: 'POST',
    body: JSON.stringify({ id: 's1', cols: 100, rows: 40 }),
  })
  assert.equal(ok.res.statusCode, 200)
  assert.deepEqual(session.resizes, [[100, 40]])
})

test('POST /close requires an id, 404s unknown sessions and closes known ones', async () => {
  const registry = fakeRegistry()
  const { handler } = setupRoutes({ registry })

  const missing = await dispatch(handler, { url: '/close', method: 'POST', body: JSON.stringify({}) })
  assert.equal(missing.res.statusCode, 400)

  const unknown = await dispatch(handler, { url: '/close', method: 'POST', body: JSON.stringify({ id: 'nope' }) })
  assert.equal(unknown.res.statusCode, 404)

  const ok = await dispatch(handler, { url: '/close', method: 'POST', body: JSON.stringify({ id: 's1' }) })
  assert.equal(ok.res.statusCode, 200)
  assert.deepEqual(registry.calls.closed, ['s1'])
})

test('POST /create opens a user terminal in the requested or session workspace', async () => {
  const explicitRegistry = fakeRegistry()
  const explicit = await dispatch(setupRoutes({ registry: explicitRegistry }).handler, {
    url: '/create',
    method: 'POST',
    body: JSON.stringify({ cols: 100, rows: 40, title: ' build ', sessionId: 'sess-1', cwd: 'C:\\custom' }),
  })
  assert.equal(explicit.res.statusCode, 200)
  assert.deepEqual(jsonBody(explicit.res), { session: { ...SESSION_INFO, id: 'new-1', cwd: 'C:\\custom' } })
  assert.deepEqual(explicitRegistry.calls.created, [
    { cols: 100, rows: 40, title: 'build', sessionId: 'sess-1', cwd: 'C:\\custom', owner: 'user' },
  ])
  assert.deepEqual(explicitRegistry.calls.resolveSessionCwd, [], 'explicit cwd skips session resolution')

  const sessionRegistry = fakeRegistry()
  const inferred = await dispatch(setupRoutes({ registry: sessionRegistry }).handler, {
    url: '/create',
    method: 'POST',
    body: JSON.stringify({ sessionId: 'sess-1' }),
  })
  assert.equal(inferred.res.statusCode, 200)
  assert.deepEqual(sessionRegistry.calls.resolveSessionCwd, ['sess-1'])
  assert.equal(sessionRegistry.calls.created[0].cwd, 'C:\\session-workspace')
  assert.equal(sessionRegistry.calls.created[0].owner, 'user')
})

test('POST bodies are bounded and must be a JSON object', async () => {
  const { handler } = setupRoutes()

  const invalidJson = await dispatch(handler, { url: '/input', method: 'POST', body: 'not-json' })
  assert.equal(invalidJson.res.statusCode, 400)
  assert.match(jsonBody(invalidJson.res).error, /invalid JSON/)

  const tooLarge = await dispatch(handler, {
    url: '/input',
    method: 'POST',
    body: Buffer.alloc(MAX_BODY_BYTES + 1, 0x61),
  })
  assert.equal(tooLarge.res.statusCode, 413)
  assert.match(jsonBody(tooLarge.res).error, /exceeds 1048576 bytes/)

  const notObject = await dispatch(handler, { url: '/input', method: 'POST', body: '[1,2]' })
  assert.equal(notObject.res.statusCode, 400)
  assert.match(jsonBody(notObject.res).error, /must be an object/)
})

/* ------------------------------------------------------------------ */
/* v1.2.1 routes: config, history, replay, export, leases, capture      */
/* ------------------------------------------------------------------ */

test('GET /config exposes the effective config, sandbox mode and shell', async () => {
  const config = {
    interceptShellTools: true,
    scrollback: 2000,
    maxOutputBytes: 262144,
    maxSessions: 16,
    perSessionMaxSessions: 8,
    commandTimeoutMs: 180000,
    retainExited: 10,
    historySize: 20,
    historyPersist: true,
    interceptMinVisibleMs: 1500,
    autoCloseCommandDelayMs: 8000,
    autoCloseFailedDelayMs: 30000,
    autoCloseToolTerminals: true,
    autoCloseNotice: 'all',
    requireSandbox: true,
    allowUnconfined: false,
    portDetection: true,
    shellPath: 'C:\\pwsh.exe',
  }
  const { handler } = setupRoutes({
    config,
    resolveSandboxPolicy: () => ({ mode: 'workspace-write', workspaceRoot: 'C:\\work', available: true }),
  })
  const { res } = await dispatch(handler, { url: '/config' })
  assert.equal(res.statusCode, 200)
  const body = jsonBody(res)
  assert.equal(body.version, '1.3.1')
  assert.equal(body.config.historySize, 20)
  assert.equal(body.config.perSessionMaxSessions, 8)
  assert.equal(body.config.autoCloseNotice, 'all')
  assert.equal(body.config.shellPath, 'C:\\pwsh.exe')
  assert.equal(body.config.requireSandbox, true)
  assert.equal(body.config.allowUnconfined, false)
  assert.equal('historyPath' in body.config, false, 'the history file path must not leak over HTTP')
  assert.deepEqual(body.sandbox, { mode: 'workspace-write', available: true })
  assert.deepEqual(body.shell, { path: 'C:\\pwsh.exe' })
})

test('GET /sessions filters by the DSH sessionId', async () => {
  const { handler } = setupRoutes()
  const matching = await dispatch(handler, { url: '/sessions?sessionId=ds-session-1' })
  assert.equal(matching.res.statusCode, 200)
  assert.deepEqual(jsonBody(matching.res), { sessions: [SESSION_INFO] })

  const other = await dispatch(handler, { url: '/sessions?sessionId=ds-session-2' })
  assert.deepEqual(jsonBody(other.res), { sessions: [] })
})

test('GET /history returns recent closed commands with limit and terminalId filters', async () => {
  const registry = fakeRegistry()
  registry.historyEntries.push({ id: 'h1', title: 'build' }, { id: 'h2', title: 'test' })
  const { handler } = setupRoutes({ registry })

  const all = await dispatch(handler, { url: '/history' })
  assert.equal(all.res.statusCode, 200)
  assert.deepEqual(jsonBody(all.res), { entries: registry.historyEntries })
  assert.deepEqual(registry.calls.historyQuery[0], { limit: 20, terminalId: undefined })

  const filtered = await dispatch(handler, { url: '/history?limit=5&terminalId=h2' })
  assert.deepEqual(registry.calls.historyQuery[1], { limit: 5, terminalId: 'h2' })
  assert.deepEqual(jsonBody(filtered.res), { entries: registry.historyEntries.slice(0, 5) })

  const clamped = await dispatch(handler, { url: '/history?limit=9999' })
  assert.equal(clamped.res.statusCode, 200)
  assert.deepEqual(registry.calls.historyQuery[2], { limit: 100, terminalId: undefined })
})

test('GET /replay returns retained output frames after fromSeq', async () => {
  const registry = fakeRegistry()
  const { handler } = setupRoutes({ registry })
  const { res } = await dispatch(handler, { url: '/replay?id=s1&fromSeq=3' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(jsonBody(res), { frames: [{ seq: 1, chunk: 'replayed' }], nextSeq: 2 })
  assert.deepEqual(registry.calls.replayed, [{ id: 's1', fromSeq: 3 }])

  const missing = await dispatch(handler, { url: '/replay' })
  assert.equal(missing.res.statusCode, 400)
})

test('GET /export downloads a text or ANSI attachment', async () => {
  const registry = fakeRegistry()
  const { handler } = setupRoutes({ registry })

  const ansi = await dispatch(handler, { url: '/export?id=s1&format=ansi' })
  assert.equal(ansi.res.statusCode, 200)
  assert.equal(ansi.res.headers['Content-Type'], 'text/plain; charset=utf-8')
  assert.equal(ansi.res.headers['Content-Disposition'], 'attachment; filename="terminal-s1.ansi"')
  assert.equal(ansi.res.endBody, 'exported-s1-ansi')
  assert.deepEqual(registry.calls.exported, [{ id: 's1', format: 'ansi' }])

  const text = await dispatch(handler, { url: '/export?id=s1' })
  assert.equal(text.res.statusCode, 200)
  assert.equal(text.res.headers['Content-Disposition'], 'attachment; filename="terminal-s1.txt"')
  assert.deepEqual(registry.calls.exported[1], { id: 's1', format: 'text' })

  const missing = await dispatch(handler, { url: '/export' })
  assert.equal(missing.res.statusCode, 400)
})

test('POST /keep, /auto-close, /rename and /signal update the session', async () => {
  const session = fakeSession().session
  const registry = fakeRegistry({ session })
  const { handler } = setupRoutes({ registry })

  const kept = await dispatch(handler, { url: '/keep', method: 'POST', body: JSON.stringify({ id: 's1' }) })
  assert.equal(kept.res.statusCode, 200)
  assert.equal(jsonBody(kept.res).ok, true)
  assert.equal(jsonBody(kept.res).info.pinned, true)
  assert.deepEqual(registry.calls.kept, ['s1'])

  const paused = await dispatch(handler, { url: '/auto-close', method: 'POST', body: JSON.stringify({ id: 's1', action: 'pause' }) })
  assert.equal(jsonBody(paused.res).info.autoClosePaused, true)
  const resumed = await dispatch(handler, { url: '/auto-close', method: 'POST', body: JSON.stringify({ id: 's1', action: 'resume' }) })
  assert.equal(jsonBody(resumed.res).info.autoClosePaused, false)
  assert.deepEqual(registry.calls.paused, ['s1'])
  assert.deepEqual(registry.calls.resumed, ['s1'])

  const renamed = await dispatch(handler, { url: '/rename', method: 'POST', body: JSON.stringify({ id: 's1', title: ' build ' }) })
  assert.equal(jsonBody(renamed.res).info.title, 'build')
  assert.deepEqual(registry.calls.renamed, [{ id: 's1', title: 'build' }])
  const blank = await dispatch(handler, { url: '/rename', method: 'POST', body: JSON.stringify({ id: 's1', title: '  ' }) })
  assert.equal(blank.res.statusCode, 400)

  const signalled = await dispatch(handler, { url: '/signal', method: 'POST', body: JSON.stringify({ id: 's1', signal: 'SIGTERM' }) })
  assert.deepEqual(jsonBody(signalled.res), { ok: true, delivered: 'SIGTERM' })
  const fallback = await dispatch(handler, { url: '/signal', method: 'POST', body: JSON.stringify({ id: 's1' }) })
  assert.deepEqual(jsonBody(fallback.res), { ok: true, delivered: 'SIGINT' })
  assert.deepEqual(session.signals, ['SIGTERM', 'SIGINT'])
})

test('POST /input enforces the single-writer lease and /take-control transfers it', async () => {
  const session = fakeSession().session
  const registry = fakeRegistry({ session })
  const { handler } = setupRoutes({ registry })

  const taken = await dispatch(handler, { url: '/take-control', method: 'POST', body: JSON.stringify({ id: 's1', clientId: 'client-a' }) })
  assert.equal(taken.res.statusCode, 200)
  assert.deepEqual(jsonBody(taken.res), { ok: true, writerClientId: 'client-a' })

  const readOnly = await dispatch(handler, {
    url: '/input',
    method: 'POST',
    body: JSON.stringify({ id: 's1', data: 'x', clientId: 'client-b' }),
  })
  assert.equal(readOnly.res.statusCode, 409)
  assert.equal(jsonBody(readOnly.res).code, 'READ_ONLY')
  assert.deepEqual(session.writes, [], 'a non-writer must not reach the PTY')

  const writer = await dispatch(handler, {
    url: '/input',
    method: 'POST',
    body: JSON.stringify({ id: 's1', data: 'x', clientId: 'client-a' }),
  })
  assert.equal(writer.res.statusCode, 200)
  assert.deepEqual(session.writes, ['x'])

  const missingClient = await dispatch(handler, { url: '/take-control', method: 'POST', body: JSON.stringify({ id: 's1' }) })
  assert.equal(missingClient.res.statusCode, 400)
})

test('POST /capture validates the request and resolves the pending capture', async () => {
  const { session } = fakeSession()
  const registry = fakeRegistry({ session })
  const { handler } = setupRoutes({ registry })

  const invalid = await dispatch(handler, { url: '/capture', method: 'POST', body: JSON.stringify({ id: 's1', dataUrl: 'not-a-data-url' }) })
  assert.equal(invalid.res.statusCode, 400)

  const noRequest = await dispatch(handler, {
    url: '/capture',
    method: 'POST',
    body: JSON.stringify({ id: 's1', dataUrl: 'data:image/png;base64,AAAA' }),
  })
  assert.equal(noRequest.res.statusCode, 400)
  assert.match(jsonBody(noRequest.res).error, /requestId/)

  // A 120x30 PNG with only the signature + IHDR fields the route reads.
  const png = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0)
  png.write('IHDR', 12, 'ascii')
  png.writeUInt32BE(120, 16)
  png.writeUInt32BE(30, 20)
  const ok = await dispatch(handler, {
    url: '/capture',
    method: 'POST',
    body: JSON.stringify({ id: 's1', requestId: 'r1', dataUrl: `data:image/png;base64,${png.toString('base64')}` }),
  })
  assert.equal(ok.res.statusCode, 200)
  assert.deepEqual(jsonBody(ok.res), { ok: true })
  assert.equal(session.captures.length, 1)
  assert.equal(session.captures[0].requestId, 'r1')
  assert.equal(session.captures[0].payload.width, 120)
  assert.equal(session.captures[0].payload.height, 30)
  assert.deepEqual(session.captures[0].payload.buffer, png)
})

test('POST /capture rejects a decoded payload larger than 4 MiB', async () => {
  const { handler } = setupRoutes()
  // The capture route allows an 8 MiB JSON body (base64 of a 4 MiB PNG) so the
  // decoded-size check is reachable, unlike the 1 MiB cap of every other route.
  const oversized = Buffer.alloc(4 * 1024 * 1024 + 3, 0x61)
  const body = JSON.stringify({
    id: 's1',
    requestId: 'r1',
    dataUrl: `data:image/png;base64,${oversized.toString('base64')}`,
  })
  const { res } = await dispatch(handler, { url: '/capture', method: 'POST', body })
  assert.equal(res.statusCode, 413)
  assert.match(jsonBody(res).error, /capture exceeds 4194304 bytes/)
})

test('GET /events?id= attaches the client, replays fromSeq and detaches on close', async () => {
  const { session, subscription } = fakeSession()
  const registry = fakeRegistry({ session })
  const { handler } = setupRoutes({ registry })
  const { req, res } = await dispatchSse(handler, '/events?id=s1&clientId=client-a&fromSeq=1')

  assert.equal(res.statusCode, 200)
  assert.deepEqual(session.attached, ['client-a'])
  const outputFrames = res.frames.filter((frame) => frame.startsWith('event: output'))
  assert.equal(outputFrames.length, 1)
  assert.match(outputFrames[0], /"seq":2/)
  assert.equal(subscription.listeners.length, 1)

  req.emit('close')
  assert.deepEqual(session.detached, ['client-a'])
})

/* ------------------------------------------------------------------ */
/* SSE: frames, forwarding, cleanup                                    */
/* ------------------------------------------------------------------ */

test('GET /events?id= streams the snapshot and forwards session events', async () => {
  const { session, subscription } = fakeSession()
  const registry = fakeRegistry({ session })
  const { handler } = setupRoutes({ registry })
  const { req, res } = await dispatchSse(handler, '/events?id=s1')

  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['Content-Type'], 'text/event-stream; charset=utf-8')
  assert.equal(res.headers['Cache-Control'], 'no-cache, no-transform')
  assert.equal(res.headers.Connection, 'keep-alive')
  assert.equal(res.frames[0], 'retry: 1000\n')
  assert.match(res.frames[1], /^event: snapshot\ndata: /)
  assert.ok(res.frames[1].includes('"screen":"ansi-screen"'))
  assert.deepEqual(session.snapshotCalls, [{ scrollback: SSE_SNAPSHOT_SCROLLBACK }], 'SSE first frame bounds the scrollback')
  assert.equal(subscription.listeners.length, 1)

  subscription.listeners[0]('output', { id: 's1', seq: 8, chunk: 'x' })
  assert.equal(res.frames.length, 3)
  assert.match(res.frames[2], /^event: output\ndata: /)

  req.emit('close')
  assert.equal(subscription.unsubscribed, true, 'request close must unsubscribe')
  assert.equal(res.endCalls, 1, 'request close must end the response')
  const frameCount = res.frames.length
  subscription.listeners[0]('output', { chunk: 'late' })
  assert.equal(res.frames.length, frameCount, 'no frames after cleanup')
  req.emit('close')
  assert.equal(res.endCalls, 1, 'cleanup must be idempotent')
})

test('GET /events?id= for an exited session sends snapshot and state', async () => {
  const { session } = fakeSession({ state: 'exited' })
  const { handler } = setupRoutes({ registry: fakeRegistry({ session }) })
  const { req, res } = await dispatchSse(handler, '/events?id=s1')
  assert.ok(res.frames.some((frame) => frame.startsWith('event: snapshot')))
  assert.ok(res.frames.some((frame) => frame.startsWith('event: state')))
  req.emit('close')
})

test('GET /events?id= for an unknown session is a JSON 404', async () => {
  const { handler } = setupRoutes()
  const { res } = await dispatch(handler, { url: '/events?id=missing' })
  assert.equal(res.statusCode, 404)
  assert.match(jsonBody(res).error, /not found/)
})

test('GET /events streams the global session list and forwards updates', async () => {
  const registry = fakeRegistry()
  const { handler } = setupRoutes({ registry })
  const { req, res } = await dispatchSse(handler, '/events')

  assert.equal(res.statusCode, 200)
  assert.equal(res.frames[0], 'retry: 1000\n')
  assert.match(res.frames[1], /^event: sessions\ndata: /)
  assert.ok(res.frames[1].includes('"sessions":['))
  assert.equal(registry.calls.subscribeEvents.length, 1)

  registry.calls.subscribeEvents[0]('sessions', { sessions: [] })
  assert.equal(res.frames.length, 3)

  req.emit('close')
  assert.equal(registry.calls.unsubscribed, true)
  assert.equal(res.endCalls, 1)
})

test('SSE heartbeat comments are queued as comment frames', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const { handler } = setupRoutes()
  const { req, res } = await dispatchSse(handler, '/events?id=s1')
  const before = res.frames.length
  t.mock.timers.tick(20_000)
  assert.equal(res.frames.length, before + 1)
  assert.equal(res.frames[before], ': ping\n\n')
  req.emit('close')
})

/* ------------------------------------------------------------------ */
/* SSE: backpressure + bounded backlog                                 */
/* ------------------------------------------------------------------ */

test('SSE pauses on res.write(false) and flushes queued frames on drain in order', async () => {
  const { session, subscription } = fakeSession()
  const { handler } = setupRoutes({ registry: fakeRegistry({ session }) })
  // First write (retry) succeeds; the snapshot write reports a full socket buffer.
  const { req, res } = await dispatchSse(handler, '/events?id=s1', [true, false])

  assert.equal(res.frames.length, 2, 'retry + snapshot were handed to the socket')
  assert.match(res.frames[1], /^event: snapshot/)

  subscription.listeners[0]('output', { chunk: 'a' })
  subscription.listeners[0]('output', { chunk: 'b' })
  assert.equal(res.frames.length, 2, 'frames are queued while the socket is full')

  res.emit('drain')
  assert.equal(res.frames.length, 4, 'drain flushes the queue')
  assert.match(res.frames[2], /"chunk":"a"/)
  assert.match(res.frames[3], /"chunk":"b"/)

  subscription.listeners[0]('output', { chunk: 'c' })
  assert.equal(res.frames.length, 5, 'writes resume normally once drained')

  req.emit('close')
})

test('SSE drops a follower whose queued backlog exceeds the byte cap', async () => {
  const { session, subscription } = fakeSession()
  const { handler } = setupRoutes({ registry: fakeRegistry({ session }) })
  const { req, res } = await dispatchSse(handler, '/events?id=s1', [true, false])
  assert.equal(res.frames.length, 2)

  // While paused, frames accumulate; two ~2 MiB frames exceed the 4 MiB cap.
  const chunk = 'x'.repeat(Math.floor(MAX_STREAM_BUFFER_BYTES / 2) + 1024)
  subscription.listeners[0]('output', { chunk })
  assert.equal(res.endCalls, 0, 'a single frame under the cap stays queued')
  subscription.listeners[0]('output', { chunk })
  assert.equal(res.endCalls, 1, 'exceeding the cap closes the follower')
  assert.equal(res.ended, true)

  const frameCount = res.frames.length
  subscription.listeners[0]('output', { chunk: 'after' })
  assert.equal(res.frames.length, frameCount, 'closed writer must not write again')
  assert.equal(res.writeAfterEnd, 0)
  res.emit('drain')
  assert.equal(res.frames.length, frameCount, 'drain listener was removed on close')

  req.emit('close')
  assert.equal(res.endCalls, 1, 'cleanup after close is idempotent')
})
