/**
 * Wire types shared with the host half (1.2.1).
 *
 * The canonical shape is documented in docs/impl-1.2.1-contract.md §2/§3. The
 * client deliberately parses its input defensively: the host half may be an
 * older build while the client is newer (and vice versa), so every parser
 * accepts the contracted shape plus a few plausible aliases and never throws
 * on a frame it does not recognize. Missing 1.2.1 fields get safe defaults so
 * the UI can render against a 1.2.0 host too.
 */

export type SessionKind = 'command' | 'interactive'
export type SessionOwner = 'agent' | 'user'
export type SessionState = 'running' | 'exited' | 'failed'

/** A localhost/dev-server URL detected in the terminal output. */
export interface PortInfo {
  url: string
  port: number
  host: string
  firstSeenAt: number
  lastSeenAt: number
}

/** Sandbox information published for every terminal (never enforced by the PTY). */
export interface SandboxInfo {
  mode: string
  confined: boolean
  required: boolean
}

export interface CursorPosition {
  x: number
  y: number
}

/** One PTY session as published by the host (`SessionInfo` in the contract). */
export interface SessionInfo {
  id: string
  title: string
  kind: SessionKind
  owner: SessionOwner
  sessionId?: string
  agentId?: string
  command?: string
  cwd: string
  cols: number
  rows: number
  state: SessionState
  exitCode: number | null
  error?: string
  createdAt: number
  updatedAt: number
  /** 1.2.1 fields — all optional on the wire, defaulted by the parser. */
  signal: string | null
  startedAt: number
  endedAt: number | null
  durationMs: number | null
  shellKind: string
  ports: PortInfo[]
  sandbox: SandboxInfo
  /** Epoch ms at which the host will auto-close this terminal; null = never. */
  autoCloseAt: number | null
  autoClosePaused: boolean
  /** The user pressed “keep”; the terminal is exempt from auto-close. */
  pinned: boolean
  /** Client that currently owns input (multi-tab lease). */
  writerClientId?: string
}

/** A partial update carried by `state` frames (and synthesized from `exit`). */
export type SessionInfoPatch = { id: string } & Partial<Omit<SessionInfo, 'id'>>

/** `snapshot` frame / `GET /snapshot` response. */
export interface SnapshotFrame {
  info?: SessionInfo
  /** Serialized ANSI screen produced by the host's headless xterm. */
  screen: string
  /** Plain visible screen text (used by screenshots on the host side). */
  text: string
  cursor?: CursorPosition
  seq?: number
  /** Input owner at snapshot time (multi-page lease). */
  writerClientId?: string
}

/** `output` frame: a raw PTY chunk plus the host's monotonic sequence number. */
export interface OutputFrame {
  seq: number | null
  chunk: string
}

/** `exit` frame. */
export interface ExitFrame {
  exitCode: number | null
  signal?: string | null
  state?: SessionState
}

/** `capture-request` SSE frame: the agent asked for a PNG of the screen. */
export interface CaptureRequestFrame {
  terminalId: string
  requestId: string
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

export type HistoryReason = 'auto-close' | 'closed' | 'failed'

/** One closed command terminal kept for review (`HistoryEntry` in the contract). */
export interface HistoryEntry {
  id: string
  title: string
  command: string
  cwd: string
  kind: 'command'
  exitCode: number | null
  signal: string | null
  startedAt: number
  endedAt: number
  durationMs: number
  cols: number
  rows: number
  reason: HistoryReason
  text: string
  truncated: boolean
  ports: PortInfo[]
  sandbox: SandboxInfo
}

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

/** Public (path-free) effective config returned by `GET /config`. */
export interface PublicConfig {
  interceptShellTools: boolean
  scrollback: number
  maxOutputBytes: number
  maxSessions: number
  perSessionMaxSessions: number
  commandTimeoutMs: number
  retainExited: number
  historySize: number
  historyPersist: boolean
  interceptMinVisibleMs: number
  autoCloseCommandDelayMs: number
  autoCloseFailedDelayMs: number
  autoCloseToolTerminals: boolean
  autoCloseNotice: 'failed' | 'all' | 'none'
  requireSandbox: boolean
  allowUnconfined: boolean
  portDetection: boolean
  shellPath: string | null
  [key: string]: unknown
}

/** `GET /config` response. */
export interface ConfigInfo {
  version: string
  config: PublicConfig
  sandbox: { mode: string; available?: boolean }
  shell: { kind?: string; path?: string | null }
}

/* ------------------------------------------------------------------ */
/* Global SSE notices                                                  */
/* ------------------------------------------------------------------ */

/** `notice` frame: a one-shot command terminal was auto-closed. */
export interface AutoCloseNotice {
  type: 'auto-close'
  reason: 'failed' | 'succeeded'
  terminalId: string
  /** Id of the history entry written for the closed terminal (1.2.1). */
  historyId?: string
  title: string
  exitCode?: number | null
  signal?: string | null
  /** Last non-empty output line, ANSI-stripped, ≤160 chars (host-truncated). */
  excerpt?: string
  durationMs?: number
}

/** `notice` frame: a command finished but its terminal stays open. */
export interface CommandFinishedNotice {
  type: 'command-finished'
  terminalId: string
  title: string
  exitCode: number | null
  signal: string | null
  durationMs: number | null
  keepOpen: boolean
}

/** `notice` frame: a new localhost URL was detected in the output. */
export interface PortNotice {
  type: 'port'
  terminalId: string
  url: string
  port: number
  host: string
}

/** `notice` frame: the agent requested a PNG capture from this client. */
export interface CaptureRequestNotice {
  type: 'capture-request'
  terminalId: string
  requestId: string
}

export type Notice =
  | AutoCloseNotice
  | CommandFinishedNotice
  | PortNotice
  | CaptureRequestNotice

/** Backwards-compatible alias (1.2.0 name). */
export type TerminalNotice = Notice

/* ------------------------------------------------------------------ */
/* Parsers                                                             */
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

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function firstRecord(...values: unknown[]): Record<string, unknown> | null {
  for (const value of values) {
    const record = asRecord(value)
    if (record) return record
  }
  return null
}

/** Parse a `SandboxInfo`; defaults to the historical “unconfined, not required” shape. */
export function parseSandboxInfo(value: unknown): SandboxInfo {
  const record = asRecord(value)
  const mode = readString(record?.mode) ?? 'danger-full-access'
  return {
    mode,
    confined: readBoolean(record?.confined) ?? mode !== 'danger-full-access',
    required: readBoolean(record?.required) ?? false,
  }
}

/** Parse one `PortInfo`; null when the URL is missing. */
export function parsePortInfo(value: unknown): PortInfo | null {
  const record = asRecord(value)
  if (!record) return null
  const url = readString(record.url)
  if (url === undefined || url === '') return null
  const firstSeenAt = readNumber(record.firstSeenAt) ?? 0
  return {
    url,
    port: readNumber(record.port) ?? 0,
    host: readString(record.host) ?? '',
    firstSeenAt,
    lastSeenAt: readNumber(record.lastSeenAt) ?? firstSeenAt,
  }
}

function parsePortList(value: unknown): PortInfo[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => parsePortInfo(item))
    .filter((item): item is PortInfo => item !== null)
}

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
  const createdAt = readNumber(record.createdAt) ?? 0
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
    createdAt,
    updatedAt: readNumber(record.updatedAt) ?? createdAt,
    signal: readString(record.signal) ?? null,
    startedAt: readNumber(record.startedAt) ?? createdAt,
    endedAt: readNumber(record.endedAt) ?? null,
    durationMs: readNumber(record.durationMs) ?? null,
    shellKind: readString(record.shellKind) ?? '',
    ports: parsePortList(record.ports),
    sandbox: parseSandboxInfo(record.sandbox),
    autoCloseAt: readNumber(record.autoCloseAt) ?? null,
    autoClosePaused: readBoolean(record.autoClosePaused) ?? false,
    pinned: readBoolean(record.pinned) ?? false,
  }
  const sessionId = readString(record.sessionId)
  if (sessionId !== undefined) info.sessionId = sessionId
  const agentId = readString(record.agentId)
  if (agentId !== undefined) info.agentId = agentId
  const command = readString(record.command)
  if (command !== undefined) info.command = command
  const error = readString(record.error)
  if (error !== undefined) info.error = error
  const writerClientId = readString(record.writerClientId)
  if (writerClientId !== undefined) info.writerClientId = writerClientId
  return info
}

/** Parse a partial session update; unknown ids are ignored by the panel. */
export function parseSessionPatch(value: unknown): SessionInfoPatch | null {
  const outer = asRecord(value)
  if (!outer) return null
  const record = firstRecord(outer.info, outer.session, outer.terminal) ?? outer
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
  if ('signal' in record) {
    patch.signal = readString(record.signal) ?? null
  }
  const startedAt = readNumber(record.startedAt)
  if (startedAt !== undefined) patch.startedAt = startedAt
  if ('endedAt' in record) {
    patch.endedAt = readNumber(record.endedAt) ?? null
  }
  if ('durationMs' in record) {
    patch.durationMs = readNumber(record.durationMs) ?? null
  }
  const shellKind = readString(record.shellKind)
  if (shellKind !== undefined) patch.shellKind = shellKind
  if (Array.isArray(record.ports)) patch.ports = parsePortList(record.ports)
  if ('sandbox' in record) patch.sandbox = parseSandboxInfo(record.sandbox)
  if ('autoCloseAt' in record) {
    patch.autoCloseAt = readNumber(record.autoCloseAt) ?? null
  }
  const autoClosePaused = readBoolean(record.autoClosePaused)
  if (autoClosePaused !== undefined) patch.autoClosePaused = autoClosePaused
  const pinned = readBoolean(record.pinned)
  if (pinned !== undefined) patch.pinned = pinned
  if ('writerClientId' in record) {
    patch.writerClientId = readString(record.writerClientId)
  }
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
  const writerClientId =
    readString(record.writerClientId) ?? readString(body.writerClientId)
  const snapshot: SnapshotFrame = { info: info ?? undefined, screen, text, cursor, seq }
  if (writerClientId !== undefined) snapshot.writerClientId = writerClientId
  return snapshot
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

/** Parse a `capture-request` frame (`{terminalId, requestId}` and aliases). */
export function parseCaptureRequest(value: unknown): CaptureRequestFrame | null {
  const record = asRecord(value)
  if (!record) return null
  const terminalId = readString(record.terminalId) ?? readString(record.id)
  const requestId = readString(record.requestId) ?? readString(record.request)
  if (terminalId === undefined || terminalId === '') return null
  if (requestId === undefined || requestId === '') return null
  return { terminalId, requestId }
}

/** Parse one `notice` frame of any 1.2.1 type (and the legacy 1.2.0 shape). */
export function parseNotice(value: unknown): Notice | null {
  const record = asRecord(value)
  if (!record) return null
  const type = readString(record.type)
  const terminalId = readString(record.terminalId) ?? readString(record.id)
  if (type === 'command-finished') {
    if (terminalId === undefined || terminalId === '') return null
    return {
      type,
      terminalId,
      title: readString(record.title) ?? terminalId,
      exitCode: typeof record.exitCode === 'number' ? record.exitCode : null,
      signal: readString(record.signal) ?? null,
      durationMs: readNumber(record.durationMs) ?? null,
      keepOpen: record.keepOpen === true,
    }
  }
  if (type === 'port') {
    if (terminalId === undefined || terminalId === '') return null
    const url = readString(record.url)
    if (url === undefined || url === '') return null
    return {
      type,
      terminalId,
      url,
      port: readNumber(record.port) ?? 0,
      host: readString(record.host) ?? '',
    }
  }
  if (type === 'capture-request') {
    const requestId = readString(record.requestId)
    if (terminalId === undefined || terminalId === '') return null
    if (requestId === undefined || requestId === '') return null
    return { type, terminalId, requestId }
  }
  // `auto-close` (legacy frames may omit `type` but always carry a reason).
  const reason =
    record.reason === 'failed' || record.reason === 'succeeded'
      ? record.reason
      : type === 'auto-close'
        ? 'succeeded'
        : undefined
  if (reason === undefined) return null
  if (terminalId === undefined || terminalId === '') return null
  const notice: AutoCloseNotice = {
    type: 'auto-close',
    reason,
    terminalId,
    title: readString(record.title) ?? terminalId,
  }
  if ('exitCode' in record) {
    notice.exitCode = typeof record.exitCode === 'number' ? record.exitCode : null
  }
  if (record.signal === null || typeof record.signal === 'string') {
    notice.signal = record.signal
  }
  const excerpt = readString(record.excerpt)
  if (excerpt !== undefined) notice.excerpt = excerpt
  const historyId = readString(record.historyId)
  if (historyId !== undefined) notice.historyId = historyId
  const durationMs = readNumber(record.durationMs)
  if (durationMs !== undefined) notice.durationMs = durationMs
  return notice
}

/** Parse a `HistoryEntry`; null when the record is unusable. */
export function parseHistoryEntry(value: unknown): HistoryEntry | null {
  const record = asRecord(value)
  if (!record) return null
  const id = readString(record.id) ?? readString(record.terminalId)
  if (id === undefined || id === '') return null
  const startedAt = readNumber(record.startedAt) ?? 0
  const endedAt = readNumber(record.endedAt) ?? startedAt
  const reason: HistoryReason =
    record.reason === 'closed' || record.reason === 'failed' ? record.reason : 'auto-close'
  const entry: HistoryEntry = {
    id,
    title: readString(record.title) ?? id,
    command: readString(record.command) ?? '',
    cwd: readString(record.cwd) ?? '',
    kind: 'command',
    exitCode: typeof record.exitCode === 'number' ? record.exitCode : null,
    signal: readString(record.signal) ?? null,
    startedAt,
    endedAt,
    durationMs: readNumber(record.durationMs) ?? Math.max(0, endedAt - startedAt),
    cols: Math.max(2, readNumber(record.cols) ?? 80),
    rows: Math.max(1, readNumber(record.rows) ?? 24),
    reason,
    text: readString(record.text) ?? '',
    truncated: record.truncated === true,
    ports: parsePortList(record.ports),
    sandbox: parseSandboxInfo(record.sandbox),
  }
  return entry
}

/** Parse a `GET /history` payload (`{entries}` or a bare array). */
export function parseHistoryPayload(value: unknown): HistoryEntry[] {
  const record = asRecord(value)
  const raw = Array.isArray(value)
    ? value
    : record && Array.isArray(record.entries)
      ? record.entries
      : record && Array.isArray(record.history)
        ? record.history
        : []
  return raw
    .map((item) => parseHistoryEntry(item))
    .filter((item): item is HistoryEntry => item !== null)
}

/** Parse a `GET /config` payload; returns null when the body is unusable. */
export function parseConfigInfo(value: unknown): ConfigInfo | null {
  const record = asRecord(value)
  if (!record) return null
  const config = asRecord(record.config)
  if (!config) return null
  const sandbox = asRecord(record.sandbox)
  const shell = asRecord(record.shell)
  const number = (key: string, fallback: number): number =>
    readNumber(config[key]) ?? fallback
  const bool = (key: string, fallback: boolean): boolean =>
    readBoolean(config[key]) ?? fallback
  return {
    version: readString(record.version) ?? '',
    config: {
      ...config,
      interceptShellTools: bool('interceptShellTools', true),
      scrollback: number('scrollback', 2000),
      maxOutputBytes: number('maxOutputBytes', 262144),
      maxSessions: number('maxSessions', 16),
      perSessionMaxSessions: number('perSessionMaxSessions', 8),
      commandTimeoutMs: number('commandTimeoutMs', 180000),
      retainExited: number('retainExited', 10),
      historySize: number('historySize', 20),
      historyPersist: bool('historyPersist', true),
      interceptMinVisibleMs: number('interceptMinVisibleMs', 1500),
      autoCloseCommandDelayMs: number('autoCloseCommandDelayMs', 8000),
      autoCloseFailedDelayMs: number('autoCloseFailedDelayMs', 30000),
      autoCloseToolTerminals: bool('autoCloseToolTerminals', true),
      autoCloseNotice:
        config.autoCloseNotice === 'all' || config.autoCloseNotice === 'none'
          ? config.autoCloseNotice
          : 'failed',
      requireSandbox: bool('requireSandbox', false),
      allowUnconfined: bool('allowUnconfined', true),
      portDetection: bool('portDetection', true),
      shellPath: readString(config.shellPath) ?? null,
    },
    sandbox: {
      mode: readString(sandbox?.mode) ?? 'danger-full-access',
      available: readBoolean(sandbox?.available),
    },
    shell: {
      kind: readString(shell?.kind),
      path: readString(shell?.path) ?? readString(config.shellPath) ?? null,
    },
  }
}

/** Narrow a patch to a full `SessionInfo` (used before inserting unknowns). */
export function isFullSessionInfo(value: SessionInfo | SessionInfoPatch): value is SessionInfo {
  const candidate = value as Partial<SessionInfo>
  return (
    typeof candidate.title === 'string' &&
    (candidate.kind === 'command' || candidate.kind === 'interactive') &&
    typeof candidate.cwd === 'string' &&
    typeof candidate.cols === 'number' &&
    typeof candidate.rows === 'number' &&
    (candidate.state === 'running' || candidate.state === 'exited' || candidate.state === 'failed')
  )
}

/** Drop `undefined` entries so a patch can never erase known fields. */
export function stripUndefined(patch: SessionInfoPatch): SessionInfoPatch {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) result[key] = value
  }
  return result as SessionInfoPatch
}
