/**
 * Wire types shared with the host half.
 *
 * The canonical shape is documented in docs/architecture.md §4.4/§5.2. The
 * client deliberately parses its input defensively: the host routes are built
 * in parallel, so every parser accepts both the contracted shape and a few
 * plausible aliases (`data` / `chunk`, `info` / `session`, …) and never throws
 * on a frame it does not recognize.
 */

export type SessionKind = 'command' | 'interactive'
export type SessionOwner = 'agent' | 'user'
export type SessionState = 'running' | 'exited' | 'failed'

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

/**
 * Global `notice` SSE event (e.g. the host auto-closed a command terminal).
 *
 * Protocol: `{ type: 'auto-close', reason: 'failed' | 'succeeded',
 * terminalId, title, exitCode, signal, excerpt }`. `exitCode`, `signal` and
 * `excerpt` are optional — clients must not assume they are present.
 */
export interface TerminalNotice {
  type: 'auto-close'
  reason: 'failed' | 'succeeded'
  terminalId: string
  /** Display title resolved by the host; the parser falls back to the id. */
  title: string
  exitCode?: number | null
  signal?: string | null
  /** Last non-empty output line, ANSI-stripped, ≤160 chars (host-truncated). */
  excerpt?: string
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
