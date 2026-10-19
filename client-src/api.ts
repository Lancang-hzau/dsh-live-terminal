/**
 * HTTP / SSE client for the `dsh-live-terminal` host half.
 *
 * All requests are same-origin and authenticated by the DSH session cookie
 * (architecture.md §4.4). Every payload is parsed defensively so that the UI
 * can render even while the host half is still being implemented.
 */

import type {
  ExitFrame,
  OutputFrame,
  SessionInfo,
  SessionInfoPatch,
  SnapshotFrame,
} from './types'

export const API_PREFIX = '/dsh-terminal-panel'

/**
 * Per-request timeout. A wedged host (route not answering) would otherwise
 * leave the panel stuck on its loading state forever; with this bound the
 * existing error state (and its retry button) takes over.
 */
const REQUEST_TIMEOUT_MS = 10_000

/** Error carrying the HTTP status so the panel can explain "host not ready". */
export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/* ------------------------------------------------------------------ */
/* Small defensive readers                                             */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function firstRecord(...values: unknown[]): Record<string, unknown> | null {
  for (const value of values) {
    const record = asRecord(value)
    if (record) return record
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Payload parsers                                                     */
/* ------------------------------------------------------------------ */

/** Parse a full `SessionInfo` (list items, snapshots, `state` frames). */
export function parseSessionInfo(value: unknown): SessionInfo | null {
  const record = asRecord(value)
  if (!record) return null
  for (const key of ['info', 'session', 'terminal', 'tab']) {
    const nested = asRecord(record[key])
    if (nested) {
      const parsed = parseSessionInfo(nested)
      if (parsed) return parsed
    }
  }
  const id = readString(record.id) ?? readString(record.terminalId)
  if (!id) return null
  const state =
    record.state === 'exited' || record.state === 'failed' || record.state === 'running'
      ? record.state
      : 'running'
  const info: SessionInfo = {
    id,
    title: readString(record.title) ?? readString(record.name) ?? id,
    kind: record.kind === 'command' ? 'command' : 'interactive',
    owner: record.owner === 'agent' ? 'agent' : 'user',
    cwd: readString(record.cwd) ?? '',
    cols: Math.max(2, readNumber(record.cols) ?? 80),
    rows: Math.max(1, readNumber(record.rows) ?? 24),
    state,
    exitCode: typeof record.exitCode === 'number' ? record.exitCode : null,
    createdAt: readNumber(record.createdAt) ?? 0,
    updatedAt: readNumber(record.updatedAt) ?? 0,
  }
  const sessionId = readString(record.sessionId)
  if (sessionId !== undefined) info.sessionId = sessionId
  const agentId = readString(record.agentId)
  if (agentId !== undefined) info.agentId = agentId
  const command = readString(record.command)
  if (command !== undefined) info.command = command
  const error = readString(record.error)
  if (error !== undefined) info.error = error
  return info
}

/** Parse a partial session update; unknown ids are ignored by the panel. */
export function parseSessionPatch(value: unknown): SessionInfoPatch | null {
  const outer = asRecord(value)
  if (!outer) return null
  const record =
    firstRecord(outer.info, outer.session, outer.terminal) ?? outer
  const id = readString(record.id) ?? readString(record.terminalId) ?? readString(outer.id)
  if (!id) return null
  const patch: Record<string, unknown> = { id }
  const title = readString(record.title) ?? readString(record.name)
  if (title !== undefined) patch.title = title
  if (record.kind === 'command' || record.kind === 'interactive') patch.kind = record.kind
  if (record.owner === 'agent' || record.owner === 'user') patch.owner = record.owner
  const sessionId = readString(record.sessionId)
  if (sessionId !== undefined) patch.sessionId = sessionId
  const agentId = readString(record.agentId)
  if (agentId !== undefined) patch.agentId = agentId
  const command = readString(record.command)
  if (command !== undefined) patch.command = command
  const cwd = readString(record.cwd)
  if (cwd !== undefined) patch.cwd = cwd
  const cols = readNumber(record.cols)
  if (cols !== undefined) patch.cols = cols
  const rows = readNumber(record.rows)
  if (rows !== undefined) patch.rows = rows
  if (
    record.state === 'running' ||
    record.state === 'exited' ||
    record.state === 'failed'
  ) {
    patch.state = record.state
  }
  if ('exitCode' in record) {
    patch.exitCode = typeof record.exitCode === 'number' ? record.exitCode : null
  }
  const error = readString(record.error)
  if (error !== undefined) patch.error = error
  const createdAt = readNumber(record.createdAt)
  if (createdAt !== undefined) patch.createdAt = createdAt
  const updatedAt = readNumber(record.updatedAt)
  if (updatedAt !== undefined) patch.updatedAt = updatedAt
  return patch as SessionInfoPatch
}

/** Parse the global `sessions` SSE frame: a list or a single updated session. */
export function parseSessionsPayload(value: unknown): SessionInfo[] | SessionInfo | null {
  if (Array.isArray(value)) {
    return value
      .map((item) => parseSessionInfo(item))
      .filter((item): item is SessionInfo => item !== null)
  }
  const record = asRecord(value)
  if (!record) return null
  for (const key of ['sessions', 'list', 'terminals']) {
    if (Array.isArray(record[key])) return parseSessionsPayload(record[key])
  }
  return parseSessionInfo(value)
}

/** Parse a `snapshot` frame or the `GET /snapshot` response. */
export function parseSnapshot(value: unknown): SnapshotFrame | null {
  const record = asRecord(value)
  if (!record) return null
  const body = firstRecord(record.snapshot, record.frame) ?? record
  const info = parseSessionInfo(
    record.info ?? record.session ?? record.terminal ?? body.info ?? body.session,
  )
  const screen =
    readString(body.screen) ?? readString(body.ansi) ?? readString(body.data) ?? ''
  const text = readString(body.text) ?? readString(record.text) ?? ''
  const cursorRecord = firstRecord(body.cursor, record.cursor)
  const cursor = cursorRecord
    ? {
        x: readNumber(cursorRecord.x) ?? 0,
        y: readNumber(cursorRecord.y) ?? 0,
      }
    : undefined
  const seq = readNumber(record.seq) ?? readNumber(body.seq)
  return { info: info ?? undefined, screen, text, cursor, seq }
}

/** Parse an `output` frame. Accepts `{chunk}`, `{data}`, `{output}` or a raw string. */
export function parseOutput(value: unknown): OutputFrame | null {
  if (typeof value === 'string') return { seq: null, chunk: value }
  const record = asRecord(value)
  if (!record) return null
  const chunk =
    readString(record.chunk) ??
    readString(record.data) ??
    readString(record.output) ??
    readString(record.text)
  if (chunk === undefined) return null
  const seq = readNumber(record.seq) ?? null
  return { seq, chunk }
}

/** Parse an `exit` frame. */
export function parseExit(value: unknown): ExitFrame | null {
  const record = asRecord(value)
  if (!record) return null
  const nested = firstRecord(record.info, record.session, record.terminal)
  const source = nested ?? record
  const exitCode =
    typeof source.exitCode === 'number'
      ? source.exitCode
      : typeof record.exitCode === 'number'
        ? record.exitCode
        : typeof source.code === 'number'
          ? source.code
          : null
  const signal = readString(source.signal) ?? null
  const state =
    source.state === 'exited' || source.state === 'failed' ? source.state : undefined
  return { exitCode, signal, state }
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(API_PREFIX + path, {
    credentials: 'same-origin',
    ...init,
    // Honour caller-provided signals (e.g. abort on unmount); otherwise bound
    // every request so a wedged host reaches the panel's retryable error state.
    signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await response.text()
  let payload: unknown
  if (text !== '') {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }
  }
  if (!response.ok) {
    const record = asRecord(payload)
    const message =
      (record && readString(record.error)) || `HTTP ${response.status}`
    throw new ApiError(message, response.status)
  }
  return payload
}

function postJson(path: string, body: unknown): Promise<unknown> {
  return requestJson(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/* ------------------------------------------------------------------ */
/* REST API                                                            */
/* ------------------------------------------------------------------ */

export async function listSessions(): Promise<SessionInfo[]> {
  const payload = await requestJson('/sessions')
  const record = asRecord(payload)
  const rawList = Array.isArray(payload)
    ? payload
    : record && Array.isArray(record.sessions)
      ? record.sessions
      : []
  return rawList
    .map((item) => parseSessionInfo(item))
    .filter((item): item is SessionInfo => item !== null)
}

export interface CreateSessionOptions {
  cols: number
  rows: number
  /**
   * Conversation session id this panel body belongs to. The host resolves the
   * working directory from it (P2-1); optional so the helper stays reusable.
   */
  sessionId?: string
  title?: string
}

export async function createSession(options: CreateSessionOptions): Promise<SessionInfo> {
  const payload = await postJson('/create', {
    cols: Math.max(2, Math.round(options.cols)),
    rows: Math.max(1, Math.round(options.rows)),
    // JSON.stringify drops `undefined`, so the body keeps the contracted shape
    // `{ cols, rows, sessionId }` while sessionId remains optional.
    sessionId: options.sessionId,
    ...(options.title !== undefined ? { title: options.title } : {}),
  })
  const record = asRecord(payload)
  const info = parseSessionInfo(
    record && (record.session ?? record.info ?? record.terminal) !== undefined
      ? (record.session ?? record.info ?? record.terminal)
      : payload,
  )
  if (!info) throw new ApiError('create returned an invalid session payload', 500)
  return info
}

export async function fetchSnapshot(id: string): Promise<SnapshotFrame> {
  const payload = await requestJson(`/snapshot?id=${encodeURIComponent(id)}`)
  const frame = parseSnapshot(payload)
  if (!frame) throw new ApiError('snapshot returned an invalid payload', 500)
  return frame
}

export async function sendInput(id: string, data: string): Promise<void> {
  if (data === '') return
  await postJson('/input', { id, data })
}

export async function resizeSession(id: string, cols: number, rows: number): Promise<void> {
  await postJson('/resize', {
    id,
    cols: Math.max(2, Math.round(cols)),
    rows: Math.max(1, Math.round(rows)),
  })
}

export async function closeSession(id: string): Promise<void> {
  await postJson('/close', { id })
}

/* ------------------------------------------------------------------ */
/* SSE streams                                                         */
/* ------------------------------------------------------------------ */

function parseSseData(event: Event): unknown {
  const data = (event as MessageEvent).data
  if (typeof data !== 'string') return data
  try {
    return JSON.parse(data)
  } catch {
    return data
  }
}

function listenSse(
  source: EventSource,
  name: string,
  handler: (payload: unknown) => void,
): void {
  source.addEventListener(name, (event) => {
    try {
      handler(parseSseData(event))
    } catch (error) {
      console.warn('[dsh-live-terminal] failed to handle SSE frame', name, error)
    }
  })
}

export interface SessionStreamHandlers {
  onOpen?: () => void
  onError?: () => void
  onSnapshot: (frame: SnapshotFrame) => void
  onOutput: (frame: OutputFrame) => void
  onState: (patch: SessionInfoPatch) => void
  onExit: (frame: ExitFrame) => void
}

/** Subscribe to `GET /events?id=` for one session. Returns a disposer. */
export function openSessionStream(
  id: string,
  handlers: SessionStreamHandlers,
): () => void {
  const source = new EventSource(`${API_PREFIX}/events?id=${encodeURIComponent(id)}`)
  listenSse(source, 'snapshot', (payload) => {
    const frame = parseSnapshot(payload)
    if (frame) handlers.onSnapshot(frame)
  })
  listenSse(source, 'output', (payload) => {
    const frame = parseOutput(payload)
    if (frame) handlers.onOutput(frame)
  })
  listenSse(source, 'state', (payload) => {
    const patch = parseSessionPatch(payload)
    if (patch) handlers.onState(patch)
  })
  listenSse(source, 'exit', (payload) => {
    const frame = parseExit(payload)
    if (frame) handlers.onExit(frame)
  })
  source.addEventListener('open', () => {
    try {
      handlers.onOpen?.()
    } catch (error) {
      console.warn('[dsh-live-terminal] SSE open handler failed', error)
    }
  })
  source.addEventListener('error', () => {
    try {
      handlers.onError?.()
    } catch (error) {
      console.warn('[dsh-live-terminal] SSE error handler failed', error)
    }
  })
  return () => source.close()
}

export interface SessionsStreamHandlers {
  onOpen?: () => void
  onError?: () => void
  onSessions: (payload: SessionInfo[] | SessionInfo) => void
}

interface SessionsFeed {
  source: EventSource
  subscribers: Set<SessionsStreamHandlers>
  /** Whether the shared EventSource is currently open (replayed to late subscribers). */
  opened: boolean
}

/**
 * One shared global `/events` connection for the whole page. Every panel
 * instance, plus the auto-open watcher, subscribe to this feed: opening one
 * EventSource per panel would multiply long-lived connections (and can hit the
 * browser's per-origin connection cap on HTTP/1.1).
 */
let sessionsFeed: SessionsFeed | null = null

/** Deliver to one subscriber without letting a throw starve the others. */
function fanoutSessions(
  subscribers: Set<SessionsStreamHandlers>,
  dispatch: (handlers: SessionsStreamHandlers) => void,
): void {
  for (const handlers of Array.from(subscribers)) {
    try {
      dispatch(handlers)
    } catch (error) {
      console.warn('[dsh-live-terminal] sessions SSE subscriber failed', error)
    }
  }
}

/** Subscribe to the shared global `GET /events` session feed. Returns a disposer. */
export function openSessionsStream(handlers: SessionsStreamHandlers): () => void {
  if (sessionsFeed === null) {
    const subscribers = new Set<SessionsStreamHandlers>()
    const source = new EventSource(`${API_PREFIX}/events`)
    const feed: SessionsFeed = { source, subscribers, opened: false }
    listenSse(source, 'sessions', (payload) => {
      const parsed = parseSessionsPayload(payload)
      if (!parsed) return
      fanoutSessions(subscribers, (subscriber) => subscriber.onSessions(parsed))
    })
    source.addEventListener('open', () => {
      feed.opened = true
      fanoutSessions(subscribers, (subscriber) => subscriber.onOpen?.())
    })
    source.addEventListener('error', () => {
      feed.opened = false
      fanoutSessions(subscribers, (subscriber) => subscriber.onError?.())
    })
    sessionsFeed = feed
  }
  const feed = sessionsFeed
  feed.subscribers.add(handlers)
  // A late subscriber (e.g. a second panel) joins an already-open shared
  // stream and would otherwise never observe the `open` event.
  if (feed.opened) {
    queueMicrotask(() => {
      if (!feed.subscribers.has(handlers)) return
      try {
        handlers.onOpen?.()
      } catch (error) {
        console.warn('[dsh-live-terminal] sessions SSE replay failed', error)
      }
    })
  }
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    feed.subscribers.delete(handlers)
    if (feed.subscribers.size === 0 && sessionsFeed === feed) {
      feed.source.close()
      sessionsFeed = null
    }
  }
}
