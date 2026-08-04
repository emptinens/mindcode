/**
 * Persistent local PTY session manager.
 *
 * A `Tool.call()` is request/response, but a real terminal is a long-lived
 * stream. This module bridges the gap: it holds PTY processes in a
 * module-level singleton that outlives individual tool calls, and exposes a
 * poll-based interface (`write` then `read`) that maps onto how a turn-based
 * AI consumes tools.
 *
 * The `read` is "smart-blocking": it waits until output goes quiet
 * (settle window) or until a regex matches (expect-style), then returns the
 * bytes accumulated since the last read. Output is kept in a bounded ring
 * buffer so a runaway process can't exhaust memory.
 */
import { randomUUID } from 'node:crypto'
import { type PtyHandle, spawnPty } from './ptyBackend.js'

/** Max bytes retained per session. Oldest output is dropped past this. */
const MAX_BUFFER_BYTES = 256 * 1024
/** Default idle window (ms) that `read` waits for output to settle. */
const DEFAULT_SETTLE_MS = 300
/** Default hard cap (ms) on a single `read` before it returns what it has. */
const DEFAULT_READ_TIMEOUT_MS = 10_000
/** Poll granularity for the read loop. */
const READ_POLL_MS = 50

export type PtyStatus = 'running' | 'exited'

export type PtySessionInfo = {
  sessionId: string
  pid: number
  shell: string
  cwd: string
  cols: number
  rows: number
  status: PtyStatus
  exitCode: number | null
  createdAt: number
  /** Bytes currently buffered and unread. */
  pendingBytes: number
}

type PtySession = {
  id: string
  pty: PtyHandle
  shell: string
  cwd: string
  cols: number
  rows: number
  createdAt: number
  status: PtyStatus
  exitCode: number | null
  /** Accumulated unread output. */
  buffer: string
  /** True once the buffer has been truncated (oldest bytes dropped). */
  truncated: boolean
  /**
   * On Windows/ConPTY the pty pipe isn't writable immediately after spawn —
   * an early write throws ERR_SOCKET_CLOSED. We gate writes on readiness
   * (first data event or a short fallback timer) and queue anything sent
   * before then, flushing once ready.
   */
  ready: boolean
  pendingWrites: string[]
}

/** ms to wait before force-marking a session ready if no data has arrived. */
const READY_FALLBACK_MS = 500

export type OpenPtyOptions = {
  /** Caller-supplied session id (a short human-readable name). Must be unique. */
  id?: string
  shell?: string
  cwd?: string
  env?: Record<string, string | undefined>
  cols?: number
  rows?: number
}

export type ReadPtyOptions = {
  /** Idle window in ms — return once no new output arrives for this long. */
  settleMs?: number
  /** Hard cap in ms on the whole read. */
  timeoutMs?: number
  /** Return as soon as buffered output matches this regex source string. */
  until?: string
  /** Flags for the `until` regex. Defaults to no flags. */
  untilFlags?: string
}

export type ReadPtyResult = {
  output: string
  /** True if `until` matched (or if the session had a pattern to match). */
  matched: boolean
  /** True if the read returned because it hit its timeout. */
  timedOut: boolean
  /** True if buffered output was dropped due to the size cap before this read. */
  truncated: boolean
  status: PtyStatus
  exitCode: number | null
}

const sessions = new Map<string, PtySession>()
let exitHandlerRegistered = false

function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.ComSpec || 'cmd.exe'
  }
  return process.env.SHELL || '/bin/bash'
}

function registerExitHandler(): void {
  if (exitHandlerRegistered) return
  exitHandlerRegistered = true
  const killAll = () => {
    for (const session of sessions.values()) {
      try {
        session.pty.kill()
      } catch {
        // best effort — process may already be gone
      }
    }
    sessions.clear()
  }
  process.once('exit', killAll)
  process.once('SIGINT', killAll)
  process.once('SIGTERM', killAll)
}

function markReady(session: PtySession): void {
  if (session.ready) return
  session.ready = true
  const queued = session.pendingWrites
  session.pendingWrites = []
  for (const data of queued) {
    try {
      session.pty.write(data)
    } catch {
      // session may have exited between queueing and flush
    }
  }
}

function appendToBuffer(session: PtySession, chunk: string): void {
  session.buffer += chunk
  if (session.buffer.length > MAX_BUFFER_BYTES) {
    session.buffer = session.buffer.slice(-MAX_BUFFER_BYTES)
    session.truncated = true
  }
}

function toInfo(session: PtySession): PtySessionInfo {
  return {
    sessionId: session.id,
    pid: session.pty.pid,
    shell: session.shell,
    cwd: session.cwd,
    cols: session.cols,
    rows: session.rows,
    status: session.status,
    exitCode: session.exitCode,
    createdAt: session.createdAt,
    pendingBytes: session.buffer.length,
  }
}

function getSessionOrThrow(sessionId: string): PtySession {
  const session = sessions.get(sessionId)
  if (!session) {
    throw new Error(
      `No PTY session with id "${sessionId}". Use action "open" first, or "list" to see active sessions.`,
    )
  }
  return session
}

/** Spawn a new persistent PTY and return its info. */
export async function openPtySession(
  options: OpenPtyOptions = {},
): Promise<PtySessionInfo> {
  registerExitHandler()

  // Prefer a caller-supplied id (a short human-readable name) so the UI and
  // later calls reference "build" instead of a UUID. Fall back to a UUID only
  // if none was given. Collision-check before spawning so we don't leak a
  // process when the name is already taken.
  const id = options.id ?? randomUUID()
  if (options.id && sessions.has(options.id)) {
    throw new Error(
      `A terminal session named "${options.id}" already exists. Pick a different name or close the existing one.`,
    )
  }

  const shell = options.shell || defaultShell()
  const cwd = options.cwd || process.cwd()
  const cols = options.cols ?? 120
  const rows = options.rows ?? 30
  const env = { ...process.env, ...options.env } as Record<string, string>

  const pty = await spawnPty(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env,
  })
  const session: PtySession = {
    id,
    pty,
    shell,
    cwd,
    cols,
    rows,
    createdAt: Date.now(),
    status: 'running',
    exitCode: null,
    buffer: '',
    truncated: false,
    ready: false,
    pendingWrites: [],
  }

  pty.onData(chunk => {
    appendToBuffer(session, chunk)
    // First byte out means the pipe is live — safe to write now.
    if (!session.ready) markReady(session)
  })
  pty.onExit(({ exitCode }) => {
    session.status = 'exited'
    session.exitCode = exitCode
  })

  // Fallback: some shells emit no banner; mark ready after a short delay so
  // writes aren't queued forever.
  setTimeout(() => markReady(session), READY_FALLBACK_MS)

  sessions.set(id, session)
  return toInfo(session)
}

/**
 * Windows cmd.exe/ConPTY only treats a carriage return as "Enter" — a lone "\n"
 * is inserted into the line buffer but never submits the command. The model
 * naturally sends "\n", so on Windows we normalize any "\n" (and existing
 * "\r\n") to "\r\n". The `\r?\n` pattern avoids turning "\r\n" into "\r\r\n".
 * Left untouched on POSIX, where "\n" is the correct line terminator.
 */
function normalizeNewlines(data: string): string {
  if (process.platform !== 'win32') return data
  return data.replace(/\r?\n/g, '\r\n')
}

/** Write raw data to a session (append your own "\n" / control chars). */
export function writePtySession(sessionId: string, data: string): PtySessionInfo {
  const session = getSessionOrThrow(sessionId)
  if (session.status === 'exited') {
    throw new Error(
      `PTY session "${sessionId}" has exited (code ${session.exitCode}). Open a new session.`,
    )
  }
  const normalized = normalizeNewlines(data)
  if (!session.ready) {
    // ConPTY pipe not connected yet — queue and flush on markReady.
    session.pendingWrites.push(normalized)
  } else {
    session.pty.write(normalized)
  }
  return toInfo(session)
}

/**
 * Smart-blocking read: drains output accumulated since the last read, waiting
 * for the stream to settle or for `until` to match, bounded by a timeout.
 */
export async function readPtySession(
  sessionId: string,
  options: ReadPtyOptions = {},
): Promise<ReadPtyResult> {
  const session = getSessionOrThrow(sessionId)
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS
  const untilRe = options.until
    ? new RegExp(options.until, options.untilFlags)
    : null

  const startedAt = Date.now()
  let lastLen = session.buffer.length
  let lastChangeAt = Date.now()

  while (true) {
    const matched = untilRe ? untilRe.test(session.buffer) : false
    const timedOut = Date.now() - startedAt >= timeoutMs
    const idleEnough = Date.now() - lastChangeAt >= settleMs
    const exited = session.status === 'exited'

    // Return conditions: pattern matched, process exited, hit timeout, or
    // output has been idle for the settle window (only once we have data or
    // the settle window has fully elapsed from the start).
    if (matched || exited || timedOut || (idleEnough && !untilRe)) {
      const output = session.buffer
      const truncated = session.truncated
      session.buffer = ''
      session.truncated = false
      return {
        output,
        matched,
        timedOut: timedOut && !matched && !exited,
        truncated,
        status: session.status,
        exitCode: session.exitCode,
      }
    }

    await new Promise(resolve => setTimeout(resolve, READ_POLL_MS))

    if (session.buffer.length !== lastLen) {
      lastLen = session.buffer.length
      lastChangeAt = Date.now()
    }
  }
}

/** Resize the PTY (cols x rows). */
export function resizePtySession(
  sessionId: string,
  cols: number,
  rows: number,
): PtySessionInfo {
  const session = getSessionOrThrow(sessionId)
  if (session.status === 'running') {
    session.pty.resize(cols, rows)
    session.cols = cols
    session.rows = rows
  }
  return toInfo(session)
}

/** Kill and forget a session. Returns false if it didn't exist. */
export function closePtySession(sessionId: string): boolean {
  const session = sessions.get(sessionId)
  if (!session) return false
  try {
    session.pty.kill()
  } catch {
    // already dead
  }
  sessions.delete(sessionId)
  return true
}

/** List all known sessions (running and recently exited). */
export function listPtySessions(): PtySessionInfo[] {
  return Array.from(sessions.values()).map(toInfo)
}

/** Test-only / shutdown helper. */
export function killAllPtySessions(): void {
  for (const id of Array.from(sessions.keys())) {
    closePtySession(id)
  }
}
