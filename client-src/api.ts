/**
 * HTTP / SSE client for the `dsh-live-terminal` host half (1.2.1).
 *
 * All requests are same-origin and authenticated by the DSH session cookie
 * (architecture.md §4.4). Every payload is parsed defensively so that the UI
 * can render even against an older/partial host half.
 */

import {
  parseCaptureRequest,
  parseConfigInfo,
  parseExit,
  parseHistoryPayload,
  parseNotice,
  parseOutput,
  parseSessionInfo,
  parseSessionPatch,
  parseSnapshot,
  parseSessionsPayload,
  type CaptureRequestFrame,
  type ConfigInfo,
  type ExitFrame,
  type HistoryEntry,
  type Notice,
  type OutputFrame,
  type SessionInfo,
  type SessionInfoPatch,
  type SnapshotFrame,
} from './types'

export const API_PREFIX = '/dsh-terminal-panel'

/**
 * Per-request timeout. A wedged host (route not answering) would otherwise
 * leave the panel stuck on its loading state forever; with this bound the
 * existing error state (and its retry button) takes over.
 */
const REQUEST_TIMEOUT_MS = 10_000

/** localStorage key holding this browser page's stable client id. */
export const CLIENT_ID_STORAGE_KEY = 'dsh-live-terminal.client-id'

/* ------------------------------------------------------------------ */
/* Client identity (multi-tab input lease)                             */
/* ------------------------------------------------------------------ */

let cachedClientId: string | null = null

function makeRandomId(): string {
  try {
    const cryptoObject = globalThis.crypto
    if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
      return cryptoObject.randomUUID()
    }
  } catch {
    // fall through to the Math.random fallback
  }
  // Not a security primitive: only distinguishes browser tabs of one user.
  const random = Math.random().toString(36).slice(2)
  return `client-${Date.now().toString(36)}-${random}`
}

/**
 * Stable id for this browser page/tab. Persisted in localStorage so a reload
 * keeps the same input lease; created on first use when absent/unreadable.
 */
export function getClientId(): string {
  if (cachedClientId !== null) return cachedClientId
  let stored: string | null = null
  try {
    stored = globalThis.localStorage?.getItem(CLIENT_ID_STORAGE_KEY) ?? null
  } catch {
    stored = null
  }
  if (typeof stored === 'string' && stored.length > 0) {
    cachedClientId = stored
    return stored
  }
  const created = makeRandomId()
  try {
    globalThis.localStorage?.setItem(CLIENT_ID_STORAGE_KEY, created)
  } catch {
    // Private mode / blocked storage: keep the in-memory id for this page.
  }
  cachedClientId = created
  return created
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** Error carrying the HTTP status/code so the panel can explain failures. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string | undefined

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/* ------------------------------------------------------------------ */
/* Defensive readers                                                   */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
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
      (record && readString(record.error)) ||
      (typeof payload === 'string' && payload !== '' ? payload : `HTTP ${response.status}`)
    const code = record ? readString(record.code) : undefined
    throw new ApiError(message, response.status, code)
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

function readSessionPayload(value: unknown): SessionInfo | null {
  const record = asRecord(value)
  if (!record) return parseSessionInfo(value)
  const nested = record.session ?? record.info ?? record.terminal
  if (nested !== undefined) {
    const info = parseSessionInfo(nested)
    if (info) return info
  }
  return parseSessionInfo(record)
}

/* ------------------------------------------------------------------ */
/* REST API                                                            */
/* ------------------------------------------------------------------ */

/** `GET /config` — read-only effective configuration. */
export async function fetchConfig(): Promise<ConfigInfo> {
  const payload = await requestJson('/config')
  const parsed = parseConfigInfo(payload)
  if (!parsed) throw new ApiError('config returned an invalid payload', 500)
  return parsed
}

/** `GET /sessions?sessionId=` — optional DSH session filter. */
export async function listSessions(options?: { sessionId?: string }): Promise<SessionInfo[]> {
  const query =
    options?.sessionId !== undefined && options.sessionId !== ''
      ? `?sessionId=${encodeURIComponent(options.sessionId)}`
      : ''
  const payload = await requestJson(`/sessions${query}`)
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

/** `GET /history?limit=&terminalId=` — closed command terminals, newest first. */
export async function fetchHistory(options?: {
  limit?: number
  terminalId?: string
}): Promise<HistoryEntry[]> {
  const params = new URLSearchParams()
  if (typeof options?.limit === 'number' && Number.isFinite(options.limit)) {
    params.set('limit', String(Math.max(1, Math.round(options.limit))))
  }
  if (options?.terminalId !== undefined && options.terminalId !== '') {
    params.set('terminalId', options.terminalId)
  }
  const query = params.toString()
  const payload = await requestJson(`/history${query === '' ? '' : `?${query}`}`)
  return parseHistoryPayload(payload)
}

/** `GET /snapshot?id=` — seed the screen over REST. */
export async function fetchSnapshot(id: string): Promise<SnapshotFrame> {
  const payload = await requestJson(`/snapshot?id=${encodeURIComponent(id)}`)
  const frame = parseSnapshot(payload)
  if (!frame) throw new ApiError('snapshot returned an invalid payload', 500)
  return frame
}

/** `GET /replay?id=&fromSeq=` — bounded output frames after `fromSeq`. */
export async function fetchReplay(
  id: string,
  fromSeq: number,
): Promise<{ frames: OutputFrame[]; nextSeq: number }> {
  const payload = await requestJson(
    `/replay?id=${encodeURIComponent(id)}&fromSeq=${encodeURIComponent(String(Math.max(0, Math.floor(fromSeq))))}`,
  )
  const record = asRecord(payload)
  const rawFrames = record && Array.isArray(record.frames) ? record.frames : []
  const frames = rawFrames
    .map((frame) => parseOutput(frame))
    .filter((frame): frame is OutputFrame => frame !== null)
  const nextSeq =
    record && typeof record.nextSeq === 'number' && Number.isFinite(record.nextSeq)
      ? record.nextSeq
      : fromSeq
  return { frames, nextSeq }
}

export interface CreateSessionOptions {
  cols: number
  rows: number
  title?: string
  cwd?: string
  shell?: 'pwsh' | 'bash' | 'cmd'
  /** DSH conversation session id (workspace resolution). */
  sessionId?: string
  env?: Record<string, string>
}

/** `POST /create` — a new user-owned interactive terminal. */
export async function createSession(options: CreateSessionOptions): Promise<SessionInfo> {
  const payload = await postJson('/create', {
    cols: Math.max(2, Math.round(options.cols)),
    rows: Math.max(1, Math.round(options.rows)),
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.shell !== undefined ? { shell: options.shell } : {}),
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  })
  const info = readSessionPayload(payload)
  if (!info) throw new ApiError('create returned an invalid session payload', 500)
  return info
}

/** `POST /input` — raw keyboard text for one session. */
export async function sendInput(
  id: string,
  data: string,
  inputClientId: string = getClientId(),
): Promise<void> {
  if (data === '') return
  await postJson('/input', { id, data, clientId: inputClientId })
}

/** `POST /resize` — PTY + mirror dimensions. */
export async function resizeSession(id: string, cols: number, rows: number): Promise<void> {
  await postJson('/resize', {
    id,
    cols: Math.max(2, Math.round(cols)),
    rows: Math.max(1, Math.round(rows)),
  })
}

/** `POST /close` — terminate the session (the host writes a history entry). */
export async function closeSession(id: string): Promise<string | null> {
  const payload = await postJson('/close', { id })
  const record = asRecord(payload)
  return record ? readString(record.historyId) ?? null : null
}

/** `POST /keep` — cancel auto-close and pin the terminal. */
export async function keepSession(id: string): Promise<SessionInfo | null> {
  const payload = await postJson('/keep', { id })
  return readSessionPayload(payload)
}

/** `POST /auto-close` — pause/resume the host-side countdown. */
export async function setAutoClosePaused(
  id: string,
  paused: boolean,
  reason?: string,
): Promise<SessionInfo | null> {
  const payload = await postJson('/auto-close', {
    id,
    action: paused ? 'pause' : 'resume',
    ...(reason !== undefined ? { reason } : {}),
  })
  return readSessionPayload(payload)
}

/** `POST /rename` — change the tab title. */
export async function renameSession(id: string, title: string): Promise<SessionInfo | null> {
  const payload = await postJson('/rename', { id, title })
  return readSessionPayload(payload)
}

/** `POST /take-control` — take the input lease from another page. */
export async function takeControl(
  id: string,
  inputClientId: string = getClientId(),
): Promise<string | null> {
  const payload = await postJson('/take-control', { id, clientId: inputClientId })
  const record = asRecord(payload)
  return record ? readString(record.writerClientId) ?? null : null
}

/** `POST /signal` — SIGINT (ETX) / SIGTERM / SIGKILL / SIGHUP. */
export async function signalSession(
  id: string,
  signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGHUP',
): Promise<string> {
  const payload = await postJson('/signal', { id, signal })
  const record = asRecord(payload)
  return (record && readString(record.delivered)) ?? signal
}

/**
 * `POST /capture` — round-trip a PNG data URL rendered by the browser.
 * `size` is optional; the host also derives it from the PNG header.
 */
export async function postCapture(
  id: string,
  requestId: string,
  dataUrl: string,
  size?: { width: number; height: number },
): Promise<void> {
  await postJson('/capture', {
    id,
    requestId,
    dataUrl,
    ...(size !== undefined ? { width: size.width, height: size.height } : {}),
  })
}

/** Download URL for `GET /export?id=&format=` (text/ansi attachment). */
export function exportUrl(id: string, format: 'text' | 'ansi' = 'text'): string {
  return `${API_PREFIX}/export?id=${encodeURIComponent(id)}&format=${format}`
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
  onSnapshot?: (frame: SnapshotFrame) => void
  onOutput?: (frame: OutputFrame) => void
  onState?: (patch: SessionInfoPatch) => void
  onExit?: (frame: ExitFrame) => void
  /** The agent asked this client to render + upload a PNG of the screen. */
  onCaptureRequest?: (frame: CaptureRequestFrame) => void
}

/**
 * `GET /events?id=` subscription options. Both shapes are accepted:
 *  - flat (`{clientId, fromSeq, onSnapshot, ...}`) as written in the contract,
 *  - nested (`{clientId, fromSeq, handlers: {...}}`) as TerminalView uses.
 */
export interface OpenSessionStreamOptions extends SessionStreamHandlers {
  /** Stable page id; the host attaches it as a follower for input leasing. */
  clientId?: string
  /** First sequence to replay after the snapshot (reconnect optimization). */
  fromSeq?: number
  /** Grouped form; takes precedence over the flat callbacks. */
  handlers?: SessionStreamHandlers
}

/**
 * Subscribe to `GET /events?id=` for one session. Returns a disposer.
 *
 * `clientId` is always sent so the host can track followers; a `fromSeq` is
 * only forwarded when the caller has one (the host then replays the missed
 * output frames after the snapshot).
 */
export function openSessionStream(
  id: string,
  options: OpenSessionStreamOptions,
): () => void {
  const handlers: SessionStreamHandlers = options.handlers ?? {
    onOpen: options.onOpen,
    onError: options.onError,
    onSnapshot: options.onSnapshot,
    onOutput: options.onOutput,
    onState: options.onState,
    onExit: options.onExit,
    onCaptureRequest: options.onCaptureRequest,
  }
  const params = new URLSearchParams({ id })
  params.set('clientId', options.clientId ?? getClientId())
  if (
    typeof options.fromSeq === 'number' &&
    Number.isFinite(options.fromSeq) &&
    options.fromSeq >= 0
  ) {
    params.set('fromSeq', String(Math.floor(options.fromSeq)))
  }
  const source = new EventSource(`${API_PREFIX}/events?${params.toString()}`)
  listenSse(source, 'snapshot', (payload) => {
    const frame = parseSnapshot(payload)
    if (frame) handlers.onSnapshot?.(frame)
  })
  listenSse(source, 'output', (payload) => {
    const frame = parseOutput(payload)
    if (frame) handlers.onOutput?.(frame)
  })
  // The host may batch the replay as one `replay` frame; unwrap it as outputs.
  listenSse(source, 'replay', (payload) => {
    const record = asRecord(payload)
    const raw = record && Array.isArray(record.frames)
      ? record.frames
      : Array.isArray(payload)
        ? payload
        : []
    for (const item of raw) {
      const frame = parseOutput(item)
      if (frame) handlers.onOutput?.(frame)
    }
  })
  listenSse(source, 'state', (payload) => {
    const patch = parseSessionPatch(payload)
    if (patch) handlers.onState?.(patch)
  })
  listenSse(source, 'exit', (payload) => {
    const frame = parseExit(payload)
    if (frame) handlers.onExit?.(frame)
  })
  listenSse(source, 'capture-request', (payload) => {
    const frame = parseCaptureRequest(payload)
    if (frame) handlers.onCaptureRequest?.(frame)
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
  /** Optional: global `notice` events (auto-close/finished/port/capture). */
  onNotice?: (notice: Notice) => void
  /** Optional: `capture-request` frames sent over the global stream. */
  onCaptureRequest?: (frame: CaptureRequestFrame) => void
}

interface SessionsFeed {
  source: EventSource
  subscribers: Set<SessionsStreamHandlers>
  /** Whether the shared EventSource is currently open (replayed to late subscribers). */
  opened: boolean
}

/**
 * One shared global `/events` connection for the whole page. Every panel
 * instance, the global notice watcher and the auto-open watcher subscribe to
 * this feed: opening one EventSource per panel would multiply long-lived
 * connections (and can hit the browser's per-origin connection cap on HTTP/1.1).
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

function fanoutCaptureRequest(
  subscribers: Set<SessionsStreamHandlers>,
  frame: CaptureRequestFrame,
): void {
  fanoutSessions(subscribers, (subscriber) => subscriber.onCaptureRequest?.(frame))
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
    listenSse(source, 'notice', (payload) => {
      const notice = parseNotice(payload)
      if (!notice) return
      if (notice.type === 'capture-request') {
        fanoutCaptureRequest(subscribers, {
          terminalId: notice.terminalId,
          requestId: notice.requestId,
        })
        return
      }
      fanoutSessions(subscribers, (subscriber) => subscriber.onNotice?.(notice))
    })
    listenSse(source, 'capture-request', (payload) => {
      const frame = parseCaptureRequest(payload)
      if (frame) fanoutCaptureRequest(subscribers, frame)
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

export type { ConfigInfo, HistoryEntry, Notice }
