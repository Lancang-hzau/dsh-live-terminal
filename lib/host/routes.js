/**
 * Authenticated HTTP + SSE surface of the terminal panel.
 *
 * Every route lives under `/dsh-terminal-panel` and authenticates through
 * `ctx.connection.admit(req)` — the same trusted-origin + signed-cookie
 * admission the Web GUI uses. The wire format is plain JSON; SSE carries the
 * `snapshot` / `output` / `state` / `exit` event stream per session and a
 * global `sessions` stream for the session list.
 */

import { normalizeDimensions } from './registry.js'

/** Route prefix registered with the web server. */
export const ROUTE_PREFIX = '/dsh-terminal-panel'
/** Largest accepted JSON request body. */
const MAX_BODY_BYTES = 1024 * 1024
/** Largest accepted terminal input payload (raw UTF-8 bytes). */
const MAX_INPUT_BYTES = 64 * 1024
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

/**
 * Register the panel routes on a context that has `webServer` and `connection`.
 * @param {any} webCtx context owning webServer + connection.
 * @param {{ get registry(): any }} plugin host plugin state.
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
            sendJson(res, status, { error: error instanceof Error ? error.message : String(error) })
          })
        },
      }),
    'dsh-live-terminal: http + sse routes',
  )
}

/**
 * @param {any} webCtx web context.
 * @param {{ get registry(): any }} plugin plugin state.
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

  if (route === '/sessions' && method === 'GET') {
    sendJson(res, 200, { sessions: registry.list() })
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
    })
    return
  }
  if (route === '/events' && method === 'GET') {
    const id = url.searchParams.get('id')
    if (id === null || id.length === 0) openGlobalEvents(req, res, registry)
    else openSessionEvents(req, res, registry, id)
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
    const session = await registry.createInteractive({
      cols: body.cols,
      rows: body.rows,
      title: typeof body.title === 'string' && body.title.trim().length > 0 ? body.title.trim().slice(0, 200) : undefined,
      sessionId,
      cwd: requestedCwd ?? sessionCwd,
      owner: 'user',
    })
    sendJson(res, 200, { session: session.info })
    return
  }
  if (route === '/input' && method === 'POST') {
    const body = await readJsonBody(req)
    const session = requireSession(registry, body.id)
    const data = typeof body.data === 'string' ? body.data : ''
    if (Buffer.byteLength(data, 'utf8') > MAX_INPUT_BYTES) throw httpError(413, `input data exceeds ${MAX_INPUT_BYTES} bytes`)
    await session.write(data)
    sendJson(res, 200, { ok: true })
    return
  }
  if (route === '/resize' && method === 'POST') {
    const body = await readJsonBody(req)
    const session = requireSession(registry, body.id)
    if (!Number.isSafeInteger(body.cols) || !Number.isSafeInteger(body.rows)) throw httpError(400, 'cols and rows must be integers')
    const dimensions = normalizeDimensions(body.cols, body.rows)
    await session.resize(dimensions.cols, dimensions.rows)
    sendJson(res, 200, { ok: true })
    return
  }
  if (route === '/close' && method === 'POST') {
    const body = await readJsonBody(req)
    const session = requireSession(registry, body.id)
    await registry.close(session.id)
    sendJson(res, 200, { ok: true })
    return
  }
  if (route === '/ping' && method === 'GET') {
    sendJson(res, 200, { ok: true, plugin: 'dsh-live-terminal', sessions: registry.size })
    return
  }
  if (route.length === 0 || route === '/') {
    sendJson(res, 200, { plugin: 'dsh-live-terminal', routes: ['sessions', 'snapshot', 'events', 'create', 'input', 'resize', 'close'] })
    return
  }
  sendJson(res, 404, { error: `unknown route ${method} ${pathname}` })
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
 * Open a per-session SSE stream: one bounded `snapshot` frame, then live deltas.
 * @param {import('node:http').IncomingMessage} req request.
 * @param {import('node:http').ServerResponse} res response.
 * @param {any} registry terminal registry.
 * @param {string} id session id.
 * @returns {void}
 */
function openSessionEvents(req, res, registry, id) {
  const session = registry.lookup(id)
  if (session === undefined) {
    sendJson(res, 404, { error: `terminal ${id} not found` })
    return
  }
  const writer = createSseWriter(res)
  writer.send('snapshot', session.snapshot({ scrollback: SSE_SNAPSHOT_SCROLLBACK }))
  if (session.state !== 'running') writer.send('state', { info: session.info })
  const unsubscribe = session.subscribe((name, data) => {
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
 *
 * Frames are queued while `res.write()` reports a full socket buffer, so a slow
 * client can never make the Host buffer an unbounded terminal stream; once more
 * than {@link MAX_STREAM_BUFFER_BYTES} is waiting the connection is closed (the
 * EventSource reconnects after `retry: 1000` and re-syncs from a fresh
 * snapshot). `close()` is idempotent: it clears the queue, removes the pending
 * drain listener and ends the response.
 *
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
          // Socket buffer full: keep the remaining frames queued and resume on
          // 'drain' instead of stacking more writes into the Host.
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
 * @returns {Promise<Record<string, any>>} parsed object body.
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      // Stop collecting but keep the socket healthy: the handler sends the
      // JSON error response and the rest of the body is drained below.
      chunks.length = 0
      reject(error)
      req.resume()
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        fail(httpError(413, `request body exceeds ${MAX_BODY_BYTES} bytes`))
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
