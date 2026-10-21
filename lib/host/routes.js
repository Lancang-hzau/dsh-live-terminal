/**
 * Authenticated HTTP + SSE surface of the terminal panel (v1.2.1).
 *
 * Every route lives under `/dsh-terminal-panel` and authenticates through
 * `ctx.connection.admit(req)` — the same trusted-origin + signed-cookie
 * admission the Web GUI uses. The wire format is plain JSON; SSE carries the
 * `snapshot` / `output` / `state` / `exit` / `capture-request` event stream per
 * session, a global `sessions` stream for the session list, and global `notice`
 * events for failures/ports/capture requests.
 */

import { normalizeDimensions } from './registry.js'

/** Route prefix registered with the web server. */
export const ROUTE_PREFIX = '/dsh-terminal-panel'
/** Plugin version exposed by `/ping` and `/config`. Keep in sync with package.json (tested). */
export const PLUGIN_VERSION = '1.2.1'
/** Largest accepted JSON request body. */
const MAX_BODY_BYTES = 1024 * 1024
/** Largest accepted terminal input payload (raw UTF-8 bytes). */
const MAX_INPUT_BYTES = 64 * 1024
/** Largest accepted PNG capture payload (decoded bytes). */
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024
/** JSON body bound for a base64 PNG capture (decoded 4MiB + JSON overhead). */
const MAX_CAPTURE_BODY_BYTES = 8 * 1024 * 1024
/**
 * Largest per-connection SSE backlog (queued bytes for a slow client). When a
 * follower falls further behind than this it is dropped: EventSource reconnects
 * after `retry: 1000` and receives a fresh snapshot, which is cheaper than
 * letting the Host buffer an unbounded terminal stream in memory.
 */
export const MAX_STREAM_BUFFER_BYTES = 4 * 1024 * 1024
/**
 * Scrollback rows serialized into browser-facing snapshots (`/snapshot` and the
 * per-session SSE first frame). Bounding the serialized screen keeps a single
 * frame comfortably below {@link MAX_STREAM_BUFFER_BYTES}, so a large scrollback
 * can never make the SSE follower trip the queue cap and reconnect-loop. Tool
 * screenshots are unaffected: they keep the full retained buffer unless they ask
 * for a bound.
 */
export const SSE_SNAPSHOT_SCROLLBACK = 500
/** SSE heartbeat interval. */
const HEARTBEAT_MS = 20_000
/** Route list advertised by `GET /`. */
const ROUTE_LIST = [
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
]

/**
 * Register the panel routes on a context that has `webServer` and `connection`.
 * @param {any} webCtx context owning webServer + connection.
 * @param {{ get registry(): any, config: any, resolveSandboxPolicy?: (agent: any) => any }} plugin host plugin state.
 * @returns {void}
 */
export function registerRoutes(webCtx, plugin) {
  webCtx.effect(
    () =>
      webCtx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => {
          handleRequest(webCtx, plugin, req, res).catch((error) => {
            if (res.headersSent) {
              try {
                res.destroy()
              } catch {
                // already gone
              }
              return
            }
            const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500
            sendJson(res, status, {
              error: error instanceof Error ? error.message : String(error),
              ...(typeof error?.code === 'string' ? { code: error.code } : {}),
            })
          })
        },
      }),
    'dsh-live-terminal: http + sse routes',
  )
}

/**
 * @param {any} webCtx web context.
 * @param {{ get registry(): any, config: any }} plugin plugin state.
 * @param {import('node:http').IncomingMessage} req request.
 * @param {import('node:http').ServerResponse} res response.
 * @returns {Promise<void>} handler completion.
 */
async function handleRequest(webCtx, plugin, req, res) {
  const url = new URL(req.url ?? '/', 'http://dsh.invalid')
  const pathname = url.pathname
  const method = req.method ?? 'GET'

  const connection = webCtx.connection
  if (connection === undefined || typeof connection.admit !== 'function') {
    sendJson(res, 503, { error: 'terminal panel requires the connection service' })
    return
  }
  const admission = connection.admit(req)
  if (admission === undefined || admission === null || 'rejection' in admission) {
    const code = admission?.rejection === 403 ? 403 : 401
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(code === 401 ? 'unauthorized' : 'forbidden')
    return
  }

  const route = pathname.slice(ROUTE_PREFIX.length)
  const registry = plugin.registry
  if (registry === undefined) {
    sendJson(res, 503, { error: 'terminal backend is not ready yet' })
    return
  }

  if (route === '/config' && method === 'GET') {
    const sandbox = typeof plugin.resolveSandboxPolicy === 'function'
      ? plugin.resolveSandboxPolicy(undefined)
      : { mode: 'danger-full-access', workspaceRoot: undefined, available: false }
    sendJson(res, 200, {
      version: PLUGIN_VERSION,
      config: publicConfig(plugin.config),
      sandbox: { mode: sandbox.mode, available: sandbox.available === true },
      shell: { path: plugin.config.shellPath ?? null },
    })
    return
  }
  if (route === '/sessions' && method === 'GET') {
    const sessionId = url.searchParams.get('sessionId')
    const sessions = sessionId === null || sessionId.length === 0
      ? registry.list()
      : registry.list().filter((session) => session.sessionId === sessionId)
    sendJson(res, 200, { sessions })
    return
  }
  if (route === '/snapshot' && method === 'GET') {
    const session = requireSession(registry, url.searchParams.get('id'))
    // Bound the serialized scrollback so a huge retained buffer cannot produce a
    // multi-megabyte JSON frame (the client still gets the viewport text).
    const snapshot = session.snapshot({ scrollback: SSE_SNAPSHOT_SCROLLBACK })
    sendJson(res, 200, {
      info: snapshot.info,
      screen: snapshot.screen,
      text: snapshot.text,
      cursor: snapshot.cursor,
      seq: snapshot.seq ?? 0,
      ...(typeof session.writerClientId === 'string' ? { writerClientId: session.writerClientId } : {}),
    })
    return
  }
  if (route === '/events' && method === 'GET') {
    const id = url.searchParams.get('id')
    const clientId = url.searchParams.get('clientId') ?? ''
    const fromSeq = numberParam(url.searchParams.get('fromSeq'), -1)
    if (id === null || id.length === 0) openGlobalEvents(req, res, registry)
    else openSessionEvents(req, res, registry, id, clientId, fromSeq)
    return
  }
  if (route === '/history' && method === 'GET') {
    const limit = Math.max(1, Math.min(100, numberParam(url.searchParams.get('limit'), 20)))
    const terminalId = url.searchParams.get('terminalId') ?? undefined
    sendJson(res, 200, { entries: registry.historyList(limit, terminalId) })
    return
  }
  if (route === '/replay' && method === 'GET') {
    const id = url.searchParams.get('id')
    if (typeof id !== 'string' || id.length === 0) throw httpError(400, 'id is required')
    const fromSeq = numberParam(url.searchParams.get('fromSeq'), -1)
    const result = registry.replay(id, fromSeq)
    sendJson(res, 200, result)
    return
  }
  if (route === '/export' && method === 'GET') {
    const id = url.searchParams.get('id')
    if (typeof id !== 'string' || id.length === 0) throw httpError(400, 'id is required')
    const format = url.searchParams.get('format') === 'ansi' ? 'ansi' : 'text'
    const exported = registry.exportSession(id, format)
    const filename = `terminal-${id}.${format === 'ansi' ? 'ansi' : 'txt'}`
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    })
    res.end(exported.text)
    return
  }
  if (route === '/create' && method === 'POST') {
    const body = await readJsonBody(req)
    const sessionId = typeof body.sessionId === 'string' && body.sessionId.length > 0 ? body.sessionId : undefined
    const requestedCwd = typeof body.cwd === 'string' && body.cwd.length > 0 ? body.cwd : undefined
    // The UI passes the DSH session id; open in that session's workspace
    // instead of the host process directory when it can be resolved (live
    // session or persisted session header via ctx.sessionQuery).
    const sessionCwd = requestedCwd === undefined ? await registry.resolveSessionCwd(sessionId) : undefined
    const shellKindHint = body.shell === 'pwsh' || body.shell === 'bash' || body.shell === 'cmd' ? body.shell : undefined
    const env = normalizeEnv(body.env)
    const createOptions = {
      cols: safeInteger(body.cols),
      rows: safeInteger(body.rows),
      title: typeof body.title === 'string' && body.title.trim().length > 0 ? body.title.trim().slice(0, 200) : undefined,
      sessionId,
      cwd: requestedCwd ?? sessionCwd,
      owner: 'user',
    }
    if (shellKindHint !== undefined) createOptions.shellKindHint = shellKindHint
    if (env !== undefined) createOptions.env = env
    const session = await registry.createInteractive(createOptions)
    sendJson(res, 200, { session: session.info })
    return
  }
  if (route === '/input' && method === 'POST') {
    const body = await readJsonBody(req)
    const session = requireSession(registry, body.id)
    const data = typeof body.data === 'string' ? body.data : ''
    if (Buffer.byteLength(data, 'utf8') > MAX_INPUT_BYTES) throw httpError(413, `input data exceeds ${MAX_INPUT_BYTES} bytes`)
    const clientId = typeof body.clientId === 'string' ? body.clientId : ''
    if (clientId.length > 0) {
      if (typeof session.isWritable === 'function' && session.isWritable(clientId) !== true) {
        const error = httpError(409, 'another client owns this terminal input; take control first')
        ;(/** @type {any} */ (error)).code = 'READ_ONLY'
        throw error
      }
      if (typeof session.takeControl === 'function' && (session.writerClientId === undefined || session.writerClientId === null)) {
        session.takeControl(clientId)
      }
    }
    if (session.state !== 'running') {
      // A keystroke can race the session exit; report a no-op instead of a 5xx
      // so the browser does not log a noisy failed request while the tab closes.
      sendJson(res, 200, { ok: false, reason: 'not-running' })
      return
    }
    await session.write(data)
    sendJson(res, 200, { ok: true })
    return
  }
  if (route === '/resize' && method === 'POST') {
    const body = await readJsonBody(req)
    const session = requireSession(registry, body.id)
    if (!Number.isSafeInteger(body.cols) || !Number.isSafeInteger(body.rows)) throw httpError(400, 'cols and rows must be integers')
    const dimensions = normalizeDimensions(body.cols, body.rows)
    if (session.state !== 'running') {
      sendJson(res, 200, { ok: false, reason: 'not-running' })
      return
    }
    try {
      await session.resize(dimensions.cols, dimensions.rows)
    } catch (error) {
      // The PTY can exit between the state check and the resize; treat it as a
      // benign no-op rather than a 500.
      sendJson(res, 200, { ok: false, reason: 'not-running', error: error instanceof Error ? error.message : String(error) })
      return
    }
    sendJson(res, 200, { ok: true })
    return
  }
  if (route === '/close' && method === 'POST') {
    const body = await readJsonBody(req)
    const session = requireSession(registry, body.id)
    const historyId = session.id
    await registry.close(session.id)
    sendJson(res, 200, { ok: true, historyId })
    return
  }
  if (route === '/keep' && method === 'POST') {
    const body = await readJsonBody(req)
    const session = requireSession(registry, body.id)
    const info = registry.keep(session.id)
    sendJson(res, 200, { ok: true, info: info ?? session.info })
    return
  }
  if (route === '/auto-close' && method === 'POST') {
    const body = await readJsonBody(req)
    const session = requireSession(registry, body.id)
    const info = body.action === 'resume' ? registry.resumeAutoClose(session.id) : registry.pauseAutoClose(session.id)
    sendJson(res, 200, { ok: true, info: info ?? session.info })
    return
  }
  if (route === '/rename' && method === 'POST') {
    const body = await readJsonBody(req)
    const session = requireSession(registry, body.id)
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : ''
    if (title.length === 0) throw httpError(400, 'title must be a non-empty string')
    const info = await registry.setTitle(session.id, title)
    sendJson(res, 200, { ok: true, info: info ?? session.info })
    return
  }
  if (route === '/take-control' && method === 'POST') {
    const body = await readJsonBody(req)
    const session = requireSession(registry, body.id)
    const clientId = typeof body.clientId === 'string' ? body.clientId : ''
    if (clientId.length === 0) throw httpError(400, 'clientId is required')
    if (typeof session.takeControl !== 'function') throw httpError(501, 'this terminal does not support input ownership')
    session.takeControl(clientId)
    sendJson(res, 200, { ok: true, writerClientId: session.writerClientId })
    return
  }
  if (route === '/signal' && method === 'POST') {
    const body = await readJsonBody(req)
    const session = requireSession(registry, body.id)
    const name = body.signal === 'SIGTERM' || body.signal === 'SIGKILL' || body.signal === 'SIGHUP' ? body.signal : 'SIGINT'
    const result = await session.sendSignal(name)
    sendJson(res, 200, { ok: true, delivered: result?.delivered ?? name })
    return
  }
  if (route === '/capture' && method === 'POST') {
    const body = await readJsonBody(req, MAX_CAPTURE_BODY_BYTES)
    const session = requireSession(registry, body.id)
    const requestId = typeof body.requestId === 'string' ? body.requestId : ''
    if (requestId.length === 0) throw httpError(400, 'requestId is required')
    const decoded = decodeDataUrl(body.dataUrl)
    if (decoded.buffer.byteLength > MAX_CAPTURE_BYTES) throw httpError(413, `capture exceeds ${MAX_CAPTURE_BYTES} bytes`)
    if (typeof session.resolveCapture !== 'function') throw httpError(501, 'this terminal does not support image capture')
    session.resolveCapture(requestId, {
      buffer: decoded.buffer,
      width: safeInteger(body.width) ?? pngDimensions(decoded.buffer)?.width ?? 0,
      height: safeInteger(body.height) ?? pngDimensions(decoded.buffer)?.height ?? 0,
    })
    sendJson(res, 200, { ok: true })
    return
  }
  if (route === '/ping' && method === 'GET') {
    sendJson(res, 200, { ok: true, plugin: 'dsh-live-terminal', version: PLUGIN_VERSION, sessions: registry.size })
    return
  }
  if (route.length === 0 || route === '/') {
    sendJson(res, 200, { plugin: 'dsh-live-terminal', version: PLUGIN_VERSION, routes: ROUTE_LIST })
    return
  }
  sendJson(res, 404, { error: `unknown route ${method} ${pathname}` })
}

/**
 * Only expose safe, user-relevant config values; never paths or credentials.
 * @param {any} config resolved config.
 * @returns {any} public config.
 */
function publicConfig(config) {
  return {
    interceptShellTools: config.interceptShellTools,
    scrollback: config.scrollback,
    maxOutputBytes: config.maxOutputBytes,
    maxSessions: config.maxSessions,
    perSessionMaxSessions: config.perSessionMaxSessions,
    commandTimeoutMs: config.commandTimeoutMs,
    retainExited: config.retainExited,
    historySize: config.historySize,
    historyPersist: config.historyPersist,
    interceptMinVisibleMs: config.interceptMinVisibleMs,
    autoCloseCommandDelayMs: config.autoCloseCommandDelayMs,
    autoCloseFailedDelayMs: config.autoCloseFailedDelayMs,
    autoCloseToolTerminals: config.autoCloseToolTerminals,
    autoCloseNotice: config.autoCloseNotice,
    requireSandbox: config.requireSandbox,
    allowUnconfined: config.allowUnconfined,
    portDetection: config.portDetection,
    shellPath: config.shellPath ?? null,
  }
}

/**
 * @param {any} registry terminal registry.
 * @param {unknown} id session id.
 * @returns {any} session.
 */
function requireSession(registry, id) {
  if (typeof id !== 'string' || id.length === 0) throw httpError(400, 'id is required')
  const session = registry.lookup(id)
  if (session === undefined) throw httpError(404, `terminal ${id} not found`)
  return session
}

/**
 * Open a per-session SSE stream: one bounded `snapshot` frame, replay frames
 * when `fromSeq` is given, then live deltas.
 * @param {import('node:http').IncomingMessage} req request.
 * @param {import('node:http').ServerResponse} res response.
 * @param {any} registry terminal registry.
 * @param {string} id session id.
 * @param {string} [clientId] browser identity for input ownership.
 * @param {number} [fromSeq] first sequence to replay after the snapshot.
 * @returns {void}
 */
function openSessionEvents(req, res, registry, id, clientId, fromSeq) {
  const session = registry.lookup(id)
  if (session === undefined) {
    sendJson(res, 404, { error: `terminal ${id} not found` })
    return
  }
  if (typeof clientId === 'string' && clientId.length > 0 && typeof session.attachClient === 'function') {
    session.attachClient(clientId)
  }
  const writer = createSseWriter(res)
  writer.send('snapshot', {
    ...session.snapshot({ scrollback: SSE_SNAPSHOT_SCROLLBACK }),
    ...(typeof session.writerClientId === 'string' ? { writerClientId: session.writerClientId } : {}),
  })
  if (Number.isFinite(fromSeq) && fromSeq >= 0 && typeof session.framesSince === 'function') {
    const frames = session.framesSince(fromSeq)
    for (const frame of frames) writer.send('output', frame)
  }
  if (session.state !== 'running') writer.send('state', { info: session.info })
  const unsubscribe = session.subscribe((name, data) => {
    writer.send(name, data)
  })
  const heartbeat = setInterval(() => writer.comment('ping'), HEARTBEAT_MS)
  heartbeat.unref?.()
  const cleanup = () => {
    clearInterval(heartbeat)
    unsubscribe()
    if (typeof clientId === 'string' && clientId.length > 0 && typeof session.detachClient === 'function') {
      session.detachClient(clientId)
    }
    writer.close()
  }
  attachSseCleanup(req, res, cleanup)
}

/**
 * Open the global SSE stream: current list then `sessions` frames.
 * @param {import('node:http').IncomingMessage} req request.
 * @param {import('node:http').ServerResponse} res response.
 * @param {any} registry terminal registry.
 * @returns {void}
 */
function openGlobalEvents(req, res, registry) {
  const writer = createSseWriter(res)
  writer.send('sessions', { sessions: registry.list() })
  const unsubscribe = registry.subscribeEvents((name, data) => {
    writer.send(name, data)
  })
  const heartbeat = setInterval(() => writer.comment('ping'), HEARTBEAT_MS)
  heartbeat.unref?.()
  const cleanup = () => {
    clearInterval(heartbeat)
    unsubscribe()
    writer.close()
  }
  attachSseCleanup(req, res, cleanup)
}

/**
 * Attach idempotent cleanup to both the request and the response lifecycle.
 * @param {import('node:http').IncomingMessage} req request.
 * @param {import('node:http').ServerResponse} res response.
 * @param {() => void} cleanup cleanup callback.
 * @returns {void}
 */
function attachSseCleanup(req, res, cleanup) {
  let cleaned = false
  const run = () => {
    if (cleaned) return
    cleaned = true
    try {
      cleanup()
    } catch {
      // no-op
    }
  }
  req.once('close', run)
  req.once('aborted', run)
  res.once('close', run)
  res.once('error', run)
  req.socket?.setNoDelay?.(true)
}

/**
 * Minimal SSE writer with an explicit closed latch, a bounded outbound queue and
 * `drain`-based backpressure.
 * @param {import('node:http').ServerResponse} res response.
 * @returns {{ send: (name: string, data: any) => void, comment: (text: string) => void, close: () => void, readonly closed: boolean }} writer.
 */
function createSseWriter(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()
  // A retry field line must not be followed by a blank line here: that would
  // dispatch an empty default ("message") event before the first real frame.
  // It becomes part of the next event block, where `retry` is still honoured.
  res.write('retry: 1000\n')
  let closed = false
  /** @type {string[]} frames waiting for the socket buffer. */
  const queue = []
  let queuedBytes = 0
  /** @type {boolean} whether a write is paused until the socket drains. */
  let pumping = false
  /** @type {(() => void) | undefined} */
  let drainListener

  const clearDrainListener = () => {
    if (drainListener === undefined) return
    const listener = drainListener
    drainListener = undefined
    try {
      res.off?.('drain', listener)
    } catch {
      // already gone
    }
  }

  const close = () => {
    if (closed) return
    closed = true
    queue.length = 0
    queuedBytes = 0
    pumping = false
    clearDrainListener()
    try {
      res.end()
    } catch {
      // already gone
    }
  }

  const pump = () => {
    if (closed || pumping) return
    pumping = true
    try {
      while (!closed && queue.length > 0) {
        const frame = queue.shift()
        queuedBytes -= Buffer.byteLength(frame, 'utf8')
        let accepted
        try {
          accepted = res.write(frame)
        } catch {
          close()
          return
        }
        if (accepted === false) {
          drainListener = () => {
            drainListener = undefined
            pumping = false
            try {
              pump()
            } catch {
              close()
            }
          }
          res.once('drain', drainListener)
          return
        }
      }
    } finally {
      if (drainListener === undefined) pumping = false
    }
  }

  const enqueue = (frame) => {
    if (closed) return
    queuedBytes += Buffer.byteLength(frame, 'utf8')
    queue.push(frame)
    if (queuedBytes > MAX_STREAM_BUFFER_BYTES) {
      close()
      return
    }
    pump()
  }

  return {
    send(name, data) {
      if (closed) return
      try {
        enqueue(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
      } catch {
        close()
      }
    },
    comment(text) {
      if (closed) return
      try {
        enqueue(`: ${text}\n\n`)
      } catch {
        close()
      }
    },
    close,
    get closed() {
      return closed
    },
  }
}

/**
 * Read and parse a bounded JSON request body.
 * @param {import('node:http').IncomingMessage} req request.
 * @param {number} [maxBytes] body bound (default 1MiB; captures allow more).
 * @returns {Promise<Record<string, any>>} parsed object body.
 */
function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : MAX_BODY_BYTES
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      chunks.length = 0
      reject(error)
      req.resume()
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        fail(httpError(413, `request body exceeds ${limit} bytes`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw.length === 0) {
        resolve({})
        return
      }
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        reject(httpError(400, 'invalid JSON request body'))
        return
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(httpError(400, 'JSON request body must be an object'))
        return
      }
      resolve(parsed)
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    req.on('aborted', () => fail(httpError(400, 'request aborted')))
  })
}

/**
 * @param {number} status HTTP status.
 * @param {string} message error message.
 * @returns {Error & { statusCode: number }} HTTP-shaped error.
 */
export function httpError(status, message) {
  const error = new Error(message)
  ;(/** @type {any} */ (error)).statusCode = status
  return error
}

/**
 * @param {string | null} value query value.
 * @param {number} fallback fallback.
 * @returns {number} parsed finite number.
 */
function numberParam(value, fallback) {
  if (value === null) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * @param {unknown} value candidate.
 * @returns {number | undefined} safe integer.
 */
function safeInteger(value) {
  return Number.isSafeInteger(value) ? value : undefined
}

/**
 * @param {unknown} value env object.
 * @returns {Record<string, string> | undefined} sanitised env.
 */
function normalizeEnv(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result = {}
  let total = 0
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') continue
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) continue
    if (key.startsWith('DSH_')) continue
    total += key.length + entry.length
    if (total > 16 * 1024) break
    result[key] = entry
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/**
 * Decode a `data:image/png;base64,...` URL.
 * @param {unknown} value data URL.
 * @returns {{ buffer: Buffer }} decoded buffer.
 */
function decodeDataUrl(value) {
  if (typeof value !== 'string') throw httpError(400, 'dataUrl is required')
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/su.exec(value)
  if (match === null) throw httpError(400, 'dataUrl is not a valid data URL')
  const isBase64 = match[2] === ';base64'
  const payload = match[3] ?? ''
  let buffer
  try {
    buffer = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8')
  } catch {
    throw httpError(400, 'dataUrl payload is invalid')
  }
  if (buffer.byteLength === 0) throw httpError(400, 'dataUrl payload is empty')
  return { buffer }
}

/**
 * Read width/height from a PNG IHDR chunk (no image library needed).
 * @param {Buffer} buffer PNG bytes.
 * @returns {{ width: number, height: number } | undefined} dimensions.
 */
function pngDimensions(buffer) {
  if (buffer.byteLength < 24) return undefined
  const signature = buffer.subarray(0, 8)
  if (!signature.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return undefined
  const type = buffer.subarray(12, 16).toString('ascii')
  if (type !== 'IHDR') return undefined
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/**
 * @param {import('node:http').ServerResponse} res response.
 * @param {number} status HTTP status.
 * @param {unknown} payload JSON payload.
 * @returns {void}
 */
function sendJson(res, status, payload) {
  if (res.headersSent) {
    try {
      res.destroy()
    } catch {
      // already gone
    }
    return
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}
